import type {
    PresenceAction,
    PresenceMessage,
    Realtime,
    RealtimeChannel,
} from "ably";
import type { PresenceChannel } from "laravel-echo";
import type { TokenManager } from "../auth/token-manager";
import type { EchoOptionsWithDefaults } from "../types";
import { AblyPrivateChannel } from "./ably-private-channel";

/**
 * What Echo calls "joining". Ably reports a member who changes their data as an
 * `update`, which for a member list is the same news as an `enter`.
 */
const JOINING: PresenceAction[] = ["enter", "update"];

/**
 * A presence Ably channel: a private channel that also announces its own member
 * in the presence set and reports on the others.
 */
export class AblyPresenceChannel
    extends AblyPrivateChannel
    implements PresenceChannel
{
    /** The `here` callbacks, all served by a single read of the member list. */
    private hereCallbacks: CallableFunction[] = [];

    /**
     * The presence listeners this instance registered, kept so teardown can
     * remove exactly them: the underlying ably channel may be shared with a
     * successor instance, whose registrations a blanket `unsubscribe()` would
     * take with it.
     */
    private readonly presenceListeners: Array<{
        actions: PresenceAction[];
        listener: (member: PresenceMessage) => void;
    }> = [];

    /**
     * Create a new class instance.
     */
    constructor(
        ably: Realtime,
        name: string,
        options: EchoOptionsWithDefaults,
        tokenManager: TokenManager,
    ) {
        super(ably, name, options, tokenManager);

        // Presence is re-established on every `attached`, not just the first:
        // ably re-attaches on its own after a connection recovery, and a member
        // who is not re-entered there is silently absent from then on.
        this.subscribed(() =>
            this.whenReady(async (channel) => {
                // The member list is read only once the enter has been
                // acknowledged: ably's presence set does not carry a member
                // whose enter is still in flight, so a read racing it would
                // hand `here()` a list this member is missing from. A refused
                // enter is reported and then read past, so `here()` still
                // describes whoever else is there.
                await this.enter(channel);

                this.readMembers(channel);
            }),
        );
    }

    /**
     * Register a callback to be called anytime the member list changes.
     */
    here(callback: CallableFunction): this {
        this.hereCallbacks.push(callback);

        return this;
    }

    /**
     * Listen for someone joining the channel.
     */
    joining(callback: CallableFunction): this {
        return this.onPresence(JOINING, callback);
    }

    /**
     * Listen for someone leaving the channel.
     */
    leaving(callback: CallableFunction): this {
        return this.onPresence("leave", callback);
    }

    /**
     * Leave the presence set, then unsubscribe and detach.
     */
    unsubscribe(): void {
        this.hereCallbacks = [];

        const registrations = this.presenceListeners.splice(0);

        // Queued before the base's teardown so the operations reach ably in
        // order: leave the presence set, drop the presence listeners, and only
        // then detach the channel that carries the leave message.
        this.whenReady((channel) => {
            // A successor instance created by a rejoin has entered the presence
            // set as the same client: leaving now would take its membership
            // with it, so the last instance out does the leaving. Failures are
            // not reported, the way the base treats a refused `detach()`.
            const left = this.sharedWithLiveInstance(channel)
                ? undefined
                : channel.presence.leave();

            registrations.forEach(({ actions, listener }) =>
                channel.presence.unsubscribe(actions, listener),
            );

            return left;
        });

        super.unsubscribe();
    }

    /**
     * Announce this member to the presence set. Resolves either way — the
     * caller reads the member list next, whether or not this member made it in.
     */
    private enter(channel: RealtimeChannel): Promise<void> {
        return (
            channel.presence
                // `presenceInfo` is undefined when the token came from a
                // wildcard capability grant, which carries no per-channel
                // `info`. Entering without data is valid, and beats not
                // entering at all.
                .enter(this.tokenManager.presenceInfo(this.name))
                // `whenReady` swallows chain rejections, so a refused enter is
                // reported from here or not at all.
                .catch((error: unknown) => this.dispatchError(error))
        );
    }

    /**
     * Read the member list for whoever asked to know who is here.
     *
     * Pusher parity: this is the snapshot taken when the subscription succeeds,
     * not a feed of the membership changes that follow it — those are `joining`
     * and `leaving`. One read serves every registered callback.
     */
    private readMembers(channel: RealtimeChannel): void {
        if (this.hereCallbacks.length === 0) {
            return;
        }

        channel.presence
            .get()
            .then((members) => {
                const data = members.map((member) => member.data as unknown);

                this.hereCallbacks.forEach((callback) => callback(data));
            })
            .catch((error: unknown) => this.dispatchError(error));
    }

    /**
     * Hand a presence action's members to an Echo callback.
     */
    private onPresence(
        action: PresenceAction | PresenceAction[],
        callback: CallableFunction,
    ): this {
        const listener = (member: PresenceMessage) =>
            callback(member.data as unknown);

        // Tracked so teardown removes this registration alone, rather than
        // every presence listener on a possibly shared ably channel.
        this.presenceListeners.push({
            actions: Array.isArray(action) ? action : [action],
            listener,
        });

        this.whenReady((channel) =>
            channel.presence
                .subscribe(action, listener)
                .catch((error: unknown) => this.dispatchError(error)),
        );

        return this;
    }
}
