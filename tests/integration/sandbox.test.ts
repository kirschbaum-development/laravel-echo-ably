import type { Realtime as RealtimeClient } from "ably";
import { Realtime } from "ably";
import Echo from "laravel-echo";
import { afterEach, describe, expect, it } from "vitest";
import type {
    AblyChannel,
    AblyPresenceChannel,
    AblyPrivateChannel,
    RequestTokenFn,
} from "../../src/index";
import { AblyConnector, parseJwt } from "../../src/index";

/**
 * Node's environment bag. Declared here because the package targets the
 * browser, so the tsconfig carries no node typings.
 */
declare const process: { env: Record<string, string | undefined> };

/**
 * A `name:secret` Ably key for a sandbox app. Absent everywhere but CI and a
 * maintainer's shell, which is what gates this whole file.
 */
const SANDBOX_KEY = process.env.ABLY_SANDBOX_KEY ?? "";

/**
 * Ably's `endpoint` client option, for a key that does not belong to a
 * production app: `nonprod:sandbox` for one of Ably's ephemeral sandbox apps.
 * Left unset, the tests talk to production, which is what a key from an
 * ordinary (free-tier) Ably app needs.
 */
const ENDPOINT = process.env.ABLY_SANDBOX_ENDPOINT ?? "";

/** The endpoint slice of both the driver's and the raw client's options. */
const ENDPOINT_OPTIONS = ENDPOINT ? { endpoint: ENDPOINT } : {};

/** How long a message may take to make the round trip through Ably. */
const ROUND_TRIP_MS = 10_000;

/** Room for the connection handshake on top of the round trip itself. */
const TEST_TIMEOUT_MS = 30_000;

/**
 * These tests talk to a live Ably app, so everything they touch is suffixed to
 * keep concurrent runs (two CI jobs, a maintainer alongside them) apart.
 */
const RUN = Math.random().toString(36).slice(2, 10);

/**
 * Integration coverage against the real ably-js and a real Ably connection.
 *
 * The unit suite mocks ably-js, so it can only prove the driver behaves against
 * the mock's idea of Ably. This file is the thin check that the idea is right:
 * that a message published elsewhere reaches an Echo `listen()` callback, that
 * a whisper crosses between two clients, and that a presence channel really
 * does go attached → enter → `here()` with the member data the auth response
 * carried.
 *
 * Run with `npm run test:integration` and `ABLY_SANDBOX_KEY` set.
 */
