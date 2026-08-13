import type { ChannelOptions, ChannelStateChange, Realtime } from "ably";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { TokenManager } from "../src/auth/token-manager";
import { AblyChannel } from "../src/channels/ably-channel";
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

const NAME = "private:orders";

/** A listener whose calls do not matter. Bare `vi.fn()` is not a `CallableFunction`. */
function noopListener(): Mock<() => void> {
    return vi.fn(() => undefined);
}

/** Echo's resolved options bag, with the driver-specific slice merged in. */
function echoOptions(
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

type Harness = {
    realtime: MockRealtime;
    channel: AblyChannel;
    ensureCapability: Mock;
    /** The underlying mock channel; only present once `subscribe()` got that far. */
    underlying: () => MockChannel;
};

function setup(
    overrides: {
        ensureCapability?: Mock;
        options?: EchoOptionsWithDefaults;
        name?: string;
    } = {},
): Harness {
    const name = overrides.name ?? NAME;
    const ensureCapability =
        overrides.ensureCapability ?? vi.fn().mockResolvedValue(undefined);
    const tokenManager = {
        ensureCapability,
        presenceInfo: () => undefined,
    } as unknown as TokenManager;
    const realtime = createMockRealtime();

    const channel = new AblyChannel(
        realtime as unknown as Realtime,
        name,
        overrides.options ?? echoOptions(),
        tokenManager,
    );

    return {
        realtime,
        channel,
        ensureCapability,
        underlying: () => realtime.channels.all[name],
    };
}

/** Let `subscribe()` finish and every listener registration chained on it apply. */
async function settle(channel: AblyChannel): Promise<void> {
    await channel.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
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
async function withoutUnhandledRejections(
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

describe("AblyChannel", () => {
    describe("subscribe", () => {
        it("awaits the token capability before creating and attaching the channel", async () => {
            const gate = deferred<void>();
            const { realtime, channel, ensureCapability } = setup({
                ensureCapability: vi.fn().mockReturnValue(gate.promise),
            });

            expect(ensureCapability).toHaveBeenCalledWith(NAME);
            expect(realtime.channels.get).not.toHaveBeenCalled();

            gate.resolve();
            await settle(channel);

            expect(realtime.channels.get).toHaveBeenCalledWith(NAME, undefined);
            expect(realtime.channels.all[NAME].attach).toHaveBeenCalled();
            // The attach must follow the channel creation, not race it.
            expect(
                realtime.channels.all[NAME].attach.mock.invocationCallOrder[0],
            ).toBeGreaterThan(
                realtime.channels.get.mock.invocationCallOrder[0],
            );
        });

        it("passes the channelOptions matching the resolved name to channels.get", async () => {
            const options: ChannelOptions = { params: { rewind: "1" } };
            const { realtime, channel } = setup({
                options: echoOptions({
                    channelOptions: {
                        [NAME]: options,
                        "private:other": { params: { rewind: "5" } },
                    },
                }),
            });

            await settle(channel);

            expect(realtime.channels.get).toHaveBeenCalledWith(NAME, options);
            expect(realtime.channels.requestedOptions[NAME]).toEqual(options);
        });
    });

    describe("listen", () => {
        it("formats the event name through the namespace", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.listen("OrderShipped", callback);
            await settle(channel);

            expect(underlying().subscribe).toHaveBeenCalledWith(
                "App\\Events\\OrderShipped",
                expect.any(Function),
            );

            underlying().emitMessage({
                name: "App\\Events\\OrderShipped",
                data: { id: 1 },
            });

            expect(callback).toHaveBeenCalledWith({ id: 1 });
        });

        it("bypasses the namespace for leading-dot event names", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.listen(".OrderShipped", callback);
            await settle(channel);

            expect(underlying().subscribe).toHaveBeenCalledWith(
                "OrderShipped",
                expect.any(Function),
            );

            underlying().emitMessage({ name: "OrderShipped", data: "payload" });

            expect(callback).toHaveBeenCalledWith("payload");
        });

        it("does not deliver messages for other event names", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.listen(".OrderShipped", callback);
            await settle(channel);

            underlying().emitMessage({ name: "OrderCreated", data: {} });

            expect(callback).not.toHaveBeenCalled();
        });

        it("registering the same callback twice delivers once and stays removable", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.listen(".OrderShipped", callback);
            channel.listen(".OrderShipped", callback);
            await settle(channel);

            underlying().emitMessage({ name: "OrderShipped", data: "payload" });
            expect(callback).toHaveBeenCalledTimes(1);

            channel.stopListening(".OrderShipped", callback);
            await settle(channel);

            underlying().emitMessage({ name: "OrderShipped", data: "payload" });
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("subscribes to raw ably event names through on(), unformatted", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.on("client-typing", callback);
            await settle(channel);

            expect(underlying().subscribe).toHaveBeenCalledWith(
                "client-typing",
                expect.any(Function),
            );

            underlying().emitMessage({ name: "client-typing", data: { a: 1 } });

            expect(callback).toHaveBeenCalledWith({ a: 1 });
        });
    });

    describe("stopListening", () => {
        it("removes only the given callback, leaving other listeners for the event", async () => {
            const { channel, underlying } = setup();
            const removed = vi.fn();
            const kept = vi.fn();

            channel.listen(".OrderShipped", removed);
            channel.listen(".OrderShipped", kept);
            await settle(channel);

            channel.stopListening(".OrderShipped", removed);
            await settle(channel);

            underlying().emitMessage({ name: "OrderShipped", data: "payload" });

            expect(removed).not.toHaveBeenCalled();
            expect(kept).toHaveBeenCalledWith("payload");
        });

        it("removes every listener for the event when no callback is given", async () => {
            const { channel, underlying } = setup();
            const first = vi.fn();
            const second = vi.fn();

            channel.listen(".OrderShipped", first);
            channel.listen(".OrderShipped", second);
            await settle(channel);

            channel.stopListening(".OrderShipped");
            await settle(channel);

            underlying().emitMessage({ name: "OrderShipped", data: "payload" });

            expect(first).not.toHaveBeenCalled();
            expect(second).not.toHaveBeenCalled();
        });

        it("ignores callbacks that were never registered", async () => {
            const { channel, underlying } = setup();
            const kept = vi.fn();

            channel.listen(".OrderShipped", kept);
            await settle(channel);

            channel.stopListening(".OrderShipped", noopListener());
            await settle(channel);

            underlying().emitMessage({ name: "OrderShipped", data: "payload" });

            expect(kept).toHaveBeenCalledWith("payload");
        });
    });

    describe("listenToAll", () => {
        it("strips the namespace prefix and dot-prefixes foreign events", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.listenToAll(callback);
            await settle(channel);

            underlying().emitMessage({
                name: "App\\Events\\OrderShipped",
                data: { id: 1 },
            });
            underlying().emitMessage({ name: "SomeEvent", data: { id: 2 } });

            expect(callback).toHaveBeenNthCalledWith(1, "OrderShipped", {
                id: 1,
            });
            expect(callback).toHaveBeenNthCalledWith(2, ".SomeEvent", {
                id: 2,
            });
        });

        it("keeps event-scoped listeners alive when a global listener is removed", async () => {
            const { channel, underlying } = setup();
            const global = vi.fn();
            const scoped = vi.fn();

            channel.listenToAll(global);
            channel.listen(".OrderShipped", scoped);
            await settle(channel);

            channel.stopListeningToAll(global);
            await settle(channel);

            underlying().emitMessage({ name: "OrderShipped", data: "payload" });

            expect(global).not.toHaveBeenCalled();
            expect(scoped).toHaveBeenCalledWith("payload");
        });

        it("removes every global listener when no callback is given", async () => {
            const { channel, underlying } = setup();
            const first = vi.fn();
            const second = vi.fn();

            channel.listenToAll(first);
            channel.listenToAll(second);
            await settle(channel);

            channel.stopListeningToAll();
            await settle(channel);

            underlying().emitMessage({ name: "SomeEvent", data: "payload" });

            expect(first).not.toHaveBeenCalled();
            expect(second).not.toHaveBeenCalled();
        });
    });

    describe("subscribed and error callbacks", () => {
        it("fires subscribed callbacks when the channel attaches", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.subscribed(callback);
            await settle(channel);

            underlying().emitStateChange({
                current: "attached",
                previous: "attaching",
            });

            expect(callback).toHaveBeenCalledTimes(1);

            underlying().emitStateChange({
                current: "detached",
                previous: "attached",
            });

            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("registers exactly one state listener even when subscribe runs again", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.subscribed(callback);
            await settle(channel);

            await channel.subscribe();

            underlying().emitStateChange({ current: "attached" });

            expect(underlying().on).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("fires error callbacks when a state change carries a reason", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();
            const reason = { code: 40160, message: "not permitted" };

            channel.error(callback);
            await settle(channel);

            underlying().emitStateChange({ current: "failed", reason });

            expect(callback).toHaveBeenCalledWith(reason);
        });

        it("replays the last error to a callback registered after the failure", async () => {
            const { channel, underlying } = setup();
            const reason = { code: 40160, message: "not permitted" };

            await settle(channel);
            underlying().emitStateChange({ current: "failed", reason });

            const callback = vi.fn();
            channel.error(callback);

            expect(callback).toHaveBeenCalledWith(reason);
        });

        it("routes a capability rejection to error callbacks without an unhandled rejection", async () => {
            const failure = new Error("auth endpoint exploded");
            const callback = vi.fn();

            const rejections = await withoutUnhandledRejections(async () => {
                const { channel, realtime } = setup({
                    ensureCapability: vi.fn().mockRejectedValue(failure),
                });

                channel.error(callback);
                // Listener registrations must survive a failed subscribe, too.
                channel.listen(".OrderShipped", noopListener());
                channel.listenToAll(noopListener());
                channel.stopListening(".OrderShipped");
                channel.unsubscribe();

                await expect(channel.ready).resolves.toBeUndefined();
                expect(realtime.channels.get).not.toHaveBeenCalled();
            });

            expect(callback).toHaveBeenCalledWith(failure);
            expect(rejections).toEqual([]);
        });

        it("never leaks an unhandled rejection when an ably operation fails", async () => {
            const rejections = await withoutUnhandledRejections(async () => {
                const { channel, realtime } = setup();
                const underlying = realtime.channels.get(NAME);

                underlying.subscribe.mockRejectedValue(
                    new Error("attach on subscribe failed"),
                );
                underlying.detach.mockRejectedValue(new Error("detach failed"));

                channel.listen(".OrderShipped", noopListener());
                channel.listenToAll(noopListener());
                channel.stopListening(".OrderShipped");
                channel.stopListeningToAll();
                channel.unsubscribe();

                await settle(channel);
            });

            expect(rejections).toEqual([]);
        });

        it("routes an attach rejection to error callbacks", async () => {
            const failure = new Error("attach refused");
            const { channel, realtime } = setup();
            const callback = vi.fn();

            // `subscribe()` is still suspended on its first await, so the ably
            // channel does not exist yet: create it here so its attach can be
            // made to fail before `subscribe()` gets hold of it.
            realtime.channels.get(NAME).attach.mockRejectedValueOnce(failure);
            channel.error(callback);

            await settle(channel);

            expect(callback).toHaveBeenCalledWith(failure);
        });
    });

    describe("onChannelFailed", () => {
        it("hands failures to the subclass hook, which can claim them", async () => {
            const failures: ChannelStateChange[] = [];

            class RecoveringChannel extends AblyChannel {
                protected onChannelFailed(change: ChannelStateChange): boolean {
                    failures.push(change);

                    return true;
                }
            }

            const realtime = createMockRealtime();
            const channel = new RecoveringChannel(
                realtime as unknown as Realtime,
                NAME,
                echoOptions(),
                {
                    ensureCapability: vi.fn().mockResolvedValue(undefined),
                    presenceInfo: () => undefined,
                } as unknown as TokenManager,
            );
            const callback = vi.fn();

            channel.error(callback);
            await settle(channel);

            const underlying = realtime.channels.all[NAME];
            const reason = { code: 40160, message: "not permitted" };

            underlying.emitStateChange({ current: "suspended", reason });

            expect(failures).toEqual([]);
            expect(callback).toHaveBeenCalledTimes(1);

            underlying.emitStateChange({ current: "failed", reason });

            // Claimed by the subclass, so it is not surfaced a second time.
            expect(failures).toEqual([{ current: "failed", reason }]);
            expect(callback).toHaveBeenCalledTimes(1);
        });
    });

    describe("unsubscribe", () => {
        it("removes listeners, the state listener and detaches", async () => {
            const { channel, underlying } = setup();

            await settle(channel);
            channel.unsubscribe();
            await settle(channel);

            expect(underlying().unsubscribe).toHaveBeenCalledWith();
            expect(underlying().off).toHaveBeenCalled();
            expect(underlying().detach).toHaveBeenCalled();
        });
    });

    describe("readiness", () => {
        it("applies listener registrations made before the channel is ready", async () => {
            const gate = deferred<void>();
            const { channel, realtime } = setup({
                ensureCapability: vi.fn().mockReturnValue(gate.promise),
            });
            const callback = vi.fn();

            channel.listen(".OrderShipped", callback);
            expect(realtime.channels.get).not.toHaveBeenCalled();

            gate.resolve();
            await settle(channel);

            expect(realtime.channels.all[NAME].subscribe).toHaveBeenCalledWith(
                "OrderShipped",
                expect.any(Function),
            );

            realtime.channels.all[NAME].emitMessage({
                name: "OrderShipped",
                data: "payload",
            });

            expect(callback).toHaveBeenCalledWith("payload");
        });
    });
});
