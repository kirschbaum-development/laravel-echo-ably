import type {
    AuthOptions,
    ClientOptions,
    ErrorInfo,
    Realtime,
    TokenDetails,
} from "ably";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenManagerEchoOptions } from "../src/auth/token-manager";
import { TokenManager } from "../src/auth/token-manager";
import type { RequestTokenFn } from "../src/types";
import { makeJwt } from "./helpers";

const NOW = 1_700_000_000_000;
const NOW_S = NOW / 1000;

const ECHO_OPTIONS: TokenManagerEchoOptions = {
    authEndpoint: "/broadcasting/auth",
    auth: { headers: { "X-CSRF-TOKEN": "csrf-value" } },
};

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;
type FetchArgs = Parameters<FetchFn>;
type AuthCallbackFn = (
    error: ErrorInfo | string | null,
    tokenDetails: TokenDetails | null,
) => void;

/** A broadcaster JWT granting `capability`, expiring `ttl` seconds from `NOW`. */
function token(
    capability: Record<string, string[]>,
    ttl: number = 3600,
): string {
    return makeJwt({
        iat: NOW_S,
        exp: NOW_S + ttl,
        "x-ably-clientId": "user-42",
        "x-ably-capability": JSON.stringify(capability),
    });
}

function jsonResponse(body: unknown, status: number = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

/**
 * Stub `fetch` to hand back `responses` in order, and return the mock. A
 * response may be a pending promise, which keeps that request in flight.
 */
function stubFetch(...responses: Array<Response | Promise<Response>>) {
    const fetchMock = vi.fn<FetchFn>();

    for (const response of responses) {
        fetchMock.mockReturnValueOnce(Promise.resolve(response));
    }

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
}

/** Let the queued token request reach `fetch` without resolving it. */
function flushQueue(): Promise<void> {
    return Promise.resolve();
}

/** A response that stays in flight until `resolve` is called. */
function deferredResponse(): {
    response: Promise<Response>;
    resolve: (response: Response) => void;
} {
    let resolve: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((res) => {
        resolve = res;
    });

    return { response, resolve: (value) => resolve(value) };
}

function requestBody(call: FetchArgs): {
    channel_name: string;
    token: string | null;
} {
    return JSON.parse(String(call[1].body)) as {
        channel_name: string;
        token: string | null;
    };
}

/**
 * Invoke the auth callback and resolve with whatever it hands back, whether it
 * answers on the spot or after a renewal request.
 */
function callAuthCallback(
    manager: TokenManager,
): Promise<[ErrorInfo | string | null, TokenDetails | null]> {
    return new Promise((resolve) => {
        manager.authCallback({}, (error, details) =>
            resolve([error, details] as [
                ErrorInfo | string | null,
                TokenDetails | null,
            ]),
        );
    });
}

/** Minimal stand-in for the bits of `Realtime` the manager touches. */
function fakeClient() {
    // Typed with ably's own parameters so a test can read back the auth options
    // the push carried, not just that it happened.
    const authorize = vi.fn(
        async (
            _tokenParams?: unknown,
            _authOptions?: AuthOptions,
        ): Promise<undefined> => undefined,
    );

    return {
        client: { auth: { authorize } } as unknown as Realtime,
        authorize,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("ensureCapability", () => {
    it("resolves public channels without an auth request", async () => {
        const fetchMock = stubFetch();
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await expect(
            manager.ensureCapability("public:orders"),
        ).resolves.toBeUndefined();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(manager.currentToken()).toBeNull();
    });

    it("requests a token for the first guarded channel and applies it to the client", async () => {
        const jwt = token({ "private:orders": ["*"] });
        const fetchMock = stubFetch(jsonResponse({ token: jwt }));
        const { client, authorize } = fakeClient();

        const manager = new TokenManager(ECHO_OPTIONS, {});
        manager.setClient(client);
        await manager.ensureCapability("private:orders");

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toBe("/broadcasting/auth");
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": "csrf-value",
        });
        expect(requestBody(fetchMock.mock.calls[0])).toEqual({
            channel_name: "private:orders",
            token: null,
        });

        expect(manager.currentToken()).toBe(jwt);
        expect(authorize).toHaveBeenCalledWith(undefined, {
            token: jwt,
            authCallback: manager.authCallback,
        });
    });

    it("keeps its own auth callback registered on every push to the client", async () => {
        // ably *replaces* the stored auth options with whatever `authorize` is
        // handed — `Auth._saveTokenOptions` ends in a flat assignment, and the
        // typings say as much — so a push carrying only the token unregisters
        // the callback for good. ably then has no way to request the next
        // token (40171), and every renewal path in this class becomes
        // unreachable on a real client.
        const jwt = token({ "private:a": ["*"] });
        stubFetch(jsonResponse({ token: jwt }));
        const { client, authorize } = fakeClient();

        const manager = new TokenManager(ECHO_OPTIONS, {});
        manager.setClient(client);
        await manager.ensureCapability("private:a");

        const [tokenParams, authOptions] = authorize.mock.calls[0];

        expect(tokenParams).toBeUndefined();
        expect(authOptions?.token).toBe(jwt);
        // Identity, not shape: ably keeps whatever object it is given, and only
        // this exact function knows how to renew.
        expect(authOptions?.authCallback).toBe(manager.authCallback);
    });

    it("skips the request when the cached token already covers the channel", async () => {
        const fetchMock = stubFetch(
            jsonResponse({ token: token({ "private:orders": ["*"] }) }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:orders");
        await manager.ensureCapability("private:orders");

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats a `*` capability key as covering every channel", async () => {
        const fetchMock = stubFetch(
            jsonResponse({ token: token({ "*": ["*"] }) }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:orders");
        await manager.ensureCapability("presence:room");

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats a `namespace:*` capability key as covering only its namespace", async () => {
        const first = token({ "private:*": ["*"] });
        const second = token({ "private:*": ["*"], "presence:room": ["*"] });
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ token: second }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:orders");
        await manager.ensureCapability("private:invoices");

        expect(fetchMock).toHaveBeenCalledTimes(1);

        await manager.ensureCapability("presence:room");

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("re-requests carrying the current token when the channel is not covered", async () => {
        const first = token({ "private:a": ["*"] });
        const second = token({ "private:a": ["*"], "private:b": ["*"] });
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ token: second }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");
        await manager.ensureCapability("private:b");

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestBody(fetchMock.mock.calls[1])).toEqual({
            channel_name: "private:b",
            token: first,
        });
        expect(manager.currentToken()).toBe(second);
    });

    it("always requests a fresh token when force is set", async () => {
        const first = token({ "private:a": ["*"] });
        const second = token({ "private:a": ["subscribe", "publish"] });
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ token: second }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");
        await manager.ensureCapability("private:a", { force: true });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestBody(fetchMock.mock.calls[1]).token).toBe(first);
        expect(manager.currentToken()).toBe(second);
    });

    it("serializes concurrent token requests, second carries first's token", async () => {
        const tokenA = token({ "private:a": ["*"] });
        const tokenB = token({ "private:a": ["*"], "private:b": ["*"] });
        const fetchMock = stubFetch(
            jsonResponse({ token: tokenA }),
            jsonResponse({ token: tokenB }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await Promise.all([
            manager.ensureCapability("private:a"),
            manager.ensureCapability("private:b"),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestBody(fetchMock.mock.calls[0]).token).toBeNull();
        expect(requestBody(fetchMock.mock.calls[1]).token).toBe(tokenA);
        expect(manager.currentToken()).toBe(tokenB);
    });

    it("collapses concurrent requests for the same channel into one", async () => {
        // The cache check runs inside the queue, so the second caller sees the
        // first caller's token instead of firing a redundant request.
        const jwt = token({ "private:a": ["*"] });
        const fetchMock = stubFetch(jsonResponse({ token: jwt }));
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await Promise.all([
            manager.ensureCapability("private:a"),
            manager.ensureCapability("private:a"),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with the response status and leaves token state unchanged", async () => {
        const first = token({ "private:a": ["*"] });
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ message: "Forbidden" }, 403),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");
        await expect(manager.ensureCapability("private:b")).rejects.toThrow(
            "403",
        );

        expect(manager.currentToken()).toBe(first);

        // A failed request must not poison the queue for later callers.
        await manager.ensureCapability("private:a");

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects and keeps the previous token when the response is not a JWT", async () => {
        const first = token({ "private:a": ["*"] });
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ token: "not-a-jwt" }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");
        await expect(manager.ensureCapability("private:b")).rejects.toThrow(
            "Invalid JWT",
        );

        expect(manager.currentToken()).toBe(first);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("refreshes a token that is within 30 seconds of expiry", async () => {
        const first = token({ "private:a": ["*"] }, 60);
        const second = token({ "private:a": ["*"] }, 3600);
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ token: second }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");

        // 31s of life left: still good.
        vi.setSystemTime(NOW + 29_000);
        await manager.ensureCapability("private:a");

        expect(fetchMock).toHaveBeenCalledTimes(1);

        // 29s of life left: inside the refresh window.
        vi.setSystemTime(NOW + 31_000);
        await manager.ensureCapability("private:a");

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(manager.currentToken()).toBe(second);
    });

    it("never treats a token without an exp claim as covering a channel", async () => {
        const noExpiry = makeJwt({
            iat: NOW_S,
            "x-ably-capability": JSON.stringify({ "private:a": ["*"] }),
        });
        const fetchMock = stubFetch(
            jsonResponse({ token: noExpiry }),
            jsonResponse({ token: noExpiry }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");
        await manager.ensureCapability("private:a");

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("uses requestTokenFn in place of fetch when provided", async () => {
        const first = token({ "private:a": ["*"] });
        const second = token({ "private:a": ["*"], "private:b": ["*"] });
        const fetchMock = stubFetch();
        const requestTokenFn = vi
            .fn<RequestTokenFn>()
            .mockResolvedValueOnce({ token: first })
            .mockResolvedValueOnce({ token: second });

        const manager = new TokenManager(ECHO_OPTIONS, { requestTokenFn });

        await manager.ensureCapability("private:a");
        await manager.ensureCapability("private:b");

        expect(fetchMock).not.toHaveBeenCalled();
        expect(requestTokenFn.mock.calls).toEqual([
            ["private:a", null],
            ["private:b", first],
        ]);
        expect(manager.currentToken()).toBe(second);
    });
});

describe("presenceInfo", () => {
    it("captures the info payload from the auth response", async () => {
        const jwt = token({ "presence:room": ["*"] });
        stubFetch(jsonResponse({ token: jwt, info: { id: 7, name: "Ada" } }));
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("presence:room");

        expect(manager.presenceInfo("presence:room")).toEqual({
            id: 7,
            name: "Ada",
        });
        expect(manager.presenceInfo("presence:other")).toBeUndefined();
    });
});

describe("authCallback", () => {
    it("replays the cached token, without an auth request, while it is fresh", async () => {
        const jwt = token({ "private:a": ["*"] });
        const fetchMock = stubFetch(jsonResponse({ token: jwt }));
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");

        // Detached on purpose: ably-js holds this as a plain ClientOptions
        // function, so it has to stay bound to the manager.
        const { authCallback } = manager;
        const callback = vi.fn<AuthCallbackFn>();
        authCallback({}, callback);

        expect(callback).toHaveBeenCalledTimes(1);

        const [error, details] = callback.mock.calls[0];

        expect(error).toBeNull();
        expect(details).toEqual({
            token: jwt,
            clientId: "user-42",
            issued: NOW,
            expires: NOW + 3_600_000,
            capability: JSON.stringify({ "private:a": ["*"] }),
        });
        // A token that is good for another hour is not worth a round trip.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("requests a fresh token when the cached one is inside the expiry window", async () => {
        // The renewal path an idle, listen-only connection depends on: nothing
        // else asks for capability, so without this the connection loses
        // realtime for good at the token's TTL.
        const first = token({ "private:a": ["*"] }, 60);
        const second = token({ "private:a": ["*"] }, 3600);
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ token: second }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");

        // 29s of life left: inside the window, so the cached token is not worth
        // offering ably.
        vi.setSystemTime(NOW + 31_000);

        const [error, details] = await callAuthCallback(manager);

        expect(error).toBeNull();
        expect(details?.token).toBe(second);

        // Requested for the last channel a grant was actually made for, and
        // carrying the old token so the server accretes onto its capability.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestBody(fetchMock.mock.calls[1])).toEqual({
            channel_name: "private:a",
            token: first,
        });
        expect(manager.currentToken()).toBe(second);
    });

    it("renews for the last channel that was granted, not the last one asked for", async () => {
        const first = token({ "private:a": ["*"] }, 60);
        const second = token({ "private:a": ["*"], "private:b": ["*"] }, 60);
        const third = token({ "private:a": ["*"], "private:b": ["*"] }, 3600);
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ token: second }),
            jsonResponse({ token: third }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");
        await manager.ensureCapability("private:b");
        // Covered by the token already, so it grants nothing new and must not
        // become what a renewal asks for.
        await manager.ensureCapability("private:a");

        vi.setSystemTime(NOW + 31_000);

        await callAuthCallback(manager);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(requestBody(fetchMock.mock.calls[2]).channel_name).toBe(
            "private:b",
        );
    });

    it("reports an error when no token has been fetched yet", () => {
        const manager = new TokenManager(ECHO_OPTIONS, {});
        const callback = vi.fn<AuthCallbackFn>();

        manager.authCallback({}, callback);

        const [error, details] = callback.mock.calls[0];

        // ably-js accepts `ErrorInfo | string | null` here; a plain `Error` is
        // not in that union, so the reason travels as a string.
        expect(typeof error).toBe("string");
        expect(error).toContain("subscribe to a channel");
        expect(details).toBeNull();
    });

    it("still errors when no guarded channel was ever requested", async () => {
        // A public-only connection has no channel to renew for: there is
        // nothing `/broadcasting/auth` could be asked to grant. Tracked as
        // issue #4 rather than guessed at here.
        const fetchMock = stubFetch();
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("public:orders");

        const callback = vi.fn<AuthCallbackFn>();
        manager.authCallback({}, callback);

        const [error, details] = callback.mock.calls[0];

        expect(typeof error).toBe("string");
        expect(details).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports a failed renewal to ably rather than an empty token", async () => {
        const first = token({ "private:a": ["*"] }, 60);
        stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ message: "Forbidden" }, 403),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");

        vi.setSystemTime(NOW + 31_000);

        const [error, details] = await callAuthCallback(manager);

        expect(typeof error).toBe("string");
        expect(String(error)).toContain("403");
        expect(details).toBeNull();
        // The token that could not be replaced is still the one on file.
        expect(manager.currentToken()).toBe(first);
    });

    it("stays assignable to ably's ClientOptions.authCallback", () => {
        const manager = new TokenManager(ECHO_OPTIONS, {});

        // Compile-level guard: the connector wires this straight into
        // ClientOptions, so a narrower signature here would only blow up at
        // that call site. `tsc --noEmit` covers tests/, so this line is the
        // assertion.
        const wired: NonNullable<ClientOptions["authCallback"]> =
            manager.authCallback;

        expect(wired).toBe(manager.authCallback);
    });
});

describe("reset", () => {
    it("drops the cached token so the next call re-fetches from scratch", async () => {
        const first = token({ "private:a": ["*"] });
        const second = token({ "private:a": ["*"], "private:b": ["*"] });
        const fetchMock = stubFetch(
            jsonResponse({ token: first }),
            jsonResponse({ token: second }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("private:a");
        manager.reset();

        expect(manager.currentToken()).toBeNull();

        await manager.ensureCapability("private:a");

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestBody(fetchMock.mock.calls[1]).token).toBeNull();
        expect(manager.currentToken()).toBe(second);
    });

    it("drops the presence info the old session's grants carried", async () => {
        // The info is this user's presence payload. Keeping it past a logout
        // would enter the next member under the previous one's data.
        stubFetch(
            jsonResponse({
                token: token({ "presence:room": ["*"] }),
                info: { id: 7, name: "Ada" },
            }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        await manager.ensureCapability("presence:room");

        expect(manager.presenceInfo("presence:room")).toEqual({
            id: 7,
            name: "Ada",
        });

        manager.reset();

        expect(manager.presenceInfo("presence:room")).toBeUndefined();
    });

    it("discards a token that arrives after a reset", async () => {
        // Logout mid-flight: the reply belongs to the previous session and must
        // neither be cached nor pushed onto the live connection.
        const stale = token({ "private:a": ["*"] });
        const fresh = token({ "private:a": ["*"] }, 7200);
        const inFlight = deferredResponse();
        const fetchMock = stubFetch(
            inFlight.response,
            jsonResponse({ token: fresh }),
        );
        const { client, authorize } = fakeClient();
        const manager = new TokenManager(ECHO_OPTIONS, {});
        manager.setClient(client);

        const pending = manager.ensureCapability("private:a");
        await flushQueue();

        // Guard the setup: the request has to be genuinely out before the reset
        // for this test to be about what it claims.
        expect(fetchMock).toHaveBeenCalledTimes(1);

        manager.reset();
        inFlight.resolve(jsonResponse({ token: stale }));
        await pending;

        expect(manager.currentToken()).toBeNull();
        expect(authorize).not.toHaveBeenCalled();

        await manager.ensureCapability("private:a");

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestBody(fetchMock.mock.calls[1]).token).toBeNull();
        expect(manager.currentToken()).toBe(fresh);
        expect(authorize).toHaveBeenCalledWith(undefined, {
            token: fresh,
            authCallback: manager.authCallback,
        });
    });

    it("still serves a request that was queued when the reset happened", async () => {
        // Only requests already in flight are invalidated: one still waiting its
        // turn simply starts fresh, or its caller would attach with no token.
        const stale = token({ "private:a": ["*"] });
        const fresh = token({ "private:b": ["*"] });
        const inFlight = deferredResponse();
        const fetchMock = stubFetch(
            inFlight.response,
            jsonResponse({ token: fresh }),
        );
        const manager = new TokenManager(ECHO_OPTIONS, {});

        const first = manager.ensureCapability("private:a");
        const second = manager.ensureCapability("private:b");
        await flushQueue();

        expect(fetchMock).toHaveBeenCalledTimes(1);

        manager.reset();
        inFlight.resolve(jsonResponse({ token: stale }));
        await Promise.all([first, second]);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestBody(fetchMock.mock.calls[1]).token).toBeNull();
        expect(manager.currentToken()).toBe(fresh);
    });
});
