import { vi } from "vitest";

/**
 * An in-memory stand-in for the slice of ably-js v2 the driver touches. Every
 * SDK method is a `vi.fn()` so tests can assert on calls, and the `emit*`
 * helpers push events back the way a live connection would.
 */

export type MockMessage = { name: string; data: unknown };

export type MockStateChange = {
    current: string;
    previous?: string;
    reason?: unknown;
    resumed?: boolean;
};

export type MockPresenceAction = "enter" | "update" | "leave" | "present";

export type MockPresenceMember = { clientId: string; data: unknown };

type MessageListener = (message: MockMessage) => void;
type StateListener = (change: MockStateChange) => void;
type PresenceListener = (
    message: MockPresenceMember & { action: MockPresenceAction },
) => void;

/**
 * Listeners registered for a subset of event names, or for all of them when
 * the recorded filter is `null` — the shape both `channel.on()` and
 * `channel.subscribe()` share in ably-js.
 */
class ListenerRegistry<TListener, TEvent extends string> {
    private readonly listeners = new Map<TListener, TEvent[] | null>();

    add(events: TEvent | TEvent[] | null, listener: TListener): void {
        this.listeners.set(
            listener,
            events === null ? null : Array.isArray(events) ? events : [events],
        );
    }

    remove(listener: TListener): void {
        this.listeners.delete(listener);
    }

    /** Drop every listener registered for any of `events` (catch-alls stay). */
    removeByEvents(events: TEvent[], listener?: TListener): void {
        for (const [registered, registeredEvents] of [...this.listeners]) {
            if (registeredEvents === null) {
                continue;
            }

            if (!registeredEvents.some((event) => events.includes(event))) {
                continue;
            }

            if (listener !== undefined && registered !== listener) {
                continue;
            }

            this.listeners.delete(registered);
        }
    }

    clear(): void {
        this.listeners.clear();
    }

    /** Fire every listener watching `event`, plus every catch-all listener. */
    emit(event: TEvent, deliver: (listener: TListener) => void): void {
        for (const [listener, events] of [...this.listeners]) {
            if (events === null || events.includes(event)) {
                deliver(listener);
            }
        }
    }
}

export class MockPresence {
    private readonly listeners = new ListenerRegistry<
        PresenceListener,
        MockPresenceAction
    >();

    enter = vi.fn((_data?: unknown): Promise<void> => Promise.resolve());

    leave = vi.fn((_data?: unknown): Promise<void> => Promise.resolve());

    get = vi.fn((): Promise<MockPresenceMember[]> =>
        Promise.resolve<MockPresenceMember[]>([]),
    );

    subscribe = vi.fn(
        (
            actionOrListener:
                MockPresenceAction | MockPresenceAction[] | PresenceListener,
            listener?: PresenceListener,
        ): Promise<void> => {
            if (typeof actionOrListener === "function") {
                this.listeners.add(null, actionOrListener);
            } else if (listener) {
                this.listeners.add(actionOrListener, listener);
            }

            return Promise.resolve();
        },
    );

    unsubscribe = vi.fn(
        (
            actionOrListener?:
                MockPresenceAction | MockPresenceAction[] | PresenceListener,
            listener?: PresenceListener,
        ): void => {
            if (actionOrListener === undefined) {
                this.listeners.clear();

                return;
            }

            if (typeof actionOrListener === "function") {
                this.listeners.remove(actionOrListener);

                return;
            }

            this.listeners.removeByEvents(
                Array.isArray(actionOrListener)
                    ? actionOrListener
                    : [actionOrListener],
                listener,
            );
        },
    );

    /** Deliver a presence event to the listeners watching for it. */
    emit(action: MockPresenceAction, member: MockPresenceMember): void {
        this.listeners.emit(action, (listener) =>
            listener({ ...member, action }),
        );
    }
}

export class MockChannel {
    state = "initialized";
    errorReason: unknown = null;
    presence = new MockPresence();

    private readonly messageListeners = new ListenerRegistry<
        MessageListener,
        string
    >();
    private readonly stateListeners = new ListenerRegistry<
        StateListener,
        string
    >();

    /** The error the next `attach()` should fail with, set by `failAttach()`. */
    private attachFailure: unknown = null;

    constructor(public name: string) {}

