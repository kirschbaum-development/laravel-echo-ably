import type { Realtime } from "ably";
import { describe, expect, it, vi } from "vitest";
import type { TokenManager } from "../src/auth/token-manager";
import { AblyChannel } from "../src/channels/ably-channel";
import { AblyPresenceChannel } from "../src/channels/ably-presence-channel";
import { AblyPrivateChannel } from "../src/channels/ably-private-channel";
import type { NormalizedReplay } from "../src/replay/types";
import {
    CHANNEL_NAME,
    deferred,
    echoOptions,
    setupChannel,
    settle,
} from "./helpers";
import type {
    MockHistoryMessage,
    MockHistoryPage,
    MockMessage,
    MockRealtime,
} from "./mocks/ably";
import { historyPages } from "./mocks/ably";

/** Replay on, at the limit the connector normalizes to by default. */
const REPLAY_ON: NormalizedReplay = { enabled: true, limit: 100 };

const BASE_TIME = 1_700_000_000_000;

/**
 * A message carrying everything both the live path and a history page do,
 * stamped `offset` ms after an arbitrary base time.
 */
function message(id: string, offset: number): MockMessage & MockHistoryMessage {
    return {
        id,
        name: "App\\Events\\OrderShipped",
        data: { id },
        timestamp: BASE_TIME + offset,
    };
}

/** A history item ably returned without a name — `name` is optional there. */
function nameless(id: string, offset: number): MockHistoryMessage {
    return { id, data: { id }, timestamp: BASE_TIME + offset };
}

/** The state change ably sends when a re-attach could not resume the last one. */
const GAP = { current: "attached", previous: "attaching", resumed: false };

/** The state change a re-attach that kept continuity sends. */
const RESUMED = { current: "attached", previous: "attaching", resumed: true };

/** Let every catch-up microtask run before asserting on what it did. */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The `id` of every message that reached a `listen()` callback. */
function ids(seen: unknown[]): string[] {
    return seen.map((data) => (data as { id: string }).id);
}

/**
 * A second driver instance on the channel `realtime` has already handed out —
 * the leave→rejoin case, where `channels.get` caches and both instances end up
 * on one `RealtimeChannel`.
 */
function rejoin(realtime: MockRealtime): AblyChannel {
    const tokenManager = {
        ensureCapability: vi.fn().mockResolvedValue(undefined),
        presenceInfo: vi.fn().mockReturnValue(undefined),
    } as unknown as TokenManager;

    return new AblyChannel(
        realtime as unknown as Realtime,
        CHANNEL_NAME,
        echoOptions(),
        tokenManager,
        REPLAY_ON,
    );
}

