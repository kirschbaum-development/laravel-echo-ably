import type { ErrorInfo, Realtime, TokenDetails } from "ably";
import type { AblyDriverOptions, TokenResponse } from "../types";
import { isGuarded } from "../util/channel-name";
import type { ParsedJwt } from "./jwt";
import { parseJwt, toTokenDetails } from "./jwt";

/**
 * A token this close to expiry is treated as already expired: attaching with it
 * would race the server's own expiry check.
 */
const EXPIRY_WINDOW_MS = 30_000;

/** What ably is told when there is no token and no way to ask for one. */
const NO_TOKEN =
    "No Ably token available yet: subscribe to a channel before authenticating.";

/** The slice of Echo's options the manager needs to reach `/broadcasting/auth`. */
export type TokenManagerEchoOptions = {
    authEndpoint: string;
    auth: { headers: Record<string, string> };
};

/**
 * Owns the broadcaster JWT: decides when the cached token already covers a
 * channel, requests upgrades when it does not, and keeps those requests
 * serialized so each one accretes onto the previous token's capability.
 */
export class TokenManager {
    private readonly echoOptions: TokenManagerEchoOptions;
    private readonly driverOptions: AblyDriverOptions;

    private token: string | null = null;
    private parsed: ParsedJwt | null = null;
    private client: Realtime | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private info = new Map<string, unknown>();
    /** Bumped by `reset()`; requests started under an older value are stale. */
    private generation = 0;

    /**
     * The last guarded channel a token was actually granted for, and so the
     * channel a renewal asks about: the server accretes each grant onto the
     * token it is handed, so asking for the most recent one comes back with
     * everything the expiring token carried. Survives `reset()` — it describes
     * what this app subscribes to, not which session held the token.
     */
    private lastGrantedChannel: string | null = null;

    constructor(
        echoOptions: TokenManagerEchoOptions,
        driverOptions: AblyDriverOptions,
    ) {
        this.echoOptions = echoOptions;
        this.driverOptions = driverOptions;
    }

    /** The live connection to re-authorize whenever a new token arrives. */
    setClient(client: Realtime): void {
        this.client = client;
    }

    currentToken(): string | null {
        return this.token;
    }

    /** The `info` payload the auth response carried for a presence channel. */
    presenceInfo(channelName: string): unknown {
        return this.info.get(channelName);
    }

    /** Drop the cached token (40102 recovery / logout) so the next call refetches. */
    reset(): void {
        this.token = null;
        this.parsed = null;
        // The presence payloads belong to the identity that just went away:
        // keeping them would enter the next member under the old one's data.
        this.info.clear();
        this.generation += 1;
    }

    /**
     * Resolve once the current token covers `channelName`, requesting or
     * upgrading it otherwise. `force` skips the cache check entirely, which is
     * how a 40160 capability rejection is recovered from.
     */
    ensureCapability(
        channelName: string,
        opts: { force?: boolean } = {},
    ): Promise<void> {
        if (!isGuarded(channelName)) {
            return Promise.resolve();
        }

        return this.grant(channelName, { force: opts.force, push: true });
    }

    /**
     * Queue a token request for `channelName` and apply what comes back.
     *
     * `push` decides whether the new token is also handed to the live
     * connection: every caller but the auth callback needs that, and the auth
     * callback does not, because ably-js applies whatever that callback
     * resolves with.
     */
    private grant(
        channelName: string,
        opts: { force?: boolean; push: boolean },
    ): Promise<void> {
        // Requests queue behind one another: the server accretes capability onto
        // the token it is handed, so overlapping requests would each drop the
        // other's grants.
        const run = this.queue.then(async () => {
            if (!opts.force && this.covers(channelName)) {
                return;
            }

            // Captured as the request goes out, not when it was queued: a
            // request still waiting its turn should start fresh under the
            // current session rather than be discarded with it.
            const generation = this.generation;
            const response = await this.requestToken(channelName);
            // Parse before storing: a malformed token must leave the previous
            // one in place rather than half-replace it.
            const parsed = parseJwt(response.token);

            // A reset() landed while this was in flight (logout, 40102): the
            // reply belongs to the old session, so it is neither cached nor
            // pushed onto the connection.
            if (generation !== this.generation) {
                return;
            }

            this.token = response.token;
            this.parsed = parsed;
            this.lastGrantedChannel = channelName;

            if (response.info !== undefined) {
                this.info.set(channelName, response.info);
            }

            if (opts.push && this.client) {
                await this.client.auth.authorize(undefined, {
                    token: response.token,
                    // Carried deliberately: ably *replaces* its stored auth
                    // options with whatever it is handed here rather than
                    // merging them, so a push without this would unregister
                    // the callback and leave the client with no way to request
                    // its next token (40171) — taking renewal with it.
                    authCallback: this.authCallback,
                });
            }
        });

        // The queue tracks completion, not success: a failed request must not
        // poison the chain for everyone waiting behind it.
        this.queue = run.catch(() => undefined);

        return run;
    }

