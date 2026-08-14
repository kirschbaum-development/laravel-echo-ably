import type { ChannelStateChange, Realtime, RealtimeChannel } from "ably";
import type { TokenManager } from "../auth/token-manager";
import type { NormalizedReplay } from "../replay/types";
import type { EchoOptionsWithDefaults } from "../types";
import { AblyChannel } from "./ably-channel";

/**
 * Ably's "the token does not grant this channel" error code. It is what a
 * stale capability looks like: the channel itself is fine, the token is not.
 */
const CAPABILITY_REJECTED = 40160;

/**
 * A private Ably channel: a public channel that can also whisper, and that
 * treats a capability rejection as something to fix rather than report.
 */
export class AblyPrivateChannel extends AblyChannel {
    /**
     * Whether this attach cycle already spent its capability retry. A
     * successful attach clears it, so a rejection arriving on a channel that
     * had been working gets a silent retry of its own.
     */
    private capabilityRetrySpent = false;

    /**
     * Create a new class instance.
     */
    constructor(
        ably: Realtime,
        name: string,
        options: EchoOptionsWithDefaults,
        tokenManager: TokenManager,
        replay?: NormalizedReplay,
    ) {
        super(ably, name, options, tokenManager, replay);

        // Every `attached` transition ends a retry cycle, including ones this
        // channel did not initiate (an ably-driven reattach, a re-subscribe
        // after a connection recovery).
        this.subscribed(() => {
            this.capabilityRetrySpent = false;
        });
    }

    /**
     * Send a whisper event to the other clients on the channel.
     */
    whisper(eventName: string, data: Record<string, unknown>): this {
        this.whenReady((channel) =>
            channel
                // The raw name, deliberately unformatted: this is what Echo's
                // inherited `listenForWhisper` subscribes to, via `listen`'s
                // leading-dot namespace bypass.
                .publish(`client-${eventName}`, data)
                // `whenReady` swallows chain rejections, so a refused publish
                // is reported from here or not at all.
                .catch((error: unknown) => this.dispatchError(error)),
        );

        return this;
    }

    /**
     * Claim a capability rejection, once. The token is upgraded and the
     * channel re-attached behind the caller's back; a second consecutive
     * rejection is left to the error callbacks, since retrying it again would
     * only produce the same answer.
     */
    protected onChannelFailed(change: ChannelStateChange): boolean {
        if (
            this.capabilityRetrySpent ||
            change.reason?.code !== CAPABILITY_REJECTED
        ) {
            return false;
        }

        this.capabilityRetrySpent = true;

        this.whenReady((channel) => this.upgradeCapability(channel));

        return true;
    }

    /**
     * Force a fresh token for this channel, then attach with it.
     */
    private async upgradeCapability(channel: RealtimeChannel): Promise<void> {
        try {
            await this.tokenManager.ensureCapability(this.name, {
                force: true,
            });
        } catch (error) {
            // A failed upgrade never becomes a channel state, so nothing else
            // would ever report it.
            this.dispatchError(error);

            return;
        }

        // A re-attach that fails comes back through `onChannelFailed` with the
        // retry spent, which is where it surfaces; the rejection paired with
        // that state change is swallowed by `whenReady`.
        await channel.attach();
    }
}
