import type { ChannelOptions, ClientOptions, Realtime } from "ably";

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
