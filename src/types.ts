import type { ChannelOptions, ClientOptions, Realtime } from "ably";
import type { Channel } from "laravel-echo";

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
};