    /**
     * Attaching drives the channel state machine the way ably does: it emits
     * the resulting state change before settling, and a failure both emits
     * `failed` and rejects with the very same error.
     */
    attach = vi.fn((): Promise<unknown> => {
        const failure = this.attachFailure;

        if (failure !== null) {
            this.attachFailure = null;

            this.emitStateChange({
                current: "failed",
                previous: "attaching",
                reason: failure,
            });

            return Promise.reject(failure);
        }

        this.emitStateChange({ current: "attached", previous: "attaching" });

        return Promise.resolve(null);
    });

    /** Make the next `attach()` fail with `reason`, state change included. */
    failAttach(reason: unknown): void {
        this.attachFailure = reason;
    }

    detach = vi.fn((): Promise<void> => Promise.resolve());

    publish = vi.fn((_name: string, _data: unknown): Promise<void> =>
        Promise.resolve(),
    );

    subscribe = vi.fn(
        (
            eventOrListener: string | string[] | MessageListener,
            listener?: MessageListener,
        ): Promise<unknown> => {
            if (typeof eventOrListener === "function") {
                this.messageListeners.add(null, eventOrListener);
            } else if (listener) {
                this.messageListeners.add(eventOrListener, listener);
            }

            return Promise.resolve(null);
        },
    );

    unsubscribe = vi.fn(
        (
            eventOrListener?: string | string[] | MessageListener,
            listener?: MessageListener,
        ): void => {
            if (eventOrListener === undefined) {
                this.messageListeners.clear();

                return;
            }

            if (typeof eventOrListener === "function") {
                this.messageListeners.remove(eventOrListener);

                return;
            }

            this.messageListeners.removeByEvents(
                Array.isArray(eventOrListener)
                    ? eventOrListener
                    : [eventOrListener],
                listener,
            );
        },
    );

    on = vi.fn(
        (
            eventOrListener: string | string[] | StateListener,
            listener?: StateListener,
        ): void => {
            if (typeof eventOrListener === "function") {
                this.stateListeners.add(null, eventOrListener);
            } else if (listener) {
                this.stateListeners.add(eventOrListener, listener);
            }
        },
    );

    off = vi.fn((): void => {
        this.stateListeners.clear();
    });

    /** Move the channel to a new state and notify its state listeners. */
    emitStateChange(change: MockStateChange): void {
        this.state = change.current;

        if (change.reason !== undefined) {
            this.errorReason = change.reason;
        }

        this.stateListeners.emit(change.current, (listener) =>
            listener(change),
        );
    }

    /** Deliver a message to the listeners subscribed to its name, and to catch-alls. */
    emitMessage(message: MockMessage): void {
        this.messageListeners.emit(message.name, (listener) =>
            listener(message),
        );
    }
}

export class MockChannels {
    /** Every channel handed out by `get()`, keyed by name. */
    all: Record<string, MockChannel> = {};
    /** Names passed to `release()`, in order. */
    released: string[] = [];
    /** The options `get()` was called with, keyed by channel name. */
    requestedOptions: Record<string, unknown> = {};

    get = vi.fn((name: string, options?: unknown): MockChannel => {
        if (options !== undefined) {
            this.requestedOptions[name] = options;
        }

        this.all[name] ??= new MockChannel(name);

        return this.all[name];
    });

    release = vi.fn((name: string): void => {
        this.released.push(name);

        delete this.all[name];
    });
}

export class MockConnection {
    state = "initialized";
    key = "mock-connection-key";

    private readonly listeners = new ListenerRegistry<StateListener, string>();

    on = vi.fn(
        (
            eventOrListener: string | string[] | StateListener,
            listener?: StateListener,
        ): void => {
            if (typeof eventOrListener === "function") {
                this.listeners.add(null, eventOrListener);
            } else if (listener) {
                this.listeners.add(eventOrListener, listener);
            }
        },
    );

    off = vi.fn((listener?: StateListener): void => {
        if (listener) {
            this.listeners.remove(listener);

            return;
        }

        this.listeners.clear();
    });

    /** Move the connection to a new state and notify its listeners. */
    emitStateChange(change: MockStateChange): void {
        this.state = change.current;

        this.listeners.emit(change.current, (listener) => listener(change));
    }
}

export class MockRealtime {
    channels = new MockChannels();
    connection = new MockConnection();
    auth = {
        clientId: null as string | null,
        authorize: vi.fn((): Promise<unknown> => Promise.resolve(null)),
    };

    close = vi.fn((): void => {});
    connect = vi.fn((): void => {});
}

export function createMockRealtime(): MockRealtime {
    return new MockRealtime();
}
