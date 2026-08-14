import type { Realtime } from "ably";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { TokenManager } from "../src/auth/token-manager";
import { AblyChannel } from "../src/channels/ably-channel";
import type { NormalizedReplay } from "../src/replay/types";
import {
    CHANNEL_NAME as NAME,
    deferred,
    echoOptions,
    noopListener,
    settle,
    withoutUnhandledRejections,
} from "./helpers";
import type {
    MockChannel,
    MockHistoryMessage,
    MockMessage,
    MockRealtime,
} from "./mocks/ably";
import { createMockRealtime, historyPages } from "./mocks/ably";

/** Replay on, at the limit the connector normalizes to by default. */
const REPLAY_ON: NormalizedReplay = { enabled: true, limit: 100 };

type Harness = {
    realtime: MockRealtime;
    channel: AblyChannel;
    underlying: () => MockChannel;
};

/**
 * A channel on its own mock realtime, built here rather than through
 * `setupChannel`: only these tests pass a replay config, which the connector
 * does not plumb yet.
 */
function setup(
    replay?: NormalizedReplay,
    ensureCapability: Mock = vi.fn().mockResolvedValue(undefined),
): Harness {
    const realtime = createMockRealtime();
    const tokenManager = {
        ensureCapability,
        presenceInfo: vi.fn().mockReturnValue(undefined),
    } as unknown as TokenManager;

    const channel = new AblyChannel(
        realtime as unknown as Realtime,
        NAME,
        echoOptions(),
        tokenManager,
        replay,
    );

    return {
        realtime,
        channel,
        underlying: () => realtime.channels.all[NAME],
    };
}

/** A message ably delivered without a name — `InboundMessage.name` is optional. */
function nameless(data: unknown): MockMessage {
    return { data } as unknown as MockMessage;
}

/** A history item, stamped `offset` ms after an arbitrary base time. */
function historyMessage(id: string, offset: number): MockHistoryMessage {
    return {
        id,
        name: "App\\Events\\OrderShipped",
        data: { id },
        timestamp: 1_700_000_000_000 + offset,
    };
}

/**
 * Register the same listeners on a replay-mode channel and a default-mode one,
 * deliver the same messages to both, and hand back what each recorded. The two
 * transcripts must not be distinguishable.
 */
async function bothModes(
    register: (
        channel: AblyChannel,
        seen: (...args: unknown[]) => void,
    ) => void,
    emit: (channel: MockChannel) => void,
): Promise<{ replay: unknown[][]; standard: unknown[][] }> {
    const run = async (replay?: NormalizedReplay) => {
        const calls: unknown[][] = [];
        const { channel, underlying } = setup(replay);

        register(channel, (...args: unknown[]) => calls.push(args));
        await settle(channel);

        emit(underlying());

        return calls;
    };

    return { replay: await run(REPLAY_ON), standard: await run() };
}

