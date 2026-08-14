import type {
    ChannelOptions,
    ChannelStateChange,
    InboundMessage,
    PaginatedResult,
    Realtime,
    RealtimeChannel,
    RealtimeHistoryParams,
} from "ably";
import { Channel, EventFormatter } from "laravel-echo";
import type { TokenManager } from "../auth/token-manager";
import { normalizeReplay, ReplayEngine } from "../replay/replay-engine";
import type {
    HistoryPage,
    NormalizedReplay,
    ReplayMessage,
    ReplayResult,
} from "../replay/types";
import type { AblyDriverOptions, EchoOptionsWithDefaults } from "../types";

/**
 * The slice of a message the routing path reads.
 *
 * Structural rather than ably's `InboundMessage`, because a replayed message
 * arrives in the engine's own vocabulary and has to reach the very same
 * wrappers a live one does. Nothing here narrows what ably delivers: every
 * `InboundMessage` is one of these.
 */
type RoutableMessage = { name?: string; data?: unknown };

/** The ably-side listener wrapping an Echo callback. */
type MessageListener = (message: RoutableMessage) => void;

/** The catch-all listener, in ably's own terms — it is what ably calls. */
type InboundListener = (message: InboundMessage) => void;

/** The ably-side listener carrying channel state changes to this instance. */
type StateListener = (change: ChannelStateChange) => void;

/**
 * The live channel instances sharing each underlying ably channel.
 *
 * `channels.get(name)` caches, so a leave→rejoin on the same name — React
 * StrictMode's mount → cleanup → mount, most commonly — puts two instances of
 * this class on one `RealtimeChannel`. Teardown is therefore instance-scoped:
 * each instance removes only the listeners it registered, and the operations
 * that act on the channel as a whole (`detach()`, leaving the presence set) are
 * left to the last instance out. ably does not refcount attach intents, so a
 * detach landing after the successor's attach would leave that successor
 * silently unattached.
 *
 * Keyed weakly, so an entry lives exactly as long as the ably channel does.
 */
const liveInstances = new WeakMap<RealtimeChannel, Set<AblyChannel>>();

/**
 * A public Ably channel, driven by Echo's channel contract.
 *
 * The channel owns its own subscribe lifecycle: capability first (so the
 * connection is authorized before the server sees an attach), then the ably
 * channel, then the attach. Everything a caller registers in the meantime is
 * queued behind `ready`, so `echo.channel("orders").listen(...)` works on the
 * same tick the channel is created.
 */
export class AblyChannel extends Channel {
    /** The Ably client instance. */
    ably: Realtime;

    /** The resolved Ably channel name (e.g. `private:orders`). */
    name: string;

    /** The event formatter. */
    eventFormatter: EventFormatter;

    /** The underlying ably channel; assigned once `subscribe()` reaches it. */
    subscription!: RealtimeChannel;

    /** Resolves once `subscribe()` has run through, successfully or not. */
    ready: Promise<void>;

    protected tokenManager: TokenManager;

    /**
     * Whether this channel replays missed events, and how many at most. Fixed
     * for the life of the channel: the engine's gate, its bookkeeping and the
     * subscription shape all follow from it, and none of them can change mode
     * mid-flight.
     */
    protected readonly replayConfig: NormalizedReplay;

    /** The replay engine, in replay mode; `null` when replay is off. */
    protected readonly engine: ReplayEngine | null;

    /** Echo callback → its ably listener, keyed by formatted event name. */
    private readonly listeners = new Map<
        string,
        Map<CallableFunction, MessageListener>
    >();

    /** Echo callback → its ably listener, for `listenToAll` registrations. */
    private readonly globalListeners = new Map<
        CallableFunction,
        MessageListener
    >();

    private readonly subscribedCallbacks: CallableFunction[] = [];

    private readonly errorCallbacks: CallableFunction[] = [];

    private readonly recoveredCallbacks: Array<(result: ReplayResult) => void> =
        [];

