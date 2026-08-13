/**
 * Build an unsigned JWT with the given payload claims, shaped like the tokens
 * `ably/laravel-broadcaster` returns from `/broadcasting/auth`.
 */
export function makeJwt(payload: Record<string, unknown>): string {
    // base64url via web APIs only, so the fixtures stay valid in whichever
    // environment the suite runs in (no Buffer, matching the browser target).
    const b64 = (obj: unknown) => {
        const bytes = new TextEncoder().encode(JSON.stringify(obj));

        return btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    };

    return `${b64({ alg: "HS256", typ: "JWT", kid: "keyName" })}.${b64(payload)}.signature`;
}
