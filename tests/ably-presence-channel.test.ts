import { describe, expect, it, vi } from "vitest";
import { AblyPresenceChannel } from "../src/channels/ably-presence-channel";
import type { ChannelHarness, ChannelOverrides } from "./helpers";
import {
    deferred,
    noopListener,
    settle,
    setupChannel,
    withoutUnhandledRejections,
} from "./helpers";

/** Presence channels carry the `presence:` prefix the name mapper produces. */
const NAME = "presence:orders";

/** What `/broadcasting/auth` returned as this member's `info` payload. */
const MEMBER = { id: 1, name: "Taylor" };

function setup(
    overrides: ChannelOverrides = {},
): ChannelHarness<AblyPresenceChannel> {
    return setupChannel(AblyPresenceChannel, { name: NAME, ...overrides });
}

describe("AblyPresenceChannel", () => {
    describe("entering the presence set", () => {
        it("enters with the member info the auth response carried", async () => {
            const { channel, presenceInfo, underlying } = setup({
                presenceInfo: vi.fn().mockReturnValue(MEMBER),
            });

            await settle(channel);

            expect(presenceInfo).toHaveBeenCalledWith(NAME);
            expect(underlying().presence.enter).toHaveBeenCalledWith(MEMBER);
        });

        it("enters again on every attach, so a recovered connection is present again", async () => {
            const { channel, underlying } = setup({
                presenceInfo: vi.fn().mockReturnValue(MEMBER),
            });

            await settle(channel);

            expect(underlying().presence.enter).toHaveBeenCalledTimes(1);

            underlying().emitStateChange({
                current: "attached",
                previous: "attaching",
            });
            await settle(channel);

            expect(underlying().presence.enter).toHaveBeenCalledTimes(2);
        });

        it("enters without data when the capability came from a wildcard grant", async () => {
            // A token granted through `*` carries no per-channel `info`, so
            // `presenceInfo` has nothing to hand over. Entering with no data is
            // valid ably usage, and beats not entering at all.
            const { channel, underlying } = setup();

            await settle(channel);

            expect(underlying().presence.enter).toHaveBeenCalledWith(undefined);
        });

        it("reads the member list only once the enter has been acknowledged", async () => {
            // Ably's presence set does not carry a member whose enter is still
            // in flight: a read racing it comes back without this member in it.
            const { channel, realtime, underlying } = setup();
            const entered = deferred<void>();

            realtime.channels
                .get(NAME)
                .presence.enter.mockReturnValue(entered.promise);
            channel.here(noopListener());

            await settle(channel);

            expect(underlying().presence.get).not.toHaveBeenCalled();

            entered.resolve();
            await settle(channel);

            expect(underlying().presence.get).toHaveBeenCalledTimes(1);
        });

        it("routes an enter rejection to error callbacks without an unhandled rejection", async () => {
            const failure = new Error("presence refused");
            const callback = vi.fn();

            const rejections = await withoutUnhandledRejections(async () => {
                const { channel, realtime } = setup();

                // The ably channel does not exist yet — `subscribe()` is still
                // suspended on its first await — so it is created here first.
                realtime.channels
                    .get(NAME)
                    .presence.enter.mockRejectedValue(failure);
                channel.error(callback);

                await settle(channel);
            });

            expect(callback).toHaveBeenCalledWith(failure);
            expect(rejections).toEqual([]);
        });
    });

    describe("here", () => {
        it("hands over the member list on every attach", async () => {
            const { channel, realtime, underlying } = setup();
            const callback = vi.fn();

            realtime.channels.get(NAME).presence.get.mockResolvedValue([
                { clientId: "u1", data: { id: 1 } },
                { clientId: "u2", data: { id: 2 } },
            ]);

            expect(channel.here(callback)).toBe(channel);
            await settle(channel);

            expect(callback).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }]);

            underlying().emitStateChange({ current: "attached" });
            await settle(channel);

            expect(callback).toHaveBeenCalledTimes(2);
        });

        it("does not re-read the member list when members come and go", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.here(callback);
            // Registered so the presence events below are actually delivered
            // somewhere, rather than falling on an empty registry.
            channel.joining(noopListener());
            channel.leaving(noopListener());
            await settle(channel);

            expect(underlying().presence.get).toHaveBeenCalledTimes(1);
            callback.mockClear();

            underlying().presence.emit("enter", {
                clientId: "u2",
                data: { id: 2 },
            });
            underlying().presence.emit("leave", {
                clientId: "u2",
                data: { id: 2 },
            });
            await settle(channel);

            // Pusher parity: `here` is the subscription-succeeded snapshot, not
            // a feed of the membership changes that follow it.
            expect(underlying().presence.get).toHaveBeenCalledTimes(1);
            expect(callback).not.toHaveBeenCalled();
        });

        it("gives every registered callback the same member list, read once", async () => {
            const { channel, realtime, underlying } = setup();
            const first = vi.fn();
            const second = vi.fn();

            realtime.channels
                .get(NAME)
                .presence.get.mockResolvedValue([
                    { clientId: "u1", data: { id: 1 } },
                ]);

            channel.here(first);
            channel.here(second);
            await settle(channel);

            expect(first).toHaveBeenCalledWith([{ id: 1 }]);
            expect(second).toHaveBeenCalledWith([{ id: 1 }]);
            expect(underlying().presence.get).toHaveBeenCalledTimes(1);
        });

        it("does not read the member list when nobody asked for it", async () => {
            const { channel, underlying } = setup();

            await settle(channel);

            expect(underlying().presence.get).not.toHaveBeenCalled();
        });

        it("routes a member list rejection to error callbacks without an unhandled rejection", async () => {
            const failure = new Error("presence set unavailable");
            const callback = vi.fn();

            const rejections = await withoutUnhandledRejections(async () => {
                const { channel, realtime } = setup();

                realtime.channels
                    .get(NAME)
                    .presence.get.mockRejectedValue(failure);
                channel.error(callback);
                channel.here(noopListener());

                await settle(channel);
            });

            expect(callback).toHaveBeenCalledWith(failure);
            expect(rejections).toEqual([]);
        });
    });

    describe("joining and leaving", () => {
        it("reports members that enter or update, and not the ones that leave", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            expect(channel.joining(callback)).toBe(channel);
            await settle(channel);

            expect(underlying().presence.subscribe).toHaveBeenCalledWith(
                ["enter", "update"],
                expect.any(Function),
            );

            underlying().presence.emit("enter", {
                clientId: "u1",
                data: { id: 1 },
            });
            underlying().presence.emit("update", {
                clientId: "u1",
                data: { id: 1, status: "away" },
            });
            underlying().presence.emit("leave", {
                clientId: "u1",
                data: { id: 1 },
            });

            expect(callback.mock.calls).toEqual([
                [{ id: 1 }],
                [{ id: 1, status: "away" }],
            ]);
        });

        it("reports members that leave, and not the ones that arrive", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            expect(channel.leaving(callback)).toBe(channel);
            await settle(channel);

            expect(underlying().presence.subscribe).toHaveBeenCalledWith(
                "leave",
                expect.any(Function),
            );

            underlying().presence.emit("enter", {
                clientId: "u1",
                data: { id: 1 },
            });
            underlying().presence.emit("update", {
                clientId: "u1",
                data: { id: 1, status: "away" },
            });
            underlying().presence.emit("leave", {
                clientId: "u1",
                data: { id: 1 },
            });

            expect(callback.mock.calls).toEqual([[{ id: 1 }]]);
        });

        it("routes a presence subscribe rejection to error callbacks without an unhandled rejection", async () => {
            const failure = new Error("presence subscribe refused");
            const callback = vi.fn();

            const rejections = await withoutUnhandledRejections(async () => {
                const { channel, realtime } = setup();

                realtime.channels
                    .get(NAME)
                    .presence.subscribe.mockRejectedValue(failure);
                channel.error(callback);
                channel.joining(noopListener());

                await settle(channel);
            });

            expect(callback).toHaveBeenCalledWith(failure);
            expect(rejections).toEqual([]);
        });
    });

    describe("unsubscribe", () => {
        it("leaves the presence set and drops presence listeners before detaching", async () => {
            const { channel, underlying } = setup();

            await settle(channel);
            channel.unsubscribe();
            await settle(channel);

            const presence = underlying().presence;

            expect(presence.leave).toHaveBeenCalled();
            expect(presence.unsubscribe).toHaveBeenCalledWith();
            expect(underlying().detach).toHaveBeenCalled();

            // leave → unsubscribe → detach: the member is out of the presence
            // set before the channel that would have carried its leave message
            // is gone.
            expect(presence.leave.mock.invocationCallOrder[0]).toBeLessThan(
                presence.unsubscribe.mock.invocationCallOrder[0],
            );
            expect(
                presence.unsubscribe.mock.invocationCallOrder[0],
            ).toBeLessThan(underlying().detach.mock.invocationCallOrder[0]);
        });

        it("stops delivering presence events once torn down", async () => {
            const { channel, underlying } = setup();
            const joining = vi.fn();

            channel.joining(joining);
            await settle(channel);

            channel.unsubscribe();
            await settle(channel);

            underlying().presence.emit("enter", {
                clientId: "u1",
                data: { id: 1 },
            });

            expect(joining).not.toHaveBeenCalled();
        });

        it("drops here registrations, so a later re-subscribe does not resurrect them", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.here(callback);
            await settle(channel);

            channel.unsubscribe();
            await settle(channel);

            underlying().presence.get.mockClear();
            await channel.subscribe();
            await settle(channel);

            expect(underlying().presence.get).not.toHaveBeenCalled();
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("swallows a leave rejection instead of reporting a channel it is done with", async () => {
            const callback = vi.fn();

            const rejections = await withoutUnhandledRejections(async () => {
                const { channel, realtime } = setup();

                realtime.channels
                    .get(NAME)
                    .presence.leave.mockRejectedValue(new Error("not here"));
                channel.error(callback);

                await settle(channel);
                channel.unsubscribe();
                await settle(channel);
            });

            // Same treatment the base gives a failed `detach()`: a teardown the
            // caller is not waiting on has nothing worth surfacing.
            expect(callback).not.toHaveBeenCalled();
            expect(rejections).toEqual([]);
        });
    });
});
