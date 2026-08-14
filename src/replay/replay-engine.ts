import type {
    HistoryPage,
    NormalizedReplay,
    ReplayDeps,
    ReplayMessage,
    ReplayOptions,
    ReplayResult,
} from "./types";

/** The most messages one catch-up replays before it gives up, unconfigured. */
const DEFAULT_LIMIT = 100;

/** The largest page ably's history endpoint will serve. */
const MAX_PAGE_SIZE = 1000;

/**
 * How many live messages may queue behind a catch-up before the catch-up is
 * abandoned. A backlog nobody can bound is worth less than the memory it costs.
 */
const BUFFER_CAP = 1000;

/** Which query a catch-up runs: after a continuity gap, or on demand. */
type CatchUpMode = "gap" | "manual";

/** The last message the app is known to have seen. */
type Cursor = { id: string; timestamp: number };

/** A catch-up in flight, and the one promise every caller of it holds. */
type Attempt = {
    promise: Promise<ReplayResult>;
    settle: (result: ReplayResult) => void;
    done: boolean;
};

/** Read the `ably.replay` option, defaults filled in. */
export function normalizeReplay(
    options: ReplayOptions | undefined,
): NormalizedReplay {
    if (options && typeof options === "object") {
        return { enabled: true, limit: options.limit ?? DEFAULT_LIMIT };
    }

    return { enabled: options === true, limit: DEFAULT_LIMIT };
}

/** What a catch-up that could not heal the channel resolves with. */
function incomplete(): ReplayResult {
    return { complete: false, count: 0 };
}

/**
 * Tracks what a channel has delivered, and replays what it missed.
 *
 * Everything ably-shaped is injected, so this knows only about messages, pages
 * of history, and the two things it can do with a message: hand it to the app
 * now, or hold it until the backlog in front of it has been replayed.
 */
export class ReplayEngine {
    private readonly deps: ReplayDeps;

    private cursor: Cursor | null = null;

    /** Live messages that arrived while a catch-up was running. */
    private buffer: ReplayMessage[] = [];

    /**
     * The running catch-up. Its presence is also the buffering gate: while an
     * attempt is on the books, nothing live reaches the app.
     */
    private attempt: Attempt | null = null;

    /** Bumped by `reset()`; a run of deliveries under an older value is stale. */
    private generation = 0;

    constructor(deps: ReplayDeps) {
        this.deps = deps;
    }

    /**
     * Anchor the cursor on a message that has reached the app. Replayed and
     * whispered messages count: the cursor is about delivery, not origin.
     */
    noteDelivered(message: ReplayMessage): void {
        this.cursor = { id: message.id, timestamp: message.timestamp };
    }

    /**
     * Take an incoming message: straight to the app, or into the buffer when a
     * catch-up is mid-flight and the backlog in front of it has to land first.
     */
    handleMessage(message: ReplayMessage): void {
        const attempt = this.attempt;

        if (!attempt) {
            this.deliver(message);

            return;
        }

        this.buffer.push(message);

        if (this.buffer.length <= BUFFER_CAP) {
            return;
        }

        // Past the cap the catch-up is abandoned rather than the traffic: the
        // buffer still flushes, so nothing live is lost — only the backlog is.
        this.report(
            new Error(
                `Replay buffered more than ${BUFFER_CAP} live messages while catching up; the catch-up was abandoned.`,
            ),
        );
        this.finish(attempt, incomplete());
    }

    /**
     * Heal a continuity gap: everything published between the cursor and the
     * attach point, replayed in order.
     */
    gapDetected(): Promise<ReplayResult> {
        return this.start("gap");
    }

    /** Catch up on demand, outside a gap — a tab thawing, most commonly. */
    replayMissed(): Promise<ReplayResult> {
        return this.start("manual");
    }

    /**
     * Forget the channel: cursor, buffered traffic, and any catch-up still in
     * flight. The buffer is dropped rather than flushed, because the listeners
     * it would reach are being torn down with it.
     */
    reset(): void {
        const attempt = this.attempt;

        this.cursor = null;
        this.buffer = [];
        this.attempt = null;
        // Stops a run of deliveries this was called from mid-way through:
        // finishing it would re-anchor the cursor just cleared here.
        this.generation += 1;

        if (attempt) {
            attempt.done = true;
            attempt.settle(incomplete());
        }
    }

    /**
     * Open a catch-up, or join the one already running.
     *
     * The gate closes here, synchronously: the channel's state handler calls
     * this and post-attach live messages route in immediately afterwards, so a
     * gate that closed after the first `await` would let one overtake the
     * backlog.
     */
    private start(mode: CatchUpMode): Promise<ReplayResult> {
        // A second gap or a manual call joins the attempt already running: the
        // channel fans one result out to its `recovered` callbacks.
        if (this.attempt) {
            return this.attempt.promise;
        }

        let settle: (result: ReplayResult) => void = () => undefined;
        const promise = new Promise<ReplayResult>((resolve) => {
            settle = resolve;
        });

        const attempt: Attempt = { promise, settle, done: false };

        this.attempt = attempt;

        void this.run(attempt, mode);

        return promise;
    }

