import type {
    ClientOptions,
    ConnectionState,
    ConnectionStateChange,
} from "ably";
import { Realtime } from "ably";
import type { ConnectionStatus } from "laravel-echo";
import { Connector } from "laravel-echo";
import { TokenManager } from "./auth/token-manager";
import { AblyChannel } from "./channels/ably-channel";
import { AblyPresenceChannel } from "./channels/ably-presence-channel";
import { AblyPrivateChannel } from "./channels/ably-private-channel";
import { normalizeReplay } from "./replay/replay-engine";
import type { NormalizedReplay } from "./replay/types";
import type { AblyDriverOptions, EchoOptionsWithDefaults } from "./types";
import {
    baseName,
    normalize,
    toPresence,
    toPrivate,
    toPublic,
} from "./util/channel-name";
import { VERSION } from "./version";

/**
 * Ably's "the connection's clientId does not match the token's" error code —
 * what a login or a logout looks like from the connection's side.
 */
const CLIENT_ID_MISMATCH = 40102;

/**
 * ably-js reads `agents` when it builds its `Ably-Agent` header but leaves the
 * option out of its public `ClientOptions` type, so it is added back here.
 */
type ClientOptionsWithAgents = ClientOptions & {
    agents?: Record<string, string>;
};

/** Every channel class in this driver shares one constructor signature. */
type ChannelConstructor<TChannel extends AblyChannel> = new (
    ably: Realtime,
    name: string,
    options: EchoOptionsWithDefaults,
    tokenManager: TokenManager,
    replay: NormalizedReplay,
) => TChannel;

/** Ably's connection states, in Echo's connection-status vocabulary. */
const CONNECTION_STATUS: Record<ConnectionState, ConnectionStatus> = {
    initialized: "connecting",
    connecting: "connecting",
    connected: "connected",
    // ably retries both of these on its own, which is what Echo calls
    // reconnecting; the difference between them is only how long it has been.
    disconnected: "reconnecting",
    suspended: "reconnecting",
    // Closing and closed are both "you asked for this", unlike failed.
    closing: "disconnected",
    closed: "disconnected",
    failed: "failed",
};

/**
 * Echo's connector for Ably, driving ably-js v2 directly.
 *
 * It owns the client, the token manager every channel authorizes through, and
 * the channel cache Echo's `leaveAllChannels()` walks — keyed by the resolved
 * Ably name (`private:orders`), which is also the name the auth endpoint
 * grants capability for.
 */
export class AblyConnector extends Connector<
    // Echo keys this parameter to its own map of built-in drivers, which a
    // third-party broadcaster is by definition not in. `any` is the loosest
    // instantiation that satisfies the constraint, and matches the `function`
    // slot Echo routes constructor-broadcasters through.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    AblyChannel,
    AblyPrivateChannel,
    AblyPresenceChannel
