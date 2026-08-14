import type { Realtime } from "ably";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { TokenManager } from "../src/auth/token-manager";
import type { AblyChannel } from "../src/channels/ably-channel";
import type { NormalizedReplay } from "../src/replay/types";
import type { EchoOptionsWithDefaults } from "../src/types";
import type { MockChannel, MockRealtime } from "./mocks/ably";
import { createMockRealtime } from "./mocks/ably";

/**
 * Node's rejection hook. Declared here because the package targets the browser,
 * so the tsconfig carries no node typings.
 */
declare const process: {
    on(event: string, listener: (reason: unknown) => void): void;
    off(event: string, listener: (reason: unknown) => void): void;
};

/** The channel name the harness uses unless a test asks for another. */
export const CHANNEL_NAME = "private:orders";

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

/** A listener whose calls do not matter. Bare `vi.fn()` is not a `CallableFunction`. */
export function noopListener(): Mock<() => void> {
    return vi.fn(() => undefined);
}

/** Echo's resolved options bag, with the driver-specific slice merged in. */
export function echoOptions(
    ably: Record<string, unknown> = {},
): EchoOptionsWithDefaults {
    return {
        broadcaster: "ably",
        auth: { headers: {} },
        authEndpoint: "/broadcasting/auth",
        userAuthentication: {
            endpoint: "/broadcasting/user-auth",
            headers: {},
        },
        csrfToken: null,
        bearerToken: null,
        host: null,
        key: null,
        namespace: "App.Events",
        ably,
    };
}

/** Every channel class in the driver shares this constructor signature. */
type ChannelConstructor<TChannel extends AblyChannel> = new (
    ably: Realtime,
    name: string,
    options: EchoOptionsWithDefaults,
    tokenManager: TokenManager,
    replay?: NormalizedReplay,
) => TChannel;

/** What a test may vary about the channel the harness builds. */
export type ChannelOverrides = {
    ensureCapability?: Mock;
    presenceInfo?: Mock;
    options?: EchoOptionsWithDefaults;
    name?: string;
    /** The replay config the connector would have normalized; off by default. */
    replay?: NormalizedReplay;
};

export type ChannelHarness<TChannel extends AblyChannel> = {
    realtime: MockRealtime;
    channel: TChannel;
    ensureCapability: Mock;
    presenceInfo: Mock;
    /** The underlying mock channel; only present once `subscribe()` got that far. */
    underlying: () => MockChannel;
};

/** A channel of the given class, wired to a mock realtime and token manager. */
export function setupChannel<TChannel extends AblyChannel>(
    Channel: ChannelConstructor<TChannel>,
    overrides: ChannelOverrides = {},
): ChannelHarness<TChannel> {
    const name = overrides.name ?? CHANNEL_NAME;
    const ensureCapability =
        overrides.ensureCapability ?? vi.fn().mockResolvedValue(undefined);
    const presenceInfo =
        overrides.presenceInfo ?? vi.fn().mockReturnValue(undefined);
    const tokenManager = {
        ensureCapability,
        presenceInfo,
    } as unknown as TokenManager;
    const realtime = createMockRealtime();

    const channel = new Channel(
        realtime as unknown as Realtime,
        name,
        overrides.options ?? echoOptions(),
        tokenManager,
        overrides.replay,
    );

    return {
        realtime,
        channel,
        ensureCapability,
        presenceInfo,
        underlying: () => realtime.channels.all[name],
    };
}

/** Let `subscribe()` finish and every listener registration chained on it apply. */
export async function settle(channel: AblyChannel): Promise<void> {
    await channel.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
}

export function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

/** Record anything Node would report as an unhandled promise rejection. */
export async function withoutUnhandledRejections(
    body: () => Promise<void>,
): Promise<unknown[]> {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);

    process.on("unhandledRejection", onRejection);

    try {
        await body();
        // Two macrotask turns: Node reports unhandled rejections at the end of
        // the turn in which the promise was rejected.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
        process.off("unhandledRejection", onRejection);
    }

    return rejections;
}
