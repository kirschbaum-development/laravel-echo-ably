import { describe, expect, it, vi } from "vitest";
import { AblyPrivateChannel } from "../src/channels/ably-private-channel";
import type { ChannelHarness, ChannelOverrides } from "./helpers";
import {
    CHANNEL_NAME as NAME,
    deferred,
    noopListener,
    settle,
    setupChannel,
    withoutUnhandledRejections,
} from "./helpers";

/** A capability rejection: the token does not grant this channel. */
const REJECTION = { code: 40160, message: "not permitted" };

function setup(
    overrides: ChannelOverrides = {},
): ChannelHarness<AblyPrivateChannel> {
    return setupChannel(AblyPrivateChannel, overrides);
}

describe("AblyPrivateChannel", () => {
    describe("whisper", () => {
        it("publishes the raw client-prefixed event name once the channel is ready", async () => {
            const gate = deferred<void>();
            const { channel, realtime, underlying } = setup({
                ensureCapability: vi.fn().mockReturnValue(gate.promise),
            });

            expect(channel.whisper("typing", { a: 1 })).toBe(channel);
            // Nothing is published against a channel that does not exist yet.
            expect(realtime.channels.get).not.toHaveBeenCalled();

            gate.resolve();
            await settle(channel);

            // Raw: the namespace formatter would have made this
            // `client-App\Events\typing`.
            expect(underlying().publish).toHaveBeenCalledWith("client-typing", {
                a: 1,
            });
        });

        it("routes a publish rejection to error callbacks without an unhandled rejection", async () => {
            const failure = new Error("publish refused");
            const callback = vi.fn();

            const rejections = await withoutUnhandledRejections(async () => {
                const { channel, realtime } = setup();

                // The ably channel does not exist yet — `subscribe()` is still
                // suspended on its first await — so it is created here first.
                realtime.channels.get(NAME).publish.mockRejectedValue(failure);
                channel.error(callback);
                channel.whisper("typing", {});

                await settle(channel);
            });

            expect(callback).toHaveBeenCalledWith(failure);
            expect(rejections).toEqual([]);
        });
    });

    describe("listenForWhisper", () => {
        it("delivers whispers to the callback", async () => {
            const { channel, underlying } = setup();
            const callback = vi.fn();

            channel.listenForWhisper("typing", callback);
            await settle(channel);

            underlying().emitMessage({
                name: "client-typing",
                data: { a: 1 },
            });

            expect(callback).toHaveBeenCalledWith({ a: 1 });
        });

        it("subscribes to the very name whisper publishes under", async () => {
            const { channel, underlying } = setup();

            channel.listenForWhisper("typing", noopListener());
            channel.whisper("typing", { a: 1 });
            await settle(channel);

            expect(underlying().subscribe.mock.calls[0][0]).toBe(
                underlying().publish.mock.calls[0][0],
            );
        });
    });

    describe("capability rejections", () => {
        it("upgrades the token once and re-attaches, without surfacing the failure", async () => {
            const { channel, realtime, ensureCapability, underlying } = setup();
            const error = vi.fn();
            const subscribed = vi.fn();

            realtime.channels.get(NAME).failAttach(REJECTION);
            channel.error(error);
            channel.subscribed(subscribed);

            await settle(channel);

            expect(ensureCapability.mock.calls).toEqual([
                [NAME],
                [NAME, { force: true }],
            ]);
            expect(underlying().attach).toHaveBeenCalledTimes(2);
            // Silent: neither the state change nor the paired attach rejection
            // reaches the error callbacks, and the re-attach succeeded.
            expect(error).not.toHaveBeenCalled();
            expect(subscribed).toHaveBeenCalledTimes(1);
        });

        it("surfaces a second consecutive rejection without a second upgrade", async () => {
            const { channel, ensureCapability, underlying } = setup();
            const error = vi.fn();

            channel.error(error);
            await settle(channel);

            // The re-attach the retry performs fails the same way.
            underlying().failAttach(REJECTION);
            underlying().emitStateChange({
                current: "failed",
                previous: "attached",
                reason: REJECTION,
            });

            await settle(channel);

            expect(ensureCapability.mock.calls).toEqual([
                [NAME],
                [NAME, { force: true }],
            ]);
            expect(underlying().attach).toHaveBeenCalledTimes(2);
            expect(error).toHaveBeenCalledTimes(1);
            expect(error).toHaveBeenCalledWith(REJECTION);
        });

        it("retries again once a successful attach has cleared the latch", async () => {
            const { channel, ensureCapability, underlying } = setup();
            const error = vi.fn();

            channel.error(error);
            await settle(channel);

            underlying().emitStateChange({
                current: "failed",
                reason: REJECTION,
            });
            await settle(channel);

            // The re-attach succeeded, so the channel is attached again.
            expect(ensureCapability).toHaveBeenCalledTimes(2);
            expect(error).not.toHaveBeenCalled();

            underlying().emitStateChange({
                current: "failed",
                reason: REJECTION,
            });
            await settle(channel);

            expect(ensureCapability).toHaveBeenCalledTimes(3);
            expect(ensureCapability).toHaveBeenLastCalledWith(NAME, {
                force: true,
            });
            expect(underlying().attach).toHaveBeenCalledTimes(3);
            expect(error).not.toHaveBeenCalled();
        });

        it("leaves failures that are not capability rejections to the error callbacks", async () => {
            const reason = { code: 80016, message: "connection failed" };
            const { channel, ensureCapability, underlying } = setup();
            const error = vi.fn();

            channel.error(error);
            await settle(channel);

            underlying().emitStateChange({ current: "failed", reason });
            await settle(channel);

            expect(ensureCapability).toHaveBeenCalledTimes(1);
            expect(underlying().attach).toHaveBeenCalledTimes(1);
            expect(error).toHaveBeenCalledWith(reason);
        });

        it("surfaces a failed token upgrade instead of re-attaching", async () => {
            const failure = new Error("auth endpoint exploded");
            const { channel, underlying } = setup({
                ensureCapability: vi
                    .fn()
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(failure),
            });
            const error = vi.fn();

            channel.error(error);
            await settle(channel);

            underlying().emitStateChange({
                current: "failed",
                reason: REJECTION,
            });
            await settle(channel);

            expect(error).toHaveBeenCalledTimes(1);
            expect(error).toHaveBeenCalledWith(failure);
            expect(underlying().attach).toHaveBeenCalledTimes(1);
        });
    });
});