describe("AblyChannel replay wiring", () => {
    describe("message flow", () => {
        it("routes live messages to the listener maps and anchors the cursor on the last", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const seen: unknown[] = [];

            channel.listen("OrderShipped", (data: unknown) => seen.push(data));
            await settle(channel);

            underlying().emitMessage(message("m1", 0));
            underlying().emitMessage(message("m2", 5));

            expect(ids(seen)).toEqual(["m1", "m2"]);

            await channel.replayMissed();

            // The cursor is the last message delivered, which is what a manual
            // catch-up queries forwards from.
            expect(underlying().history).toHaveBeenCalledWith({
                start: BASE_TIME + 5,
                direction: "forwards",
                limit: 100,
            });
        });

        it("advances the cursor on replayed messages too", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });

            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().history.mockResolvedValue(
                historyPages([[message("m1", 10), message("m0", 0)]]),
            );

            underlying().emitStateChange(GAP);
            await flush();

            await channel.replayMissed();

            expect(underlying().history).toHaveBeenLastCalledWith({
                start: BASE_TIME + 10,
                direction: "forwards",
                limit: 100,
            });
        });
    });

    describe("gap detection", () => {
        it("does not catch up on the first attach, though ably reports it unresumed", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const recovered = vi.fn();

            channel.recovered(recovered);
            await settle(channel);
            await flush();

            expect(underlying().history).not.toHaveBeenCalled();
            expect(recovered).not.toHaveBeenCalled();
        });

        it("does not catch up when the re-attach resumed the previous one", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const recovered = vi.fn();

            channel.recovered(recovered);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().emitStateChange(RESUMED);
            await flush();

            expect(underlying().history).not.toHaveBeenCalled();
            expect(recovered).not.toHaveBeenCalled();
        });

        it("catches up exactly once when a re-attach reports lost continuity", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const recovered = vi.fn();

            channel.recovered(recovered);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().emitStateChange(GAP);
            await flush();

            expect(underlying().history).toHaveBeenCalledTimes(1);
            expect(underlying().history).toHaveBeenCalledWith({
                untilAttach: true,
                direction: "backwards",
                limit: 100,
            });
            expect(recovered).toHaveBeenCalledTimes(1);
        });
    });

    describe("leaving and rejoining the same channel", () => {
        it("treats the successor instance's first gap as a gap, not a first attach", async () => {
            const {
                realtime,
                channel: left,
                underlying,
            } = setupChannel(AblyChannel, { replay: REPLAY_ON });

            await settle(left);

            // The connector's teardown: the cache entry is dropped, and the
            // rejoin that follows lands on the very same ably channel.
            left.unsubscribe();

            const rejoined = rejoin(realtime);
            const attached = vi.fn();
            const recovered = vi.fn();

            rejoined.subscribed(attached);

            await settle(left);
            await settle(rejoined);

            // The premise: the channel was attached the whole way through, so
            // ably resolved the successor's attach without an event of its own.
            expect(underlying().state).toBe("attached");
            expect(attached).not.toHaveBeenCalled();

            rejoined.recovered(recovered);

            underlying().emitStateChange(GAP);
            await flush();

            // A real gap on an instance that has delivered nothing yet: there
            // is no cursor to heal from, but the app still has to hear that it
            // must refetch. Reading this as a first attach would say nothing.
            expect(recovered).toHaveBeenCalledTimes(1);
            expect(recovered).toHaveBeenCalledWith({
                complete: false,
                count: 0,
            });
        });
    });

    describe("healing a gap", () => {
        it("replays the backlog in order, ahead of a live message that arrived mid-catch-up", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const seen: unknown[] = [];
            const recovered = vi.fn();
            const cursor = message("m0", 0);
            const pages = deferred<MockHistoryPage>();

            channel.listen("OrderShipped", (data: unknown) => seen.push(data));
            channel.recovered(recovered);
            await settle(channel);

            underlying().emitMessage(cursor);
            underlying().history.mockReturnValue(pages.promise);

            underlying().emitStateChange(GAP);

            // After the gate closed and before history answers: this one must
            // land behind the backlog it arrived in front of.
            underlying().emitMessage(message("live", 40));

            expect(ids(seen)).toEqual(["m0"]);

            // Newest first over two pages, ending on the cursor.
            pages.resolve(
                historyPages([
                    [message("m3", 30), message("m2", 20)],
                    [message("m1", 10), cursor],
                ]),
            );
            await flush();

            expect(ids(seen)).toEqual(["m0", "m1", "m2", "m3", "live"]);
            expect(recovered).toHaveBeenCalledTimes(1);
            expect(recovered).toHaveBeenCalledWith({
                complete: true,
                count: 3,
            });
        });

        it("replays nothing and reports the channel unhealed when the cursor is not in history", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const seen: unknown[] = [];
            const recovered = vi.fn();
            const pages = deferred<MockHistoryPage>();

            channel.listen("OrderShipped", (data: unknown) => seen.push(data));
            channel.recovered(recovered);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().history.mockReturnValue(pages.promise);

            underlying().emitStateChange(GAP);
            underlying().emitMessage(message("live", 40));

            // History that never reaches the cursor: the backlog cannot be
            // proven whole, so none of it is replayed.
            pages.resolve(
                historyPages([[message("m9", 90), message("m8", 80)]]),
            );
            await flush();

            // The live message still gets there — the flush is unconditional.
            expect(ids(seen)).toEqual(["m0", "live"]);
            expect(recovered).toHaveBeenCalledWith({
                complete: false,
                count: 0,
            });
        });

        it("gives a replayed message with no name the shape the live path gives it", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const seen: unknown[][] = [];
            const cursor = message("m0", 0);

            channel.listenToAll((event: unknown, data: unknown) =>
                seen.push([event, data]),
            );
            await settle(channel);

            underlying().emitMessage(cursor);
            underlying().history.mockResolvedValue(
                historyPages([[nameless("h1", 10), cursor]]),
            );

            underlying().emitStateChange(GAP);
            await flush();

            expect(seen).toEqual([
                ["OrderShipped", { id: "m0" }],
                // The same `name ?? ""` fallback the live path applies.
                [".", { id: "h1" }],
            ]);
        });
    });

    describe("recovered", () => {
        it("hands every registration the attempt's own result", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const first = vi.fn();
            const second = vi.fn();

            expect(channel.recovered(first)).toBe(channel);
            // Registered twice on purpose: no dedup, matching `subscribed()`.
            channel.recovered(second);
            channel.recovered(second);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().history.mockResolvedValue(
                historyPages([[message("m1", 10), message("m0", 0)]]),
            );

            underlying().emitStateChange(GAP);
            await flush();

            expect(first).toHaveBeenCalledTimes(1);
            expect(first).toHaveBeenCalledWith({
                complete: true,
                count: 1,
            });
            expect(second).toHaveBeenCalledTimes(2);
        });

        it("fans out once for a gap that joined a manual catch-up already running", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const recovered = vi.fn();
            const pages = deferred<MockHistoryPage>();

            channel.recovered(recovered);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().history.mockReturnValue(pages.promise);

            const manual = channel.replayMissed();

            // Coalesced into the manual attempt, which is mode-blind: one
            // attempt, so one result and one fan-out.
            underlying().emitStateChange(GAP);

            pages.resolve(historyPages([[message("m0", 0)]]));

            const result = await manual;
            await flush();

            expect(underlying().history).toHaveBeenCalledTimes(1);
            expect(recovered).toHaveBeenCalledTimes(1);
            expect(recovered.mock.calls[0][0]).toBe(result);
        });
    });

    describe("replayMissed", () => {
        it("rejects when replay is not configured", async () => {
            const { channel } = setupChannel(AblyChannel);

            await settle(channel);

            await expect(channel.replayMissed()).rejects.toThrow(
                /ably\.replay/,
            );
        });

        it("resolves with the result it fans out", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const seen: unknown[] = [];
            const recovered = vi.fn();

            channel.listen("OrderShipped", (data: unknown) => seen.push(data));
            channel.recovered(recovered);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().history.mockResolvedValue(
                historyPages([[message("m0", 0), message("m1", 10)]]),
            );

            const result = await channel.replayMissed();
            await flush();

            expect(result).toEqual({ complete: true, count: 1 });
            expect(ids(seen)).toEqual(["m0", "m1"]);
            expect(recovered).toHaveBeenCalledTimes(1);
            expect(recovered).toHaveBeenCalledWith(result);
        });
    });

    describe("failures", () => {
        it("reports a refused history request and resolves the channel unhealed", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const reason = { code: 40160, message: "no history capability" };
            const errors: unknown[] = [];
            const recovered = vi.fn();

            channel.error((error: unknown) => errors.push(error));
            channel.recovered(recovered);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().history.mockRejectedValue(reason);

            underlying().emitStateChange(GAP);
            await flush();

            expect(errors).toEqual([reason]);
            expect(recovered).toHaveBeenCalledTimes(1);
            expect(recovered).toHaveBeenCalledWith({
                complete: false,
                count: 0,
            });
        });
    });

    describe("unsubscribe", () => {
        it("clears the recovered registrations and resets the engine", async () => {
            const { channel, underlying } = setupChannel(AblyChannel, {
                replay: REPLAY_ON,
            });
            const recovered = vi.fn();

            channel.recovered(recovered);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));

            channel.unsubscribe();
            await settle(channel);

            const result = await channel.replayMissed();

            await flush();

            // No cursor left to anchor on, so nothing is even queried.
            expect(result).toEqual({ complete: false, count: 0 });
            expect(underlying().history).not.toHaveBeenCalled();
            expect(recovered).not.toHaveBeenCalled();
        });
    });

    describe("private channels", () => {
        it("treats the re-attach after a 40160 capability upgrade as a gap", async () => {
            const { channel, underlying } = setupChannel(AblyPrivateChannel, {
                replay: REPLAY_ON,
            });
            const seen: unknown[] = [];
            const recovered = vi.fn();

            channel.listen("OrderShipped", (data: unknown) => seen.push(data));
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().history.mockResolvedValue(
                historyPages([[message("m1", 10), message("m0", 0)]]),
            );
            channel.recovered(recovered);

            // The capability rejection the private channel retries behind the
            // caller's back. Its re-attach reports no continuity, which is a
            // gap like any other — deliberately, since the token upgrade tore
            // the attachment down.
            underlying().emitStateChange({
                current: "failed",
                previous: "attaching",
                reason: { code: 40160, message: "capability rejected" },
            });
            await settle(channel);
            await flush();

            expect(underlying().attach).toHaveBeenCalledTimes(2);
            expect(ids(seen)).toEqual(["m0", "m1"]);
            expect(recovered).toHaveBeenCalledTimes(1);
            expect(recovered).toHaveBeenCalledWith({
                complete: true,
                count: 1,
            });
        });
    });

    describe("presence channels", () => {
        it("replays a missed regular message while presence heals as before", async () => {
            const { channel, underlying } = setupChannel(AblyPresenceChannel, {
                replay: REPLAY_ON,
                name: "presence:chat",
            });
            const seen: unknown[] = [];
            const here = vi.fn();
            const recovered = vi.fn();

            channel.listen("OrderShipped", (data: unknown) => seen.push(data));
            channel.here(here);
            await settle(channel);

            underlying().emitMessage(message("m0", 0));
            underlying().history.mockResolvedValue(
                historyPages([[message("m1", 10), message("m0", 0)]]),
            );
            channel.recovered(recovered);

            underlying().emitStateChange(GAP);
            await settle(channel);
            await flush();

            expect(ids(seen)).toEqual(["m0", "m1"]);
            expect(recovered).toHaveBeenCalledTimes(1);
            expect(recovered).toHaveBeenCalledWith({
                complete: true,
                count: 1,
            });
            // Untouched: presence heals by re-entering and re-reading on every
            // attach, replay or no replay.
            expect(underlying().presence.enter).toHaveBeenCalledTimes(2);
            expect(underlying().presence.get).toHaveBeenCalledTimes(2);
            expect(here).toHaveBeenCalledTimes(2);
        });
    });
});