> {
    /** The Ably client: the one that was injected, or the one built here. */
    ably!: Realtime;

    /**
     * The channels in use, keyed by resolved Ably name.
     *
     * Initialized after `connect()` runs — the base constructor calls it
     * before this class's field initializers — so `connect()` must not put
     * anything here.
     */
    channels: Record<string, AblyChannel> = {};

    /**
     * The broadcaster JWT this connection authorizes with. Public because an
     * app that changes identity outside a reconnect (a logout, say) needs a
     * way to drop the token that named the old user.
     */
    tokenManager!: TokenManager;

    /**
     * Whether this connection cycle already spent its 40102 recovery. A
     * mismatch that survives the recovery will survive it again, and retrying
     * would be an unbounded connect → fail → re-auth loop against
     * `/broadcasting/auth`. Cleared by a successful connection, so a later,
     * unrelated identity change gets a recovery of its own.
     */
    private recoverySpent = false;

    /**
     * Removes the listeners `bindConnection` put on the current client.
     *
     * Assigned by `connect()`, which the base constructor calls before this
     * class's field initializers run — so it carries no initializer of its own
     * to overwrite it with.
     */
    private unbindConnection!: () => void;

    /**
     * How every channel on this connection replays missed events, normalized
     * once here. Assigned by `connect()`, which the base constructor calls
     * before this class's field initializers run — so it carries no initializer
     * of its own to overwrite it with.
     */
    private replayConfig!: NormalizedReplay;

    /**
     * Create a fresh Ably connection.
     */
    connect(): void {
        // Re-entry: `Echo.connect()` after a `disconnect()`, most commonly a
        // logout/login cycle or a tab putting realtime to sleep. Everything is
        // already built, so the connection only has to come back and the
        // channels the app still holds have to be re-attached onto it.
        //
        // Rebuilding here instead would hand the connector a second client and
        // leave every channel already handed out bound to the closed one —
        // `channels` still caches them, so `Echo.private('orders')` would return
        // a dead subscription and nothing would report that it had gone quiet.
        if (this.ably) {
            this.reopen();

            return;
        }

        const driverOptions: AblyDriverOptions = this.options.ably ?? {};

        // Built from the merged options, not the ones handed to the
        // constructor: the CSRF and bearer headers the auth request needs are
        // injected during that merge.
        this.tokenManager = new TokenManager(this.options, driverOptions);
        this.replayConfig = normalizeReplay(driverOptions.replay);
        this.ably = driverOptions.client ?? this.createClient(driverOptions);
        this.tokenManager.setClient(this.ably);
        this.bindConnection(this.ably);
    }

    private bindConnection(client: Realtime): void {
        const onConnected = () => {
            // A working connection closes the recovery cycle: whatever comes
            // after it is a new problem, not the old one still failing.
            this.recoverySpent = false;
        };

        const onFailed = (change: ConnectionStateChange) => {
            this.recoverFromClientIdMismatch(change);
        };

        client.connection.on("connected", onConnected);
        client.connection.on("failed", onFailed);

        // Kept so a replacement can stop listening to the client it replaced:
        // that client is nobody's connection afterwards, and anything it still
        // reports would drive a connector that has moved on.
        this.unbindConnection = () => {
            client.connection.off(onConnected);
            client.connection.off(onFailed);
        };
    }

    /**
     * Bring a closed connection back, with the channels that were on it.
     *
     * The client, the token manager and the connection listeners all survive a
     * `disconnect()`, so none of them is rebuilt: a cached token that still
     * covers its channels carries straight over, and re-registering the
     * listeners would double every 40102 recovery.
     */
    private reopen(): void {
        // A new connection cycle gets a new recovery budget.
        this.recoverySpent = false;

        this.ably.connect();

        Object.values(this.channels).forEach((channel) => {
            // `subscribe()` reports its own failures through the channel's
            // `error()` callbacks and never rejects, so there is nothing here
            // to await or catch.
            void channel.subscribe();
        });
    }

    /**
     * Get a channel instance by name.
     */
    channel(name: string): AblyChannel {
        return this.resolveChannel(toPublic(name), AblyChannel);
    }

    /**
     * Get a private channel instance by name.
     */
    privateChannel(name: string): AblyPrivateChannel {
        return this.resolveChannel(toPrivate(name), AblyPrivateChannel);
    }

    /**
     * Get a presence channel instance by name.
     */
    presenceChannel(name: string): AblyPresenceChannel {
        return this.resolveChannel(toPresence(name), AblyPresenceChannel);
    }

    /**
     * Listen for an event on a channel instance.
     *
     * Not part of the abstract contract, but Echo's own `listen()` delegates
     * straight to it, so a connector without it makes `echo.listen(...)` throw.
     * Public-channel semantics, matching every other connector.
     */
    listen(
        name: string,
        event: string,
        callback: CallableFunction,
    ): AblyChannel {
        return this.channel(name).listen(event, callback);
    }

    /**
     * Leave the given channel, as well as its private and presence variants.
     */
    leave(name: string): void {
        this.leaveAll(this.variantsOf(baseName(name)));
    }

    /**
     * Leave the given channel.
     *
     * Echo-style (`private-orders`), Ably-style (`private:orders`) and bare
     * (`orders`) names are all accepted. A bare name identifies no single Ably
     * channel — every channel here is namespaced — so it is read as a base
     * name and every cached variant of it is left; a prefixed name resolves to
     * exactly one channel.
     */
    leaveChannel(name: string): void {
        const isBare = baseName(name) === name;

        this.leaveAll(isBare ? this.variantsOf(name) : [normalize(name)]);
    }

    /**
     * Get the socket id of the connection.
     *
     * `toOthers()` matches against the connection key and the client id
     * together, which is the composite `ably/laravel-broadcaster` decodes on
     * the server. There is no key until the connection has been established.
     */
    socketId(): string | undefined {
        const connectionKey = this.ably.connection.key;

        if (!connectionKey) {
            return undefined;
        }

        return base64Url(
            JSON.stringify({
                connectionKey,
                // ably declares `clientId` as a plain string but leaves it
                // unset for an anonymous connection, and its own docs say to
                // guard against that.
                clientId: this.ably.auth.clientId ?? null,
            }),
        );
    }

    /**
     * Get the current connection status.
     */
    connectionStatus(): ConnectionStatus {
        return CONNECTION_STATUS[this.ably.connection.state];
    }

    /**
     * Subscribe to connection status changes.
     */
    onConnectionChange(
        callback: (status: ConnectionStatus) => void,
    ): () => void {
        const listener = (change: ConnectionStateChange) => {
            // Mapped from the change rather than re-read off the connection,
            // so the callback describes the transition it was handed.
            callback(CONNECTION_STATUS[change.current]);
        };

        this.ably.connection.on(listener);

        return () => this.ably.connection.off(listener);
    }

    /**
     * Subscribe to ably's own connection state changes, unmapped.
     *
     * `onConnectionChange` answers Echo's contract, which has four statuses
     * where ably has eight and no room at all for the `reason` — so a 42913 on
     * `[meta]connection.lifecycle`, or the 80019 behind a failed auth, arrives
     * there as a bare `"reconnecting"`. This is the same feed with everything
     * ably attached to it left on: state, previous state, `reason.code`,
     * `reason.statusCode`.
     *
     * Returns an unsubscriber, like `onConnectionChange` does.
     */
    onConnectionStateChange(
        callback: (change: ConnectionStateChange) => void,
    ): () => void {
        const listener = (change: ConnectionStateChange) => callback(change);

        this.ably.connection.on(listener);

        return () => this.ably.connection.off(listener);
    }

    /**
     * Disconnect from the Echo server.
     *
     * Closes the client this connector is driving — including one the
     * application injected through `ably.client`, which is deliberate: Echo's
     * contract is that `disconnect()` ends the connection, and a connector that
     * quietly left a socket open would leak one per Echo instance. An app that
     * wants to keep an injected client alive past `Echo.disconnect()` should
     * hold its own reference and reconnect it.
     */
    disconnect(): void {
        this.ably.close();
    }

    /**
     * Build the Ably client from the driver's defaults and the user's
     * overrides.
     */
    private createClient(driverOptions: AblyDriverOptions): Realtime {
        const options: ClientOptionsWithAgents = {
            // The only credential this driver has is the broadcaster JWT.
            useTokenAuth: true,
            // Token expiry is judged against Ably's clock rather than the
            // browser's, which may be minutes out.
            queryTime: true,
            // Echo's contract is that a publisher does not hear itself.
            echoMessages: false,
            agents: { "laravel-echo-ably": VERSION },
            ...driverOptions.clientOptions,
            // Deliberately last: the capability lifecycle (upgrades, 40160
            // retries, the recovery below) all runs through this callback, and
            // a replacement would quietly cut it out. An app with its own auth
            // story supplies a fully built `client` instead.
            authCallback: this.tokenManager.authCallback,
        };

        return new Realtime(options);
    }

    /**
     * The cached channel for a resolved Ably name, created on first use.
     */
    private resolveChannel<TChannel extends AblyChannel>(
        name: string,
        Channel: ChannelConstructor<TChannel>,
    ): TChannel {
        if (!this.channels[name]) {
            this.channels[name] = new Channel(
                this.ably,
                name,
                this.options,
                this.tokenManager,
                this.replayConfig,
            );
        }

        // Sound because the prefix that keys the cache is the same thing that
        // decides which class built the entry: one name, one channel class.
        return this.channels[name] as TChannel;
    }

    /** The three Ably names a base name can appear under. */
    private variantsOf(base: string): string[] {
        return [toPublic(base), toPrivate(base), toPresence(base)];
    }

    /** Unsubscribe and forget each of the given resolved names that is in use. */
    private leaveAll(names: string[]): void {
        names.forEach((name) => {
            const channel = this.channels[name];

            if (!channel) {
                return;
            }

            channel.unsubscribe();

            delete this.channels[name];

            // The manager rebuilds capability channel by channel on renewal,
            // so a name it still tracks outlives the subscription that needed
            // it: a request that can only fail once the user is no longer
            // authorized for the channel, taking the renewal with it.
            this.tokenManager.untrackChannel(name);
        });
    }

    /**
     * Recover from Ably 40102: the connection's clientId no longer matches the
     * token's, which is what a login or a logout looks like from here. The
     * token that named the old identity is dropped, the connection reopened,
     * and every live channel re-subscribed under the identity the next token
     * carries.
     *
     * Once per connection cycle, the same way a private channel spends one
     * silent retry on a capability rejection: a mismatch that comes straight
     * back is left to stand as a failed connection, which is what
     * `connectionStatus()` and `onConnectionChange` subscribers report.
     */
    private recoverFromClientIdMismatch(change: ConnectionStateChange): void {
        if (change.reason?.code !== CLIENT_ID_MISMATCH || this.recoverySpent) {
            return;
        }

        this.recoverySpent = true;

        this.tokenManager.reset();
        const driverOptions: AblyDriverOptions = this.options.ably ?? {};
        if (driverOptions.client && !driverOptions.clientFactory) {
            this.ably.connect();
            Object.values(this.channels).forEach(
                (channel) => void channel.subscribe(),
            );
            return;
        }
        const previous = this.ably;
        const replacement = driverOptions.clientFactory
            ? driverOptions.clientFactory()
            : this.createClient(driverOptions);

        this.tokenManager.trackChannels(Object.keys(this.channels));
        // Before the replacement is adopted: the outgoing client keeps the
        // clientId ably rejected, and a 40102 it reported from here would
        // otherwise ask for a replacement of the replacement.
        this.unbindConnection();
        this.ably = replacement;
        this.tokenManager.setClient(replacement);
        this.bindConnection(replacement);

        Object.values(this.channels).forEach((channel) => {
            // `subscribe()` reports its own failures through the channel's
            // `error()` callbacks and never rejects, so there is nothing here
            // to await or catch.
            //
            // Caveat inherited from the channel: the latch that stops one
            // failure being reported twice is per subscribe attempt, so an
            // unrelated state change arriving while this re-subscribe waits on
            // its token can mask a state-less attach rejection.
            channel.replaceClient(replacement, this.tokenManager);
        });

        // The client that was replaced is finished, and closing it is the
        // whole point of replacing it: it still carries the clientId ably
        // rejected, so a client left open here is a second connection — billed
        // and counted against the connection limit — that fails the same way
        // and, once the replacement's `connected` re-arms the budget, asks for
        // a replacement of its own.
        previous.close();
        replacement.connect();
    }
}

/**
 * base64url, browser-first: `btoa` over the UTF-8 bytes, so a non-ASCII client
 * id survives, then the URL-safe alphabet with the padding stripped. No
 * `Buffer` — this package targets the browser.
 */
function base64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