describe("AblyChannel replay-mode routing", () => {
    describe("formatting parity with the default path", () => {
        it("delivers listen() events keyed by the formatted event name", async () => {
            const { replay, standard } = await bothModes(
                (channel, seen) => {
                    channel.listen(".OrderShipped", (data: unknown) =>
                        seen("dot", data),
                    );
                    channel.listen("OrderShipped", (data: unknown) =>
                        seen("namespaced", data),
                    );
                },
                (mock) => {
                    mock.emitMessage({ name: "OrderShipped", data: { id: 1 } });
                    mock.emitMessage({
                        name: "App\\Events\\OrderShipped",
                        data: { id: 2 },
                    });
                    mock.emitMessage({ name: "OrderCreated", data: { id: 3 } });
                },
            );

            expect(replay).toEqual([
                ["dot", { id: 1 }],
                ["namespaced", { id: 2 }],
            ]);
            expect(replay).toEqual(standard);
        });

        it("round-trips whispers, notifications and raw on() names", async () => {
            const { replay, standard } = await bothModes(
                (channel, seen) => {
                    channel.listenForWhisper("typing", (data: unknown) =>
                        seen("whisper", data),
                    );
                    channel.notification((data: unknown) =>
                        seen("notification", data),
                    );
                    channel.on("client-raw", (data: unknown) =>
                        seen("raw", data),
                    );
                },
                (mock) => {
                    mock.emitMessage({
                        name: "client-typing",
                        data: { user: 1 },
                    });
                    mock.emitMessage({
                        name: "Illuminate\\Notifications\\Events\\BroadcastNotificationCreated",
                        data: { type: "invoice" },
                    });
                    mock.emitMessage({ name: "client-raw", data: "raw" });
                },
            );

            expect(replay).toEqual([
                ["whisper", { user: 1 }],
                ["notification", { type: "invoice" }],
                ["raw", "raw"],
            ]);
            expect(replay).toEqual(standard);
        });

        it("hands listenToAll the namespace-stripped event name", async () => {
            const { replay, standard } = await bothModes(
                (channel, seen) => {
                    channel.listenToAll((event: unknown, data: unknown) =>
                        seen(event, data),
                    );
                },
                (mock) => {
                    mock.emitMessage({
                        name: "App\\Events\\OrderShipped",
                        data: { id: 1 },
                    });
                    mock.emitMessage({ name: "SomeEvent", data: { id: 2 } });
                    mock.emitMessage({
                        name: "client-typing",
                        data: { id: 3 },
                    });
                    mock.emitMessage(nameless("no name"));
                },
            );

            expect(replay).toEqual([
                ["OrderShipped", { id: 1 }],
                [".SomeEvent", { id: 2 }],
                [".client-typing", { id: 3 }],
                [".", "no name"],
            ]);
            expect(replay).toEqual(standard);
        });

        it("delivers to a listen() callback and a listenToAll one at once", async () => {
            const { replay, standard } = await bothModes(
                (channel, seen) => {
                    channel.listen(".OrderShipped", (data: unknown) =>
                        seen("scoped", data),
                    );
                    channel.listenToAll((event: unknown, data: unknown) =>
                        seen("global", event, data),
                    );
                },
                (mock) => {
                    mock.emitMessage({
                        name: "OrderShipped",
                        data: "payload",
                    });
                },
            );

            expect(replay).toEqual([
                ["scoped", "payload"],
                ["global", ".OrderShipped", "payload"],
            ]);
            expect(replay).toEqual(standard);
        });
    });

    describe("subscription bookkeeping", () => {
        it("registers exactly one catch-all however many listeners there are", async () => {
            const { channel, underlying } = setup(REPLAY_ON);

            channel.listen(".OrderShipped", noopListener());
            channel.listen(".OrderCreated", noopListener());
            channel.listenToAll(noopListener());
            channel.on("client-typing", noopListener());
            await settle(channel);

            expect(underlying().subscribe).toHaveBeenCalledTimes(1);
            // One argument only: a catch-all, not a per-event registration.
            expect(underlying().subscribe).toHaveBeenCalledWith(
                expect.any(Function),
            );
        });

        it("does not register a second catch-all when subscribe runs again", async () => {
            const { channel, underlying } = setup(REPLAY_ON);
            const callback = vi.fn();

            channel.listen(".OrderShipped", callback);
            await settle(channel);

            await channel.subscribe();
            await settle(channel);

            expect(underlying().subscribe).toHaveBeenCalledTimes(1);

            underlying().emitMessage({
                name: "OrderShipped",
                data: "payload",
            });

            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("never leaks an unhandled rejection when the catch-all is refused", async () => {
            const rejections = await withoutUnhandledRejections(async () => {
                const { channel, realtime } = setup(REPLAY_ON);
                // The ably channel does not exist yet — `subscribe()` is still
                // suspended on its first await — so it is created here first.
                const mock = realtime.channels.get(NAME);

                // A plain function rather than `mockRejectedValue`: vitest
                // tracks what its own mocks return, which marks the rejection
                // handled and would hide the leak this asserts against.
                mock.subscribe = (() =>
                    Promise.reject(
                        new Error("attach on subscribe failed"),
                    )) as unknown as typeof mock.subscribe;

                await settle(channel);
            });

            expect(rejections).toEqual([]);
        });

        it("keeps listener bookkeeping off the ably channel entirely", async () => {
            const { channel, underlying } = setup(REPLAY_ON);
            const removed = vi.fn();
            const kept = vi.fn();
            const global = vi.fn();

            channel.listen(".OrderShipped", removed);
            channel.listen(".OrderShipped", kept);
            channel.listenToAll(global);
            await settle(channel);

            channel.stopListening(".OrderShipped", removed);
            channel.stopListeningToAll(global);
            await settle(channel);

            underlying().emitMessage({
                name: "OrderShipped",
                data: "payload",
            });

            expect(removed).not.toHaveBeenCalled();
            expect(global).not.toHaveBeenCalled();
            expect(kept).toHaveBeenCalledWith("payload");
            // The catch-all is the only ably-side subscription, and nothing
            // above it was ever registered for ably to remove.
            expect(underlying().subscribe).toHaveBeenCalledTimes(1);
            expect(underlying().unsubscribe).not.toHaveBeenCalled();
        });

        it("stops every callback for an event when no callback is given", async () => {
            const { channel, underlying } = setup(REPLAY_ON);
            const first = vi.fn();
            const second = vi.fn();

            channel.listen(".OrderShipped", first);
            channel.listen(".OrderShipped", second);
            await settle(channel);

            channel.stopListening(".OrderShipped");
            await settle(channel);

            underlying().emitMessage({
                name: "OrderShipped",
                data: "payload",
            });

            expect(first).not.toHaveBeenCalled();
            expect(second).not.toHaveBeenCalled();
            expect(underlying().unsubscribe).not.toHaveBeenCalled();
        });

        it("removes every global callback when no callback is given", async () => {
            const { channel, underlying } = setup(REPLAY_ON);
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
            expect(underlying().unsubscribe).not.toHaveBeenCalled();
        });
    });

    describe("unsubscribe", () => {
        it("removes its own catch-all and stops delivering", async () => {
            const { channel, underlying } = setup(REPLAY_ON);
            const scoped = vi.fn();
            const global = vi.fn();

            channel.listen(".OrderShipped", scoped);
            channel.listenToAll(global);
            await settle(channel);

            const catchAll = underlying().subscribe.mock.calls[0][0];

            channel.unsubscribe();
            await settle(channel);

            // Exactly this instance's listener, not a channel-wide wipe that
            // would take a successor instance's catch-all with it.
            expect(underlying().unsubscribe).toHaveBeenCalledTimes(1);
            expect(underlying().unsubscribe).toHaveBeenCalledWith(catchAll);
            expect(underlying().detach).toHaveBeenCalled();

            underlying().emitMessage({
                name: "OrderShipped",
                data: "payload",
            });

            expect(scoped).not.toHaveBeenCalled();
            expect(global).not.toHaveBeenCalled();
        });

        it("removes the catch-all registered by a subscribe it raced", async () => {
            const gate = deferred<void>();
            const { channel, underlying } = setup(
                REPLAY_ON,
                vi.fn().mockReturnValue(gate.promise),
            );

            channel.listen(".OrderShipped", noopListener());
            // Teardown queued while `subscribe()` still waits for its token:
            // the catch-all it registers afterwards must still come off.
            channel.unsubscribe();

            gate.resolve();
            await settle(channel);

            const catchAll = underlying().subscribe.mock.calls[0][0];

            expect(underlying().unsubscribe).toHaveBeenCalledWith(catchAll);
        });
    });

    describe("default mode", () => {
        it("still registers and removes per-event ably subscriptions", async () => {
            const { channel, underlying } = setup();

            channel.listen(".OrderShipped", noopListener());
            channel.listenToAll(noopListener());
            await settle(channel);

            expect(underlying().subscribe).toHaveBeenCalledWith(
                "OrderShipped",
                expect.any(Function),
            );
            expect(underlying().subscribe).toHaveBeenCalledTimes(2);

            channel.stopListening(".OrderShipped");
            await settle(channel);

            expect(underlying().unsubscribe).toHaveBeenCalledWith(
                "OrderShipped",
            );
        });
    });

    describe("mock history harness", () => {
        it("resolves an empty page by default", async () => {
            const { channel, underlying } = setup(REPLAY_ON);
            await settle(channel);

            const page = await underlying().history({ untilAttach: true });

            expect(page.items).toEqual([]);
            expect(page.hasNext()).toBe(false);
            await expect(page.next()).resolves.toBeNull();
        });

        it("chains historyPages into a paginated walk", async () => {
            const first = historyMessage("m1", 0);
            const second = historyMessage("m2", 1);
            const page = historyPages([[first], [second]]);

            expect(page.items).toEqual([first]);
            expect(page.hasNext()).toBe(true);

            const next = await page.next();

            expect(next?.items).toEqual([second]);
            expect(next?.hasNext()).toBe(false);
            await expect(next?.next()).resolves.toBeNull();
        });
    });
});
