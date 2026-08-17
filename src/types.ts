import type {
    ChannelOptions,
    ChannelStateChange,
    ClientOptions,
    ErrorInfo,
    Realtime,
} from "ably";
import type { Channel } from "laravel-echo";
import type { ReplayOptions } from "./replay/types";

/**
 * What a channel hands its `continuityLost` callbacks.
 *
 * Ably reports a break in message continuity by attaching `resumed: false` to a
 * channel state change — on `attached` after a disconnection outlived the
 * resume window, and on `update` when continuity is lost while the channel
 * stays attached. Both are the same news, and both arrive here.
 */
export type ContinuityLostEvent = {
    /** The resolved Ably channel name, e.g. `private:orders`. */
    channel: string;
    /**
     * Ably's own state change, untouched — `resumed`, `current`, `previous`
     * and `hasBacklog` included.
     */
    stateChange: ChannelStateChange;
    /**
     * Shorthand for `stateChange.reason`: the `ErrorInfo` ably attached to the
     * gap, where 90003 (messages expired) and 90005 (continuity lost) turn up.
     * Often absent — a re-attach that simply could not resume carries no error,
     * which is why the gap is reported by `resumed`, never by an error code.
     */
    reason: ErrorInfo | undefined;
    /**
     * Whether a replay catch-up was started for this gap. `false` when
     * `ably.replay` is off, and the application is on its own for recovery.
     */
    willReplay: boolean;
};

/**
 * Echo's options bag after its own defaults have been merged in. laravel-echo
 * declares the type but does not export it, so it is recovered from the shape
 * of `Channel.options`.
 */
export type EchoOptionsWithDefaults = Channel["options"];

export type TokenResponse = { token: string; info?: unknown };

export type RequestTokenFn = (
    channelName: string,
    existingToken: string | null,
) => Promise<TokenResponse>;

export type AblyDriverOptions = {
    clientOptions?: Partial<ClientOptions>;
    client?: Realtime;
    requestTokenFn?: RequestTokenFn;
    channelOptions?: Record<string, ChannelOptions>;
    /**
     * Replay events missed while the connection had no continuity. Off by
     * default; `true` or `{limit}` turns the auto catch-up on for every
     * channel.
     */
    replay?: ReplayOptions;
};
