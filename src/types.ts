import type { ChannelOptions, ClientOptions, Realtime } from "ably";
import type { Channel } from "laravel-echo";
import type { ReplayOptions } from "./replay/types";

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
