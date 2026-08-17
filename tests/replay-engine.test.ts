import { describe, expect, it, vi } from "vitest";
import { normalizeReplay, ReplayEngine } from "../src/replay/replay-engine";
import type {
    HistoryPage,
    ReplayDeps,
    ReplayMessage,
    ReplayResult,
} from "../src/replay/types";
import { withoutUnhandledRejections } from "./helpers";

const BASE_TIME = 1_700_000_000_000;

/** A message as the engine sees it, stamped `offset` ms after the base time. */
function message(id: string, offset: number): ReplayMessage {
    return {
        id,
        name: "App\\Events\\OrderShipped",
        data: { id },
        timestamp: BASE_TIME + offset,
    };
}

/** One page of history results, linked to the page that follows it. */
function page(items: ReplayMessage[], next: HistoryPage | null = null) {
    return {
        items,
        hasNext: vi.fn((): boolean => next !== null),
        next: vi.fn((): Promise<HistoryPage | null> => Promise.resolve(next)),
    };
}

/**
 * Chain `groups` into the page sequence a paginated history walk would hand
 * back, first group first.
 */
function pages(...groups: ReplayMessage[][]): HistoryPage {
    let chained: HistoryPage | null = null;

    for (let index = groups.length - 1; index >= 0; index -= 1) {
        chained = page(groups[index], chained);
    }

    return chained ?? page([]);
}

