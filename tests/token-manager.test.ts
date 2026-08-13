import type { Realtime, TokenDetails } from "ably";
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
    error: unknown,
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

/** Stub `fetch` to hand back `responses` in order, and return the mock. */
function stubFetch(...responses: Response[]) {
    const fetchMock = vi.fn<FetchFn>();

    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
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

/** Minimal stand-in for the bits of `Realtime` the manager touches. */
function fakeClient() {
    const authorize = vi.fn(async () => undefined);

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
        expect(authorize).toHaveBeenCalledWith(undefined, { token: jwt });
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
    it("hands ably the current token details", async () => {
        const jwt = token({ "private:a": ["*"] });
        stubFetch(jsonResponse({ token: jwt }));
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
    });

    it("reports an error when no token has been fetched yet", () => {
        const manager = new TokenManager(ECHO_OPTIONS, {});
        const callback = vi.fn<AuthCallbackFn>();

        manager.authCallback({}, callback);

        const [error, details] = callback.mock.calls[0];

        expect(error).toBeInstanceOf(Error);
        expect(details).toBeNull();
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
});