    /**
     * Whether this channel has ever reached `attached`. The first attach
     * reports no continuity too, and there is nothing behind it to have missed.
     */
    private hasAttachedBefore = false;

    /**
     * The catch-up whose result is already promised to the `recovered`
     * callbacks. Attempts coalesce in the engine, so the fan-out is keyed on
     * the attempt rather than on the call that asked for it.
     */
    private fannedOut: Promise<ReplayResult> | null = null;

    /** The most recent error, replayed to callbacks registered after it. */
    private lastError: unknown = null;

    /**
     * This instance's state listener, kept so teardown can remove exactly it —
     * a blanket `off()` would take a successor instance's listener with it.
     * Its presence is also the latch that keeps `subscribe()` from registering
     * a second one.
     */
    private stateListener: StateListener | null = null;

    /**
     * This instance's catch-all message listener, in replay mode. Kept for the
     * reason the state listener is: teardown removes exactly it, and its
     * presence is the latch that keeps a second `subscribe()` from registering
     * a second one.
     */
    private catchAllListener: InboundListener | null = null;

    /**
     * Whether the current `subscribe()` attempt already had a failure reported
     * through the state listener. ably rejects `attach()` with the same error
     * it has just emitted as a state change, so without this the one failure
     * would reach `error()` twice — and the second time without the
     * `onChannelFailed` hook ever being consulted.
     */
    private failureReportedByState = false;

    /**
     * Create a new class instance.
     */
    constructor(
        ably: Realtime,
        name: string,
        options: EchoOptionsWithDefaults,
        tokenManager: TokenManager,
        /** Off unless the connector hands down a normalized `ably.replay`. */
        replay: NormalizedReplay = normalizeReplay(undefined),
    ) {
        super();

        this.ably = ably;
        this.name = name;
        this.options = options;
        this.tokenManager = tokenManager;
        this.replayConfig = replay;
        this.engine = replay.enabled ? this.createEngine(replay.limit) : null;
        this.eventFormatter = new EventFormatter(this.options.namespace);

        this.ready = this.subscribe();
    }

    /**
     * Authorize, create and attach the underlying ably channel.
     *
     * Never rejects: a failure here is what `error()` callbacks are for, and an
     * escaping rejection would be unhandled — nothing awaits `ready` but us.
     */
    async subscribe(): Promise<void> {
        this.failureReportedByState = false;

        try {
            await this.tokenManager.ensureCapability(this.name);

            this.subscription = this.ably.channels.get(
                this.name,
                this.channelOptions(),
            );

            this.claimInstance(this.subscription);

            // One listener for the life of the ably channel: `subscribe()` runs
            // again on connection recovery, and a second registration would
            // double every `subscribed()` and `error()` callback.
            if (!this.stateListener) {
                this.stateListener = (change: ChannelStateChange) =>
                    this.handleStateChange(change);

                this.subscription.on(this.stateListener);
            }

            this.registerCatchAll();

            await this.subscription.attach();
        } catch (error) {
            // Ownership: anything the channel reported as a state change
            // belongs to the state listener, which is where the
            // `onChannelFailed` hook gets its say. Only failures that never
            // became a channel state — a rejected capability request, a
            // connection-level attach rejection — are surfaced from here.
            if (this.failureReportedByState) {
                return;
            }

            this.dispatchError(error);
        }
    }