/** A history request that stays in flight until it is settled by hand. */
function deferredPage(): {
    promise: Promise<HistoryPage>;
    resolve: (result: HistoryPage) => void;
    reject: (error: unknown) => void;
} {
    let resolve: (result: HistoryPage) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;

    const promise = new Promise<HistoryPage>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

/** Let every queued microtask run before asserting on what did not happen. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** An engine over plain fakes: no ably, no channel, no timers. */
function createEngine(limit: number = 100) {
    const history = vi
        .fn<(params: Record<string, unknown>) => Promise<HistoryPage>>()
        .mockResolvedValue(page([]));
    const dispatch = vi.fn<(message: ReplayMessage) => void>();
    const onError = vi.fn<(error: unknown) => void>();
    const deps: ReplayDeps = { history, dispatch, onError, limit };

    return { engine: new ReplayEngine(deps), history, dispatch, onError };
}

type Harness = ReturnType<typeof createEngine>;

/** The ids handed to the app, in the order they were handed over. */
function delivered(harness: Harness): string[] {
    return harness.dispatch.mock.calls.map(([message]) => message.id);
}

/**
 * The cursor's timestamp, read the only way the outside world can: a manual
 * catch-up queries history forwards from exactly it.
 */
async function cursorTimestamp(harness: Harness): Promise<unknown> {
    harness.history.mockClear();

    await harness.engine.replayMissed();

    return harness.history.mock.calls[0]?.[0].start;
}

/** An engine anchored on `anchor`, with the delivery of it already forgotten. */
function anchoredEngine(anchor: ReplayMessage, limit: number = 100): Harness {
    const harness = createEngine(limit);

    harness.engine.handleMessage(anchor);
    harness.dispatch.mockClear();

    return harness;
}

describe("live messages", () => {
    it("dispatches the message and anchors the cursor on it", async () => {
        const harness = createEngine();
        const first = message("m1", 0);

        harness.engine.handleMessage(first);

        expect(harness.dispatch).toHaveBeenCalledTimes(1);
        expect(harness.dispatch).toHaveBeenCalledWith(first);
        await expect(cursorTimestamp(harness)).resolves.toBe(first.timestamp);
    });

    it("moves the cursor before dispatching, not after", async () => {
        // Observable rather than incidental: a listener that calls
        // `replayMissed()` while handling a message must query history from
        // that message, not from the one before it.
        const harness = anchoredEngine(message("m0", 0));
        const second = message("m1", 1_000);

        let started: Promise<unknown> | undefined;

        harness.dispatch.mockImplementationOnce(() => {
            started = harness.engine.replayMissed();
        });

        harness.engine.handleMessage(second);
        await started;

        expect(harness.history).toHaveBeenCalledWith(
            expect.objectContaining({ start: second.timestamp }),
        );
    });

    it("advances the cursor without dispatching when only noted", async () => {
        const harness = createEngine();
        const seen = message("m1", 0);

        harness.engine.noteDelivered(seen);

        expect(harness.dispatch).not.toHaveBeenCalled();
        await expect(cursorTimestamp(harness)).resolves.toBe(seen.timestamp);
    });

    it("buffers a live message that lands on the same tick the catch-up starts", async () => {
        // The gate has to flip synchronously inside `gapDetected()`. The
        // channel calls this from its state handler and live messages route
        // into `handleMessage` immediately afterwards, so a gate that flipped
        // after the first `await` would let one overtake the backlog.
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        harness.engine.handleMessage(message("live", 5_000));

        expect(harness.dispatch).not.toHaveBeenCalled();

        inFlight.resolve(pages([anchor]));

        await expect(attempt).resolves.toEqual({ complete: true, count: 0 });
        expect(delivered(harness)).toEqual(["live"]);
    });
});

describe("gapDetected", () => {
    it("replays the backlog chronologically, then flushes the live buffer", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const first = message("m1", 1_000);
        const second = message("m2", 2_000);
        const third = message("m3", 3_000);

        // Backwards pagination: newest first, both across pages and within one.
        harness.history.mockResolvedValueOnce(
            pages([third, second], [first, anchor]),
        );

        const attempt = harness.engine.gapDetected();

        // More than one, in arrival order: the flush has an order of its own to
        // get right, not just a position after the backlog.
        harness.engine.handleMessage(message("live-1", 4_000));
        harness.engine.handleMessage(message("live-2", 5_000));
        harness.engine.handleMessage(message("live-3", 6_000));

        await expect(attempt).resolves.toEqual({ complete: true, count: 3 });
        expect(harness.history).toHaveBeenCalledWith({
            untilAttach: true,
            direction: "backwards",
            limit: 100,
        });
        expect(delivered(harness)).toEqual([
            "m1",
            "m2",
            "m3",
            "live-1",
            "live-2",
            "live-3",
        ]);
        await expect(cursorTimestamp(harness)).resolves.toBe(BASE_TIME + 6_000);
    });

    it("anchors the cursor on the last message it replayed", async () => {
        // With an empty buffer there is no live message to hide behind: the
        // cursor can only have come from the replay itself.
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const latest = message("m2", 2_000);

        harness.history.mockResolvedValueOnce(
            pages([latest, message("m1", 1_000), anchor]),
        );

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: true,
            count: 2,
        });
        await expect(cursorTimestamp(harness)).resolves.toBe(latest.timestamp);
    });

    it("stops paginating as soon as the cursor turns up", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const tail = page([message("older", -1_000)]);
        const head = page([message("m1", 1_000), anchor], tail);

        harness.history.mockResolvedValueOnce(head);

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: true,
            count: 1,
        });
        expect(head.next).not.toHaveBeenCalled();
    });

    it("reports a gap that missed nothing as a complete catch-up", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);

        harness.history.mockResolvedValueOnce(pages([anchor]));

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: true,
            count: 0,
        });
        expect(harness.dispatch).not.toHaveBeenCalled();
    });

    it("replays nothing when history runs out before the cursor is found", async () => {
        // A backlog with a hole in it is worse than an honest miss: the app is
        // told to refetch instead of being handed a partial story.
        const harness = anchoredEngine(message("m0", 0));
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        harness.engine.handleMessage(message("live", 4_000));
        inFlight.resolve(
            pages(
                [message("m3", 3_000), message("m2", 2_000)],
                [message("m1", 1_000)],
            ),
        );

        await expect(attempt).resolves.toEqual({ complete: false, count: 0 });
        expect(delivered(harness)).toEqual(["live"]);
    });

    it("gives up rather than replaying a partial backlog when the limit is reached", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor, 2);

        harness.history.mockResolvedValueOnce(
            pages([
                message("m3", 3_000),
                message("m2", 2_000),
                message("m1", 1_000),
                anchor,
            ]),
        );

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: false,
            count: 0,
        });
        expect(harness.dispatch).not.toHaveBeenCalled();
        expect(harness.history).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 2 }),
        );
    });

    it("completes on a backlog of exactly the limit", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor, 2);

        harness.history.mockResolvedValueOnce(
            pages([message("m2", 2_000), message("m1", 1_000), anchor]),
        );

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: true,
            count: 2,
        });
        expect(delivered(harness)).toEqual(["m1", "m2"]);
    });

    it("clamps the page size to the largest history page ably will serve", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor, 5_000);

        harness.history.mockResolvedValueOnce(pages([anchor]));

        await harness.engine.gapDetected();

        expect(harness.history).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 1_000 }),
        );
    });

    it("returns incomplete without querying history when nothing was ever delivered", async () => {
        const harness = createEngine();

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: false,
            count: 0,
        });
        expect(harness.history).not.toHaveBeenCalled();
    });
});

