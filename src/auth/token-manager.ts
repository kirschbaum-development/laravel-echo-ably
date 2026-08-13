import type { Realtime, TokenDetails } from "ably";
import type { AblyDriverOptions, TokenResponse } from "../types";
import { isGuarded } from "../util/channel-name";
import type { ParsedJwt } from "./jwt";
import { parseJwt, toTokenDetails } from "./jwt";

/**
 * A token this close to expiry is treated as already expired: attaching with it
 * would race the server's own expiry check.
 */
const EXPIRY_WINDOW_MS = 30_000;

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

        // Requests queue behind one another: the server accretes capability onto
        // the token it is handed, so overlapping requests would each drop the
        // other's grants.
        const run = this.queue.then(async () => {
            if (!opts.force && this.covers(channelName)) {
                return;
            }

            const response = await this.requestToken(channelName);
            // Parse before storing: a malformed token must leave the previous
            // one in place rather than half-replace it.
            const parsed = parseJwt(response.token);

            this.token = response.token;
            this.parsed = parsed;

            if (response.info !== undefined) {
                this.info.set(channelName, response.info);
            }

            if (this.client) {
                await this.client.auth.authorize(undefined, {
                    token: response.token,
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
     * a field because ably-js calls it detached from the manager.
     */
    authCallback = (
        _tokenParams: unknown,
        callback: (error: unknown, tokenDetails: TokenDetails | null) => void,
    ): void => {
        if (!this.token) {
            callback(
                new Error(
                    "No Ably token available yet: subscribe to a channel before authenticating.",
                ),
                null,
            );

            return;
        }

        callback(null, toTokenDetails(this.token));
    };

    /** Does the cached token grant `channelName` for long enough to use? */
    private covers(channelName: string): boolean {
        if (!this.token || !this.parsed) {
            return false;
        }

        // A token with no `exp` claim parses to `expires: 0`, so it lands here
        // and is never trusted.
        if (this.parsed.expires - Date.now() < EXPIRY_WINDOW_MS) {
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