    /**
     * Unsubscribe from the channel and detach it.
     *
     * Everything removed here is this instance's own: the underlying ably
     * channel may already be shared with a successor instance created by a
     * rejoin, and a blanket `unsubscribe()` / `off()` would wipe that
     * successor's registrations while leaving it believing they are in place.
     */
    unsubscribe(): void {
        // Captured before the maps are cleared: these are the ably-side
        // listeners this instance put on the channel, and each is removed
        // individually below. In replay mode there are none — the catch-all
        // stands in for all of them.
        const scoped = [...this.listeners].flatMap(([event, wrappers]) =>
            [...wrappers.values()].map((wrapper) => ({ event, wrapper })),
        );
        const global = [...this.globalListeners.values()];

        this.listeners.clear();
        this.globalListeners.clear();

        // The registrations go first: resetting settles a catch-up still in
        // flight, and its result belongs to nobody now.
        this.recoveredCallbacks.length = 0;
        this.engine?.reset();

        this.whenReady((channel) => {
            if (this.replayConfig.enabled) {
                // Replay mode never put those listeners on the channel: one
                // catch-all carries every one of them, so that is what comes
                // off here. Read from the field rather than captured above for
                // the reason the state listener is, below.
                if (this.catchAllListener) {
                    channel.unsubscribe(this.catchAllListener);

                    this.catchAllListener = null;
                }
            } else {
                scoped.forEach(({ event, wrapper }) =>
                    channel.unsubscribe(event, wrapper),
                );
                global.forEach((wrapper) => channel.unsubscribe(wrapper));
            }

            // Removed here rather than synchronously above: `unsubscribe()` can
            // be called while the first `subscribe()` is still pending, and
            // that `subscribe()` would then register a listener *after* a
            // synchronous removal — leaving one behind that nothing tracks, so
            // a later `subscribe()` would never register one again.
            if (this.stateListener) {
                channel.off(this.stateListener);

                this.stateListener = null;
            }

            liveInstances.get(channel)?.delete(this);

            // A successor instance is attached to the very same channel, and
            // ably has no notion of two attach intents: detaching now would
            // strand it.
            if (this.sharedWithLiveInstance(channel)) {
                return undefined;
            }

            return channel.detach();
        });
    }

    /**
     * Listen for an event on the channel instance.
     */
    listen(event: string, callback: CallableFunction): this {
        return this.on(this.eventFormatter.format(event), callback);
    }

    /**
     * Listen for all events on the channel instance.
     */
    listenToAll(callback: CallableFunction): this {
        if (this.globalListeners.has(callback)) {
            return this;
        }

        const wrapper: MessageListener = (message) => {
            callback(
                this.formatIncomingEvent(message.name ?? ""),
                message.data,
            );
        };

        this.globalListeners.set(callback, wrapper);

        this.updateSubscription((channel) => channel.subscribe(wrapper));

        return this;
    }

    /**
     * Stop listening for an event on the channel instance.
     */
    stopListening(event: string, callback?: CallableFunction): this {
        const name = this.eventFormatter.format(event);
        const wrappers = this.listeners.get(name);

        if (!wrappers) {
            return this;
        }

        if (!callback) {
            this.listeners.delete(name);

            this.updateSubscription((channel) => channel.unsubscribe(name));

            return this;
        }

        const wrapper = wrappers.get(callback);

        if (!wrapper) {
            return this;
        }

        wrappers.delete(callback);

        if (wrappers.size === 0) {
            this.listeners.delete(name);
        }

        this.updateSubscription((channel) =>
            channel.unsubscribe(name, wrapper),
        );

        return this;
    }

    /**
     * Stop listening for all events on the channel instance.
     */
    stopListeningToAll(callback?: CallableFunction): this {
        if (callback) {
            const wrapper = this.globalListeners.get(callback);

            if (wrapper) {
                this.globalListeners.delete(callback);

                this.updateSubscription((channel) =>
                    channel.unsubscribe(wrapper),
                );
            }

            return this;
        }

        const wrappers = [...this.globalListeners.values()];

        this.globalListeners.clear();

        // Not `channel.unsubscribe()`: that would also drop the event-scoped
        // listeners registered through `listen()`.
        this.updateSubscription((channel) => {
            wrappers.forEach((wrapper) => channel.unsubscribe(wrapper));
        });

        return this;
    }

    /**
     * Register a callback to be called anytime a subscription succeeds.
     */
    subscribed(callback: CallableFunction): this {
        this.subscribedCallbacks.push(callback);

        return this;
    }