describe("replayMissed", () => {
    it("queries forwards from the cursor and skips everything up to it", async () => {
        // Ably ids are opaque, so the cursor is found by equality and the
        // window before it — including anything sharing its millisecond — is
        // already-delivered traffic.
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const sibling = message("m0-sibling", 0);
        const missed = message("m1", 1_000);

        harness.history.mockResolvedValueOnce(pages([sibling, anchor, missed]));

        await expect(harness.engine.replayMissed()).resolves.toEqual({
            complete: true,
            count: 1,
        });
        expect(harness.history).toHaveBeenCalledWith({
            start: anchor.timestamp,
            direction: "forwards",
            limit: 100,
        });
        expect(delivered(harness)).toEqual(["m1"]);
    });

    it("skips a message that arrived live while the catch-up was running", async () => {
        // Manual catch-ups query a window live traffic is still landing in, so
        // the same message can be in both — it must reach the app once.
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const missed = message("m1", 1_000);
        const live = message("m2", 2_000);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.replayMissed();

        harness.engine.handleMessage(live);
        inFlight.resolve(pages([anchor, missed, live]));

        await expect(attempt).resolves.toEqual({ complete: true, count: 1 });
        expect(delivered(harness)).toEqual(["m1", "m2"]);
    });

    it("completes with nothing to replay when history holds only the cursor", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);

        harness.history.mockResolvedValueOnce(pages([anchor]));

        await expect(harness.engine.replayMissed()).resolves.toEqual({
            complete: true,
            count: 0,
        });
        expect(harness.dispatch).not.toHaveBeenCalled();
    });

    it("replays nothing when the limit is hit with history still to walk", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor, 2);

        harness.history.mockResolvedValueOnce(
            pages(
                [anchor, message("m1", 1_000)],
                [message("m2", 2_000), message("m3", 3_000)],
            ),
        );

        await expect(harness.engine.replayMissed()).resolves.toEqual({
            complete: false,
            count: 0,
        });
        expect(harness.dispatch).not.toHaveBeenCalled();
    });

    it("returns incomplete without querying history when nothing was ever delivered", async () => {
        const harness = createEngine();

        await expect(harness.engine.replayMissed()).resolves.toEqual({
            complete: false,
            count: 0,
        });
        expect(harness.history).not.toHaveBeenCalled();
    });
});