    /**
     * ably-js v2 auth callback; wire into `ClientOptions.authCallback`. Bound as
     * a field because ably-js calls it detached from the manager, and typed to
     * stay assignable to `ClientOptions["authCallback"]` — hence the error
     * union ably declares, which is why the failure reason is a plain string
     * rather than an `Error`.
     *
     * ably-js calls this whenever the connection needs a credential, including
     * shortly before the current one expires — which is the only thing keeping
     * an idle, listen-only connection alive, since nothing else there asks for
     * capability again.
     */
    authCallback = (
        _tokenParams: unknown,
        callback: (
            error: ErrorInfo | string | null,
            tokenDetails: TokenDetails | null,
        ) => void,
    ): void => {
        if (this.token && !this.expiresSoon()) {
            callback(null, toTokenDetails(this.token));

            return;
        }

        // Nothing guarded was ever subscribed to, so there is no channel to ask
        // `/broadcasting/auth` about. A connection that only ever uses public
        // channels needs a credential of its own (tracking issue #4).
        if (!this.lastGrantedChannel) {
            callback(NO_TOKEN, null);

            return;
        }

        void this.renew(this.lastGrantedChannel, callback);
    };

    /**
     * Fetch a replacement for the expiring token and hand it straight to ably,
     * which applies whatever an auth callback resolves with — so this deliberately
     * does not push it onto the connection a second time.
     */
    private async renew(
        channelName: string,
        callback: (
            error: ErrorInfo | string | null,
            tokenDetails: TokenDetails | null,
        ) => void,
    ): Promise<void> {
        try {
            await this.grant(channelName, { push: false });
        } catch (error) {
            // ably's callback signature takes `ErrorInfo | string`, and an
            // `Error` is in neither, so the reason travels as its message.
            callback(
                error instanceof Error ? error.message : String(error),
                null,
            );

            return;
        }

        // A reset() landing mid-renewal discards the reply, and a token that
        // never arrived is not one to authenticate with.
        if (!this.token) {
            callback(NO_TOKEN, null);

            return;
        }

        callback(null, toTokenDetails(this.token));
    }

    /** Is the cached token gone, or too close to expiry to be worth offering? */
    private expiresSoon(): boolean {
        // A token with no `exp` claim parses to `expires: 0`, so it lands here
        // and is never trusted.
        return (
            !this.parsed || this.parsed.expires - Date.now() < EXPIRY_WINDOW_MS
        );
    }

    /** Does the cached token grant `channelName` for long enough to use? */
    private covers(channelName: string): boolean {
        if (!this.token || !this.parsed) {
            return false;
        }

        if (this.expiresSoon()) {
            return false;
        }

        const capability = this.parsed.capability;

        if (capability[channelName] || capability["*"]) {
            return true;
        }

        const namespace = channelName.split(":")[0];

        return Boolean(capability[`${namespace}:*`]);
    }

    private async requestToken(channelName: string): Promise<TokenResponse> {
        const { requestTokenFn } = this.driverOptions;

        if (requestTokenFn) {
            return requestTokenFn(channelName, this.token);
        }

        const response = await fetch(this.echoOptions.authEndpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...this.echoOptions.auth.headers,
            },
            body: JSON.stringify({
                channel_name: channelName,
                token: this.token,
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Auth request failed with status ${response.status}`,
            );
        }

        return (await response.json()) as TokenResponse;
    }
}