    /**
     * Register a callback to be called anytime an error occurs.
     */
    error(callback: CallableFunction): this {
        this.errorCallbacks.push(callback);

        // Auth and attach failures land before user code gets a chance to
        // register, so the last one is replayed rather than lost.
        if (this.lastError !== null) {
            callback(this.lastError);
        }

        return this;
    }

    /**
     * Register a callback to be called after every catch-up attempt, whether
     * it healed the channel or not, with the result the attempt produced.
     *
     * One call per attempt: a gap detected while a catch-up is running joins
     * it, and the one result it produces is fanned out once. Never fires unless
     * replay is enabled. Cleared by `unsubscribe()`, like the listeners are.
     */
    recovered(callback: (result: ReplayResult) => void): this {
        this.recoveredCallbacks.push(callback);

        return this;
    }

    /**
     * Catch up on whatever was missed since the last delivered message, on
     * demand — a backgrounded tab coming back, most commonly.
     *
     * Rejects only when replay is not configured. A catch-up that fails
     * resolves `{complete: false, count: 0}`, the same answer the automatic
     * path gets, and reports the reason through `error()`.
     */
    replayMissed(): Promise<ReplayResult> {
        if (!this.engine) {
            return Promise.reject(
                new Error(
                    "Replay is not enabled for this connection: set `ably.replay` in the Echo options to use replayMissed().",
                ),
            );
        }

        return this.fanOut(this.engine.replayMissed());
    }

    /**
     * Bind to a raw Ably event name, without namespace formatting.
     */
    on(event: string, callback: CallableFunction): this {
        const wrappers =
            this.listeners.get(event) ??
            new Map<CallableFunction, MessageListener>();

        this.listeners.set(event, wrappers);

        // Re-registering the same callback for the same event would leave a
        // second ably listener behind that `stopListening` could never remove.
        if (wrappers.has(callback)) {
            return this;
        }

        const wrapper: MessageListener = (message) => callback(message.data);

        wrappers.set(callback, wrapper);

        this.updateSubscription((channel) => channel.subscribe(event, wrapper));

        return this;
    }

    /**
     * Take a message off the catch-all subscription registered in replay mode.
     *
     * The engine sits here: it moves the cursor and routes the message on, or
     * holds it back while a catch-up puts the backlog in front of it first.
     */
    protected onIncoming(message: InboundMessage): void {
        if (!this.engine) {
            this.routeMessage(message);

            return;
        }

        this.engine.handleMessage(toReplayMessage(message));
    }

    /**
     * Deliver a message to this instance's listeners.
     *
     * The wrappers are called directly — the very functions ably itself would
     * have called through a per-event subscription — so a message routed here
     * is formatted by exactly the code that formats one on the default path.
     * `listen()` keys its wrappers by formatted event name, which is what keeps
     * `listenForWhisper` and `notification` working through this route too.
     *
     * `listenToAll` callbacks go first, which is ably's order rather than a
     * choice made here: its `EventEmitter.emit` walks `anyOnce → any →
     * eventsOnce → events`, so a catch-all runs ahead of the per-event
     * listeners however the two were registered. An app logging through
     * `listenToAll` sees the same sequence in both modes.
     */
    protected routeMessage(message: RoutableMessage): void {
        // Copied before the walk: a callback that calls `stopListening` from
        // inside its own delivery must not disturb the run it is part of.
        const global = [...this.globalListeners.values()];
        const wrappers = [
            ...(this.listeners.get(message.name ?? "")?.values() ?? []),
        ];

        global.forEach((wrapper) => wrapper(message));
        wrappers.forEach((wrapper) => wrapper(message));
    }

    /**
     * Hand a channel-level failure to a subclass. Returning `true` claims the
     * failure — it is then not surfaced to `error()` callbacks, which is how a
     * recoverable capability rejection stays invisible while it is retried.
     */
    protected onChannelFailed(_change: ChannelStateChange): boolean {
        return false;
    }