describe("failures", () => {
    it("reports a rejected history request and still flushes the live buffer", async () => {
        const failure = new Error("no history capability");
        const harness = anchoredEngine(message("m0", 0));
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        harness.engine.handleMessage(message("live", 4_000));
        inFlight.reject(failure);

        // Resolves, never rejects: the auto path has nobody to catch it.
        await expect(attempt).resolves.toEqual({ complete: false, count: 0 });
        expect(harness.onError).toHaveBeenCalledWith(failure);
        expect(delivered(harness)).toEqual(["live"]);
    });

    it("reports a rejection that lands mid-pagination", async () => {
        const failure = new Error("history page failed");
        const harness = anchoredEngine(message("m0", 0));

        harness.history.mockResolvedValueOnce({
            items: [message("m1", 1_000)],
            hasNext: () => true,
            next: () => Promise.reject(failure),
        });

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: false,
            count: 0,
        });
        expect(harness.onError).toHaveBeenCalledWith(failure);
        expect(harness.dispatch).not.toHaveBeenCalled();
    });

    it("abandons the catch-up when the live buffer overflows, and still flushes it", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        // One past the 1000-message cap.
        for (let index = 0; index <= 1_000; index += 1) {
            harness.engine.handleMessage(
                message(`live-${index}`, 10_000 + index),
            );
        }

        await expect(attempt).resolves.toEqual({ complete: false, count: 0 });
        expect(harness.onError).toHaveBeenCalledTimes(1);
        // Nothing is dropped on the way out: every buffered message is flushed.
        expect(harness.dispatch).toHaveBeenCalledTimes(1_001);

        // The abandoned request belongs to nobody once it lands.
        inFlight.resolve(pages([message("m1", 1_000), anchor]));
        await settle();

        expect(harness.dispatch).toHaveBeenCalledTimes(1_001);
        expect(harness.onError).toHaveBeenCalledTimes(1);
    });

    it("stops buffering once the cap has aborted the catch-up", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        for (let index = 0; index <= 1_000; index += 1) {
            harness.engine.handleMessage(
                message(`live-${index}`, 10_000 + index),
            );
        }

        await attempt;

        harness.engine.handleMessage(message("after", 20_000));

        expect(harness.dispatch).toHaveBeenCalledTimes(1_002);
        inFlight.resolve(pages([anchor]));
    });

    it("ignores a history rejection that lands after the cap abandoned the catch-up", async () => {
        const harness = anchoredEngine(message("m0", 0));
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const rejections = await withoutUnhandledRejections(async () => {
            const attempt = harness.engine.gapDetected();

            for (let index = 0; index <= 1_000; index += 1) {
                harness.engine.handleMessage(
                    message(`live-${index}`, 10_000 + index),
                );
            }

            await attempt;

            inFlight.reject(new Error("history unavailable"));
        });

        // The cap's own report and nothing else: the request nobody is waiting
        // on has no result to report, and no rejection to leak either.
        expect(harness.onError).toHaveBeenCalledTimes(1);
        expect(rejections).toEqual([]);
    });

    it("keeps flushing, and settles, when a listener throws mid-drain", async () => {
        // `dispatch` runs the app's listeners. One of them throwing must not
        // strand the messages behind it, nor the caller waiting on the result:
        // the flush-always rule covers user code too.
        const failure = new Error("history unavailable");
        const listenerFailure = new Error("listener blew up");
        const harness = anchoredEngine(message("m0", 0));
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);
        harness.dispatch.mockImplementation((message) => {
            if (message.id === "live-2") {
                throw listenerFailure;
            }
        });

        let result: ReplayResult | undefined;

        const rejections = await withoutUnhandledRejections(async () => {
            const attempt = harness.engine.gapDetected();

            harness.engine.handleMessage(message("live-1", 4_000));
            harness.engine.handleMessage(message("live-2", 5_000));
            harness.engine.handleMessage(message("live-3", 6_000));

            inFlight.reject(failure);

            result = await attempt;
        });

        expect(result).toEqual({ complete: false, count: 0 });
        expect(delivered(harness)).toEqual(["live-1", "live-2", "live-3"]);
        expect(harness.onError).toHaveBeenCalledWith(failure);
        expect(harness.onError).toHaveBeenCalledWith(listenerFailure);
        expect(rejections).toEqual([]);
    });

    it("replays past a listener that throws and reports the backlog honestly", async () => {
        // Stepping over the bad listener is what keeps the no-partial rule
        // true: an aborted replay would report a miss it had already half made.
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const failure = new Error("listener blew up");

        harness.dispatch.mockImplementation((message) => {
            if (message.id === "m2") {
                throw failure;
            }
        });
        harness.history.mockResolvedValueOnce(
            pages([
                message("m3", 3_000),
                message("m2", 2_000),
                message("m1", 1_000),
                anchor,
            ]),
        );

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: true,
            count: 3,
        });
        expect(delivered(harness)).toEqual(["m1", "m2", "m3"]);
        expect(harness.onError).toHaveBeenCalledWith(failure);
    });

    it("settles even when the app's error handler throws", async () => {
        // `onError` reaches the same user code `error()` callbacks do, and it
        // is reached from inside the failure path: a throw there would strand
        // the gate closed with nothing left to reopen it.
        const harness = anchoredEngine(message("m0", 0));

        harness.history.mockRejectedValueOnce(new Error("history unavailable"));
        harness.onError.mockImplementation(() => {
            throw new Error("error handler blew up");
        });

        const rejections = await withoutUnhandledRejections(async () => {
            await expect(harness.engine.gapDetected()).resolves.toEqual({
                complete: false,
                count: 0,
            });
        });

        expect(rejections).toEqual([]);

        // The gate reopened: live traffic still reaches the app.
        harness.engine.handleMessage(message("live", 4_000));

        expect(delivered(harness)).toEqual(["live"]);
    });
});