    /** Collect the backlog, replay it, and settle — whatever happens. */
    private async run(attempt: Attempt, mode: CatchUpMode): Promise<void> {
        const cursor = this.cursor;

        // Nothing was ever delivered here, so there is no anchor to query
        // against and no way to tell what "missed" would even mean.
        if (!cursor) {
            this.finish(attempt, incomplete());

            return;
        }

        try {
            const collected = await this.collect(attempt, cursor, mode);

            // Abandoned while the request was in flight (buffer cap, `reset()`):
            // what came back belongs to nobody.
            if (attempt.done) {
                return;
            }

            // The no-partial rule: a backlog with a hole in it is worse than an
            // honest miss, so an incomplete collection is thrown away.
            if (!collected) {
                this.finish(attempt, incomplete());

                return;
            }

            const count = this.replay(collected);

            this.finish(attempt, { complete: true, count });
        } catch (error) {
            if (attempt.done) {
                return;
            }

            // Reported *and* resolved: the auto path is driven by a state
            // handler with nobody to catch a rejection.
            this.report(error);
            this.finish(attempt, incomplete());
        }
    }

    /**
     * Walk history for the messages the app has not seen, oldest first, or
     * `null` when the walk could not account for all of them.
     */
    private async collect(
        attempt: Attempt,
        cursor: Cursor,
        mode: CatchUpMode,
    ): Promise<ReplayMessage[] | null> {
        const backwards = mode === "gap";
        const collected: ReplayMessage[] = [];

        let page: HistoryPage | null = await this.deps.history(
            this.queryFor(cursor, backwards),
        );

        while (page) {
            for (const message of page.items) {
                // ably ids are opaque rather than ordered, so the cursor is
                // only ever found by equality.
                if (message.id === cursor.id) {
                    if (backwards) {
                        // Newest first: the cursor is where the missed run
                        // ends, and the collection is already whole.
                        return collected.reverse();
                    }

                    // Oldest first from the cursor's own timestamp: everything
                    // up to and including it has already been delivered.
                    collected.length = 0;

                    continue;
                }

                if (collected.length >= this.deps.limit) {
                    return null;
                }

                collected.push(message);
            }

            if (attempt.done) {
                return null;
            }

            page = page.hasNext() ? await page.next() : null;
        }

        // Backwards walks that ran out of pages never found their anchor, so
        // they cannot prove the backlog is whole. Forwards walks running out of
        // pages is exactly what completion looks like.
        return backwards ? null : collected;
    }

    /** The history query a catch-up of this kind runs. */
    private queryFor(
        cursor: Cursor,
        backwards: boolean,
    ): Record<string, unknown> {
        // No page is worth asking for beyond what one catch-up may replay, and
        // ably refuses a page larger than its own maximum outright.
        const limit = Math.min(this.deps.limit, MAX_PAGE_SIZE);

        // `untilAttach` stops the walk at the attach point, so it cannot
        // overlap the live traffic that starts after it.
        return backwards
            ? { untilAttach: true, direction: "backwards", limit }
            : { start: cursor.timestamp, direction: "forwards", limit };
    }

    /**
     * Hand the collected backlog to the app in order, skipping whatever has
     * already arrived live and is waiting in the buffer — a manual catch-up
     * queries a window live traffic is still landing in.
     */
    private replay(messages: ReplayMessage[]): number {
        const buffered = new Set(this.buffer.map((message) => message.id));
        const missed = messages.filter((message) => !buffered.has(message.id));

        return this.deliverAll(missed);
    }

    /**
     * Settle an attempt. The buffered live traffic goes out first — always,
     * whether the catch-up healed the channel, failed, or was abandoned — and
     * only then does the caller hear the outcome.
     */
    private finish(attempt: Attempt, result: ReplayResult): void {
        if (attempt.done) {
            return;
        }

        attempt.done = true;

        const buffered = this.buffer;

        // The gate opens before the flush, so a message arriving while it runs
        // is delivered behind the ones already queued rather than joining a
        // buffer nothing will drain.
        this.buffer = [];
        this.attempt = null;

        try {
            this.deliverAll(buffered);
        } finally {
            // Whatever the drain did, the caller hears an answer: this is the
            // only place an attempt is ever settled, and `run()` has already
            // marked it done, so a throw escaping here would hang it for good.
            attempt.settle(result);
        }
    }

    /**
     * Hand a run of messages to the app, in order, and report how many got
     * there.
     *
     * `dispatch` reaches the app's listeners, which are user code: one of them
     * throwing is reported and stepped over rather than allowed to abandon the
     * messages behind it. One of them calling `reset()` does end the run — the
     * channel is being torn down, and delivering the rest would re-anchor the
     * cursor `reset()` just cleared.
     */
    private deliverAll(messages: ReplayMessage[]): number {
        const generation = this.generation;
        let delivered = 0;

        for (const message of messages) {
            if (this.generation !== generation) {
                break;
            }

            this.deliver(message);
            delivered += 1;
        }

        return delivered;
    }

    /** Cursor first, then the app. */
    private deliver(message: ReplayMessage): void {
        this.noteDelivered(message);

        try {
            this.deps.dispatch(message);
        } catch (error) {
            this.report(error);
        }
    }

    /**
     * Report a failure to the channel.
     *
     * `onError` ends up in the app's `error()` callbacks, which are user code
     * on the same footing as its listeners: one of them throwing must not
     * strand a catch-up mid-flush, and there is nowhere left to report a
     * failure of the failure reporter to.
     */
    private report(error: unknown): void {
        try {
            this.deps.onError(error);
        } catch {
            // Deliberately dropped, per the note above.
        }
    }
}
