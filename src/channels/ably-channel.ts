import type {
    ChannelOptions,
    ChannelStateChange,
    InboundMessage,
    Realtime,
    RealtimeChannel,
} from "ably";
import { Channel, EventFormatter } from "laravel-echo";
import type { TokenManager } from "../auth/token-manager";
import type { AblyDriverOptions, EchoOptionsWithDefaults } from "../types";

/** The ably-side listener wrapping an Echo callback. */
type MessageListener = (message: InboundMessage) => void;

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

    /** The most recent error, replayed to callbacks registered after it. */
    private lastError: unknown = null;

    private stateListenerRegistered = false;

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
    ) {
        super();

        this.ably = ably;
        this.name = name;
        this.options = options;
        this.tokenManager = tokenManager;
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

            // One listener for the life of the ably channel: `subscribe()` runs
            // again on connection recovery, and a second registration would
            // double every `subscribed()` and `error()` callback.
            if (!this.stateListenerRegistered) {
                this.subscription.on((change: ChannelStateChange) =>
                    this.handleStateChange(change),
                );

                this.stateListenerRegistered = true;
            }

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
     */
    unsubscribe(): void {
        this.listeners.clear();
        this.globalListeners.clear();

        this.whenReady((channel) => {
            channel.unsubscribe();
            channel.off();

            // Reset here rather than synchronously above: `unsubscribe()` can
            // be called while the first `subscribe()` is still pending, and
            // that `subscribe()` would then set the flag *after* a synchronous
            // reset — leaving the flag claiming a listener `off()` just removed,
            // so a later `subscribe()` would never register one again.
            this.stateListenerRegistered = false;

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

        this.whenReady((channel) => channel.subscribe(wrapper));

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

            this.whenReady((channel) => channel.unsubscribe(name));

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

        this.whenReady((channel) => channel.unsubscribe(name, wrapper));

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

                this.whenReady((channel) => channel.unsubscribe(wrapper));
            }

            return this;
        }

        const wrappers = [...this.globalListeners.values()];

        this.globalListeners.clear();

        // Not `channel.unsubscribe()`: that would also drop the event-scoped
        // listeners registered through `listen()`.
        this.whenReady((channel) => {
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

        this.whenReady((channel) => channel.subscribe(event, wrapper));

        return this;
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