describe("coalescing", () => {
    it("hands a second attempt the running one's promise", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const first = harness.engine.gapDetected();
        const second = harness.engine.gapDetected();
        const manual = harness.engine.replayMissed();

        // Identity, not equality: the channel fans one result out to its
        // `recovered` callbacks, and two attempts would fan out twice.
        expect(second).toBe(first);
        expect(manual).toBe(first);
        expect(harness.history).toHaveBeenCalledTimes(1);

        inFlight.resolve(pages([anchor]));

        // Incomplete because the second `gapDetected()` superseded the walk —
        // one attempt and one result, but an honest one.
        await expect(first).resolves.toEqual({ complete: false, count: 0 });
    });

    it("starts a fresh attempt once the previous one has settled", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);

        harness.history.mockResolvedValue(pages([anchor]));

        const first = await harness.engine.gapDetected();
        const second = harness.engine.gapDetected();

        await expect(second).resolves.toEqual(first);
        expect(harness.history).toHaveBeenCalledTimes(2);
    });

    it("reports incomplete when a second gap lands while the walk runs", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        // A `untilAttach` walk is anchored to the attach point it left under,
        // so it cannot see anything published during a *second* outage. The
        // answer it is about to give is no longer one it can back up.
        harness.engine.gapDetected();

        inFlight.resolve(pages([message("m1", 10), anchor]));

        await expect(attempt).resolves.toEqual({
            complete: false,
            count: 0,
        });
    });

    it("replays nothing from a walk a second gap superseded", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        harness.engine.gapDetected();

        inFlight.resolve(pages([message("m1", 10), anchor]));
        await attempt;

        // The no-partial rule: the backlog this walk did collect is a prefix of
        // what was actually missed, and a prefix is worse than an honest miss.
        expect(delivered(harness)).toEqual([]);
    });

    it("still flushes live traffic buffered behind a superseded walk", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();
        const live = message("m9", 90);

        harness.engine.handleMessage(live);
        harness.engine.gapDetected();

        inFlight.resolve(pages([anchor]));
        await attempt;

        // Only the backlog is abandoned; nothing live is ever dropped.
        expect(delivered(harness)).toEqual(["m9"]);
    });

    it("keeps a manual catch-up joining a gap complete", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        // `replayMissed()` reports no new outage — it is a caller asking about
        // the same gap, so the running walk still answers for all of it.
        harness.engine.replayMissed();

        inFlight.resolve(pages([message("m1", 10), anchor]));

        await expect(attempt).resolves.toEqual({
            complete: true,
            count: 1,
        });
    });
});

