export const VERSION = "0.1.0";

export type { ParsedJwt } from "./auth/jwt";
export { parseJwt, toTokenDetails } from "./auth/jwt";
export type { TokenManagerEchoOptions } from "./auth/token-manager";
export { TokenManager } from "./auth/token-manager";
export { AblyChannel } from "./channels/ably-channel";
export type {
    AblyDriverOptions,
    EchoOptionsWithDefaults,
    RequestTokenFn,
    TokenResponse,
} from "./types";
export {
    baseName,
    isGuarded,
    normalize,
    toPresence,
    toPrivate,
    toPublic,
} from "./util/channel-name";
