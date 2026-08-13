export const VERSION = "0.1.0";

export type { ParsedJwt } from "./auth/jwt";
export { parseJwt, toTokenDetails } from "./auth/jwt";
export type { AblyDriverOptions, RequestTokenFn, TokenResponse } from "./types";
export {
    baseName,
    isGuarded,
    normalize,
    toPresence,
    toPrivate,
    toPublic,
} from "./util/channel-name";