    /**
     * Whether another live instance of this driver is using the same underlying
     * ably channel — the leave→rejoin case, where `channels.get` handed both
     * instances the same object. Anything that would affect the channel as a
     * whole belongs to the last instance out.
     */
    protected sharedWithLiveInstance(channel: RealtimeChannel): boolean {
        const instances = liveInstances.get(channel);

        if (!instances) {
            return false;
        }

        return [...instances].some((instance) => instance !== this);
    }

    /**
     * Put this instance's one catch-all subscription on the ably channel, in
     * replay mode.
     *
     * Every message the channel carries has to reach the replay engine in
     * arrival order, which per-event subscriptions cannot promise: a message
     * nobody is listening for yet still moves the cursor. Registered once for
     * the life of the ably channel, for the reason the state listener is, and
     * before the attach so nothing published after it is missed.
     */
    private registerCatchAll(): void {
        if (!this.replayConfig.enabled || this.catchAllListener) {
            return;
        }

        this.catchAllListener = (message: InboundMessage) =>
            this.onIncoming(message);

        // ably settles this with the attach that follows it, which is where a
        // failure is reported; swallowed here so the same one does not also
        // surface as an unhandled rejection.
        void this.subscription
            .subscribe(this.catchAllListener)
            .catch(() => undefined);
    }

    /**
     * The replay engine for this channel, wired to the three things it needs
     * from it: ably's history endpoint, the routing path every listener hangs
     * off, and the `error()` callbacks.
     */
    private createEngine(limit: number): ReplayEngine {
        return new ReplayEngine({
            history: (params) => this.queryHistory(params),
            // Unguarded on purpose: the engine isolates every dispatch and
            // reports whatever a listener throws through `onError` below.
            dispatch: (message) => this.routeMessage(message),
            onError: (error) => this.dispatchError(error),
            limit,
        });
    }

    /**
     * Run one history query for the engine, in the engine's vocabulary.
     *
     * The engine builds ably's `RealtimeHistoryParams` but is kept clear of
     * ably's types, so they are cast back on the way in; the results are mapped
     * rather than cast on the way out, because `InboundMessage` leaves `name`
     * optional where a replayed message needs it.
     */
    private async queryHistory(
        params: Record<string, unknown>,
    ): Promise<HistoryPage> {
        const page = await this.subscription.history(
            params as RealtimeHistoryParams,
        );

        return toHistoryPage(page);
    }

    /**
     * Record an attach, and catch up when it lost continuity.
     *
     * `resumed: false` says ably could not resume the previous attachment, so
     * whatever was published while this channel was away never reached it. The
     * first attach reports it too and is not a gap: nothing came before it.
     *
     * The engine's gate closes inside this call, synchronously, which is what
     * keeps a message arriving straight after the attach behind the backlog it
     * belongs after.
     */
    private noteAttached(change: ChannelStateChange): void {
        const attachedBefore = this.hasAttachedBefore;

        this.hasAttachedBefore = true;

        if (!this.engine || !attachedBefore || change.resumed !== false) {
            return;
        }

        void this.fanOut(this.engine.gapDetected());
    }

    /**
     * Promise a catch-up's result to the `recovered` callbacks, once.
     *
     * Coalescing in the engine is mode-blind — a gap during a manual catch-up
     * joins it and is handed the same promise back — so registrations are keyed
     * on the attempt: one attempt, one result, one fan-out.
     */
    private fanOut(attempt: Promise<ReplayResult>): Promise<ReplayResult> {
        if (this.fannedOut === attempt) {
            return attempt;
        }

        this.fannedOut = attempt;

        void attempt
            .then((result) => {
                if (this.fannedOut === attempt) {
                    this.fannedOut = null;
                }

                this.recoveredCallbacks.forEach((callback) => callback(result));
            })
            // The engine settles rather than rejects, so the only rejection
            // reachable here is a `recovered` callback throwing — and nobody is
            // awaiting this chain to catch it.
            .catch(() => undefined);

        return attempt;
    }

