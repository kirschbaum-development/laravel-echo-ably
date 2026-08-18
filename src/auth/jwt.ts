import type { TokenDetails } from "ably";

export type ParsedJwt = {
    clientId: string | null;
    /** Milliseconds since the Unix epoch. */
    issued: number;
    /** Milliseconds since the Unix epoch. */
    expires: number;
    /** Parsed `x-ably-capability` claim, `{}` when the claim is absent. */
    capability: Record<string, string[]>;
};

/**
 * Decode a base64url JWT segment. `atob` keeps this dependency free in both
 * browsers and Node >= 20; the percent-encoding dance restores multi-byte
 * UTF-8 characters that `atob` hands back as individual bytes.
 */
function decodeSegment(segment: string): Record<string, unknown> {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
        atob(base64)
            .split("")
            .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
            .join(""),
    );

    return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Parse (without verifying) the HS256 JWT returned by Laravel's
 * `ably/laravel-broadcaster`. Signature verification is a server concern; the
 * client only needs the claims to describe the token and inspect capability.
 */
export function parseJwt(jwt: string): ParsedJwt {
    const segments = jwt.split(".");

    if (segments.length !== 3) {
        throw new Error("Invalid JWT");
    }

    let payload: Record<string, unknown>;
    let capability: Record<string, string[]>;

    // Both decodes are guarded: a structurally valid JWT carrying a non-JSON
    // capability claim is just as malformed as an undecodable payload, and
    // callers should only ever have to catch one kind of error.
    try {
        payload = decodeSegment(segments[1]);

        const capabilityClaim = payload["x-ably-capability"];

        capability =
            typeof capabilityClaim === "string"
                ? (JSON.parse(capabilityClaim) as Record<string, string[]>)
                : {};
    } catch {
        throw new Error("Invalid JWT");
    }

    const clientId = payload["x-ably-clientId"];

    return {
        clientId: typeof clientId === "string" ? clientId : null,
        issued: typeof payload.iat === "number" ? payload.iat * 1000 : 0,
        expires: typeof payload.exp === "number" ? payload.exp * 1000 : 0,
        capability,
    };
}

/** Wrap a broadcaster JWT in the shape ably-js expects from an auth callback. */
export function toTokenDetails(jwt: string): TokenDetails {
    const parsed = parseJwt(jwt);

    return {
        token: jwt,
        clientId: parsed.clientId ?? undefined,
        issued: parsed.issued,
        expires: parsed.expires,
        capability: JSON.stringify(parsed.capability),
    };
}