describe.skipIf(!SANDBOX_KEY)("ably sandbox", () => {
    const teardown: (() => void)[] = [];

    afterEach(() => {
        teardown.forEach((close) => close());
        teardown.length = 0;
    });

    /**
     * An Echo instance on this driver, authenticating as `clientId`.
     *
     * `requestTokenFn` stands in for `ably/laravel-broadcaster`: it mints the
     * same HS256 JWT the Laravel package returns from `/broadcasting/auth`,
     * accreting capability onto whatever token the driver already holds.
     */
    function createEcho(clientId: string, info?: unknown) {
        const echo = new Echo({
            broadcaster: AblyConnector,
            ably: {
                clientOptions: { ...ENDPOINT_OPTIONS },
                requestTokenFn: broadcasterStub(clientId, info),
            },
        });

        teardown.push(() => echo.disconnect());

        return echo;
    }

    /** A plain ably-js client on the same app, standing in for the server. */
    function createRawClient(): RealtimeClient {
        const client = new Realtime({
            key: SANDBOX_KEY,
            ...ENDPOINT_OPTIONS,
        });

        teardown.push(() => client.close());

        return client;
    }

    /** Publish an event onto a resolved Ably channel from outside the driver. */
    async function publish(
        channel: string,
        event: string,
        data: unknown,
    ): Promise<void> {
        await createRawClient().channels.get(channel).publish(event, data);
    }

    it(
        "delivers a public-channel event to an Echo listener",
        async () => {
            const echo = createEcho("public-subscriber");

            // Ably will not open a connection without a credential, and the
            // driver only requests one for a guarded channel — so a public
            // channel rides a connection that a private or presence channel
            // authenticated. See the README's "Public channels" note for the
            // public-only alternative.
            await attached(echo.private(`orders-${RUN}`) as AblyPrivateChannel);

            const channel = echo.channel(`orders-${RUN}`) as AblyChannel;
            const received = deferred<unknown>();

            channel.listen("OrderShipped", (payload: unknown) =>
                received.resolve(payload),
            );

            await attached(channel);

            await publish(`public:orders-${RUN}`, "App\\Events\\OrderShipped", {
                id: 7,
            });

            await expect(
                withTimeout(received.promise, "the public event"),
            ).resolves.toEqual({ id: 7 });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "delivers a private-channel event to an Echo listener",
        async () => {
            const echo = createEcho("private-subscriber");
            const channel = echo.private(`orders-${RUN}`) as AblyPrivateChannel;
            const received = deferred<unknown>();

            channel.listen("OrderShipped", (payload: unknown) =>
                received.resolve(payload),
            );

            await attached(channel);

            await publish(
                `private:orders-${RUN}`,
                "App\\Events\\OrderShipped",
                { id: 9 },
            );

            await expect(
                withTimeout(received.promise, "the private event"),
            ).resolves.toEqual({ id: 9 });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "carries a whisper between two clients on a private channel",
        async () => {
            const listener = createEcho("whisper-listener").private(
                `typing-${RUN}`,
            ) as AblyPrivateChannel;
            const whisperer = createEcho("whisperer").private(
                `typing-${RUN}`,
            ) as AblyPrivateChannel;
            const received = deferred<unknown>();

            listener.listenForWhisper("typing", (payload: unknown) =>
                received.resolve(payload),
            );

            await attached(listener);
            await attached(whisperer);

            whisperer.whisper("typing", { name: "Jane" });

            await expect(
                withTimeout(received.promise, "the whisper"),
            ).resolves.toEqual({ name: "Jane" });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "enters the presence set and reports the member list to here()",
        async () => {
            const member = { id: 42, name: "Jane" };
            const echo = createEcho("presence-member", member);
            const channel = echo.join(`room-${RUN}`) as AblyPresenceChannel;
            const here = deferred<unknown[]>();

            channel.here((members: unknown[]) => here.resolve(members));

            await expect(
                withTimeout(here.promise, "the member list"),
            ).resolves.toEqual([member]);
        },
        TEST_TIMEOUT_MS,
    );
});

/**
 * What `AblyBroadcaster::getSignedToken()` grants on every token it signs,
 * whichever channel was asked for.
 */
const PUBLIC_CLAIMS = {
    "public:*": ["subscribe", "history", "channel-metadata"],
};

/**
 * A stand-in for `ably/laravel-broadcaster`'s `/broadcasting/auth`: an HS256
 * JWT signed with the same key Ably would verify it with, granting the
 * requested channel on top of whatever the driver's current token carries.
 *
 * The driver only ever asks for a guarded channel, which is why the requested
 * name is granted `["*"]` unconditionally — that is the server's guarded-channel
 * branch.
 */
function broadcasterStub(clientId: string, info?: unknown): RequestTokenFn {
    return async (channelName, existingToken) => {
        const granted = existingToken
            ? parseJwt(existingToken).capability
            : PUBLIC_CLAIMS;

        return {
            token: await mintToken(clientId, {
                ...granted,
                [channelName]: ["*"],
            }),
            info,
        };
    };
}

/** Sign the JWT the Laravel package would have signed, with the same key. */
async function mintToken(
    clientId: string,
    capability: Record<string, string[]>,
): Promise<string> {
    const [keyName, keySecret] = SANDBOX_KEY.split(":");
    const issued = Math.floor(Date.now() / 1000);
    const signingInput = [
        encodeSegment({ alg: "HS256", typ: "JWT", kid: keyName }),
        encodeSegment({
            iat: issued,
            exp: issued + 3600,
            "x-ably-clientId": clientId,
            "x-ably-capability": JSON.stringify(capability),
        }),
    ].join(".");

    // Web Crypto rather than node:crypto: the same HMAC this package's browser
    // target would have available.
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(keySecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(signingInput),
    );

    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function encodeSegment(value: unknown): string {
    return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/**
 * Wait until the channel is attached and every listener registered against it
 * has reached ably-js — those registrations are chained onto `ready`, so a
 * macrotask turn after it settles is what drains them.
 */
async function attached(channel: AblyChannel): Promise<void> {
    await channel.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(channel.subscription.state).toBe("attached");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });

    return { promise, resolve };
}

/** Fail loudly instead of hanging when a round trip never completes. */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;

    const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timed out waiting for ${label}`)),
            ROUND_TRIP_MS,
        );
    });

    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