    /**
     * Apply a change to this instance's per-event ably subscriptions.
     *
     * Replay mode has none to change: its single catch-all carries the whole
     * channel and `routeMessage` decides who hears what from the same internal
     * maps the caller has just updated, so the bookkeeping is the whole
     * operation.
     */
    private updateSubscription(
        operation: (channel: RealtimeChannel) => unknown,
    ): void {
        if (this.replayConfig.enabled) {
            return;
        }

        this.whenReady(operation);
    }

    /** Record this instance as a user of the underlying ably channel. */
    private claimInstance(channel: RealtimeChannel): void {
        const instances = liveInstances.get(channel) ?? new Set<AblyChannel>();

        instances.add(this);
        liveInstances.set(channel, instances);
    }

    /**
     * Run an operation against the ably channel once it exists.
     *
     * Rejections are swallowed: whatever went wrong during `subscribe()` was
     * already reported through `error()`, and re-surfacing it here would only
     * produce an unhandled rejection from a call the user never awaited.
     */
    protected whenReady(
        operation: (channel: RealtimeChannel) => unknown,
    ): void {
        this.ready
            .then(() =>
                this.subscription ? operation(this.subscription) : undefined,
            )
            .catch(() => undefined);
    }

    /**
     * Record an error and hand it to every registered error callback.
     */
    protected dispatchError(error: unknown): void {
        this.lastError = error;

        this.errorCallbacks.forEach((callback) => callback(error));
    }

    /**
     * Translate an ably channel state change into Echo's callbacks.
     */
    private handleStateChange(change: ChannelStateChange): void {
        if (change.current === "attached") {
            // Ahead of the callbacks: a gap has to close the engine's gate
            // before anything else on this tick, and a `subscribed` callback is
            // user code that may well publish.
            this.noteAttached(change);

            this.subscribedCallbacks.forEach((callback) => callback());
        }

        if (!change.reason && change.current !== "failed") {
            return;
        }

        // Claim the failure before the matching `attach()` rejection lands, so
        // it is reported (or suppressed by the hook) exactly once.
        this.failureReportedByState = true;

        if (change.current === "failed" && this.onChannelFailed(change)) {
            return;
        }

        if (change.reason) {
            this.dispatchError(change.reason);
        }
    }

    /**
     * Strip the configured namespace from an incoming event name, matching
     * `PusherChannel.listenToAll`'s formatting contract.
     */
    private formatIncomingEvent(event: string): string {
        const namespace = String(this.options.namespace ?? "").replace(
            /\./g,
            "\\",
        );

        return event.startsWith(namespace)
            ? event.substring(namespace.length + 1)
            : "." + event;
    }

    /**
     * The user-supplied ably channel options for this channel, if any.
     */
    private channelOptions(): ChannelOptions | undefined {
        const driverOptions: AblyDriverOptions = this.options.ably ?? {};

        return driverOptions.channelOptions?.[this.name];
    }
}

/**
 * Adapt a page of ably history to the one the engine walks, its items mapped
 * one by one and the pages behind it adapted as they are reached.
 */
function toHistoryPage(page: PaginatedResult<InboundMessage>): HistoryPage {
    return {
        items: page.items.map(toReplayMessage),
        hasNext: () => page.hasNext(),
        next: async () => {
            const next = await page.next();

            return next ? toHistoryPage(next) : null;
        },
    };
}

/**
 * One ably message in the engine's vocabulary. Mapped rather than cast: ably
 * leaves a message's name optional, and the engine's `name` is the formatted
 * event every listener is keyed by.
 */
function toReplayMessage(message: InboundMessage): ReplayMessage {
    return {
        id: message.id,
        // The fallback `listenToAll` already applies on the live path.
        name: message.name ?? "",
        data: message.data,
        timestamp: message.timestamp,
    };
}