describe("reset", () => {
    it("drops the cursor, leaving the next gap nothing to anchor to", async () => {
        const harness = anchoredEngine(message("m0", 0));

        harness.engine.reset();

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: false,
            count: 0,
        });
        expect(harness.history).not.toHaveBeenCalled();
    });

    it("discards the buffer and abandons a catch-up that is still running", async () => {
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);

        const attempt = harness.engine.gapDetected();

        harness.engine.handleMessage(message("live", 4_000));
        harness.engine.reset();

        // Settled rather than left hanging, and the buffer goes nowhere: the
        // listeners it would reach are being torn down with the channel.
        await expect(attempt).resolves.toEqual({ complete: false, count: 0 });
        expect(harness.dispatch).not.toHaveBeenCalled();

        inFlight.resolve(pages([message("m1", 1_000), anchor]));
        await settle();

        expect(harness.dispatch).not.toHaveBeenCalled();

        // The abandoned attempt must not swallow the next one.
        const later = message("m9", 9_000);

        harness.engine.handleMessage(later);
        harness.history.mockResolvedValueOnce(pages([later]));

        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: true,
            count: 0,
        });
        expect(harness.history).toHaveBeenCalledTimes(2);
    });

    it("stops a flush in its tracks when a listener resets the channel", async () => {
        // A listener unsubscribing mid-flush is the channel going away. The
        // rest of the drain would only re-anchor the cursor `reset()` just
        // cleared, so it stops where it stands.
        const anchor = message("m0", 0);
        const harness = anchoredEngine(anchor);
        const inFlight = deferredPage();

        harness.history.mockReturnValueOnce(inFlight.promise);
        harness.dispatch.mockImplementation((message) => {
            if (message.id === "live-1") {
                harness.engine.reset();
            }
        });

        const attempt = harness.engine.gapDetected();

        harness.engine.handleMessage(message("live-1", 4_000));
        harness.engine.handleMessage(message("live-2", 5_000));

        inFlight.resolve(pages([anchor]));

        await expect(attempt).resolves.toEqual({ complete: true, count: 0 });
        expect(delivered(harness)).toEqual(["live-1"]);

        // The cursor stayed cleared: the drain did not undo the reset.
        await expect(harness.engine.gapDetected()).resolves.toEqual({
            complete: false,
            count: 0,
        });
        expect(harness.history).toHaveBeenCalledTimes(1);
    });
});

describe("normalizeReplay", () => {
    it("is disabled with the default limit when replay is unconfigured", () => {
        expect(normalizeReplay(undefined)).toEqual({
            enabled: false,
            limit: 100,
        });
    });

    it("enables replay with the default limit for `true`", () => {
        expect(normalizeReplay(true)).toEqual({ enabled: true, limit: 100 });
    });

    it("keeps the default limit when replay is switched off", () => {
        expect(normalizeReplay(false)).toEqual({ enabled: false, limit: 100 });
    });

    it("takes the limit from an options object", () => {
        expect(normalizeReplay({ limit: 250 })).toEqual({
            enabled: true,
            limit: 250,
        });
    });

    it("treats an empty options object as enabled with the default limit", () => {
        expect(normalizeReplay({})).toEqual({ enabled: true, limit: 100 });
    });

    it("falls back to the default limit for a limit below one", () => {
        expect(normalizeReplay({ limit: 0 })).toEqual({
            enabled: true,
            limit: 100,
        });
        expect(normalizeReplay({ limit: -5 })).toEqual({
            enabled: true,
            limit: 100,
        });
    });
});
