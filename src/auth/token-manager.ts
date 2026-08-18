import type { ErrorInfo, Realtime, TokenDetails } from "ably";
import type { AblyDriverOptions, TokenResponse } from "../types";
import { isGuarded } from "../util/channel-name";
import type { ParsedJwt } from "./jwt";
import { parseJwt, toTokenDetails } from "./jwt";

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
    /** Guarded channels this manager must keep in its next token. */
    private readonly guardedChannels = new Set<string>();
    /** The token already handed to this client, directly or by authCallback. */
    private presentedToken: string | null = null;
    /** Concurrent auth callbacks share one fresh-token request. */
    private renewal: Promise<string | null> | null = null;
    /** Bumped by `reset()`; requests started under an older value are stale. */
    private generation = 0;

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

    /**
     * Record channels before a replacement client starts authentication.
     * This gives its first auth callback enough information to mint a token.
     */
    trackChannels(channelNames: Iterable<string>): void {
        for (const channelName of channelNames) {
            if (isGuarded(channelName)) {
                this.guardedChannels.add(channelName);
            }
        }
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
        this.presentedToken = null;
        this.renewal = null;
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

        this.guardedChannels.add(channelName);

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
            const response = await this.requestToken(channelName, this.token);
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

                this.presentedToken = response.token;
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
        // A token fetched before a client existed has not been used yet. Offer
        // it once. Later callbacks are Ably's request for a replacement.
        if (this.token && this.token !== this.presentedToken) {
            this.presentedToken = this.token;
            callback(null, toTokenDetails(this.token));

            return;
        }

        // Nothing guarded was ever subscribed to, so there is no channel to ask
        // `/broadcasting/auth` about. A connection that only ever uses public
        // channels needs a credential of its own (tracking issue #4).
        if (this.guardedChannels.size === 0) {
            callback(NO_TOKEN, null);

            return;
        }

        void this.renew(callback);
    };

    /**
     * Fetch a replacement for the expiring token and hand it straight to ably,
     * which applies whatever an auth callback resolves with — so this deliberately
     * does not push it onto the connection a second time.
     */
    private async renew(
        callback: (
            error: ErrorInfo | string | null,
            tokenDetails: TokenDetails | null,
        ) => void,
    ): Promise<void> {
        try {
            const token = await this.renewToken();

            if (!token) {
                callback(NO_TOKEN, null);

                return;
            }

            this.presentedToken = token;
            callback(null, toTokenDetails(token));
        } catch (error) {
            // ably's callback signature takes `ErrorInfo | string`, and an
            // `Error` is in neither, so the reason travels as its message.
            const message =
                error instanceof Error
                    ? error.message
                    : typeof error === "object" &&
                        error !== null &&
                        "message" in error
                      ? String((error as { message: unknown }).message)
                      : String(error);
            callback(message, null);
        }
    }

    /**
     * Mint a token with a new lifetime, then rebuild all tracked capability on
     * it. The first request carries no token. This is important because the
     * Laravel broadcaster keeps the old JWT's `iat` and `exp` while that JWT is
     * still valid.
     */
    private renewToken(): Promise<string | null> {
        if (this.renewal) {
            return this.renewal;
        }

        const run = this.queue.then(async () => {
            const generation = this.generation;
            let nextToken: string | null = null;
            let nextParsed: ParsedJwt | null = null;
            const nextInfo = new Map<string, unknown>();

            for (const channelName of this.guardedChannels) {
                const response = await this.requestToken(
                    channelName,
                    nextToken,
                );

                nextParsed = parseJwt(response.token);
                nextToken = response.token;

                if (response.info !== undefined) {
                    nextInfo.set(channelName, response.info);
                }
            }

            if (generation !== this.generation || !nextToken || !nextParsed) {
                return null;
            }

            this.token = nextToken;
            this.parsed = nextParsed;

            for (const [channelName, info] of nextInfo) {
                this.info.set(channelName, info);
            }

            return nextToken;
        });

        this.queue = run.catch(() => undefined);

        const renewal = run.finally(() => {
            if (this.renewal === renewal) {
                this.renewal = null;
            }
        });

        this.renewal = renewal;

        return renewal;
    }

    /** Does the cached token grant `channelName`? Ably owns expiry timing. */
    private covers(channelName: string): boolean {
        if (!this.token || !this.parsed) {
            return false;
        }

        const capability = this.parsed.capability;

        if (capability[channelName] || capability["*"]) {
            return true;
        }

        const namespace = channelName.split(":")[0];

        return Boolean(capability[`${namespace}:*`]);
    }

    private async requestToken(
        channelName: string,
        existingToken: string | null,
    ): Promise<TokenResponse> {
        const { requestTokenFn } = this.driverOptions;

        if (requestTokenFn) {
            return requestTokenFn(channelName, existingToken);
        }

        const response = await fetch(this.echoOptions.authEndpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...this.echoOptions.auth.headers,
            },
            body: JSON.stringify({
                channel_name: channelName,
                token: existingToken,
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
