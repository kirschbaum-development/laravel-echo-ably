# Replay Missed Events — Design

**Date:** 2026-08-14
**Feature:** Auto-replay engine for missed events (closes issue #3)
**Status:** Approved (full auto-replay engine scope)

## Purpose

When an Ably connection loses continuity (outage longer than the ~2-minute resume
window), the driver should detect the gap, fetch the missed messages from Ably
history, replay them through the app's existing listeners in order, and report the
outcome honestly. Sub-2-minute drops already heal via ably-js resume and never
enter this path.

## Public API (complete)

```ts
// Config (AblyDriverOptions)
ably: {
    replay?: boolean | { limit?: number };  // opt-in; limit = max messages per catch-up, default 100
}

// Channel additions (AblyChannel and subclasses)
channel.recovered(cb: (result: ReplayResult) => void): this;  // registration, cleared on unsubscribe
channel.replayMissed(): Promise<ReplayResult>;                 // manual trigger, same engine

// Types (exported)
type ReplayOptions = boolean | { limit?: number };
type ReplayResult = { complete: boolean; count: number };
```

Rules:

- Replay not configured → cursor tracking off (zero cost), `replayMissed()` rejects
  with a clear "enable ably.replay" error, `recovered()` callbacks never fire.
- Replay configured → the auto engine runs on every detected gap. `recovered`
  callbacks fire after **every** gap-handling attempt (auto or manual) with the
  same result the promise resolves to.
- `complete: false` means "could not fully heal — refetch your state." In that case
  the engine replays **nothing** (partial replay with a hole is worse than an
  honest miss): `count: 0`.

## Engine semantics

### Cursor

- Per-channel last-delivered message `{id, timestamp}` updated on every message
  delivered to the app (including replayed ones, whispers, and messages seen only
  by `listenToAll`).
- No cursor yet (no message ever delivered on the channel) → any catch-up attempt
  returns `{complete: false, count: 0}` (nothing to anchor to).

### Gap detection

- In the channel state handler: `current === "attached" && stateChange.resumed ===
  false && hasAttachedBefore` → gap. First attach is never a gap.
- The buffering gate must flip ON **synchronously inside the state handler**,
  before any post-attach live message can route.

### Catch-up queries

Two strategies sharing one collection/dispatch pipeline:

1. **Gap mode (auto):** `history({ untilAttach: true })`, paginate backwards
   (`PaginatedResult.next()`), collecting messages **newer than the cursor id**.
   Stop when the cursor id is found → `complete: true`. History exhausted or
   `limit` reached without finding the cursor → `complete: false`, discard
   collected messages.
2. **Manual mode (`replayMissed()` outside a gap):** `history({ start:
   cursor.timestamp, direction: "forwards" })`, paginated. Dedupe rules (Ably ids
   are opaque, not ordered — compare by equality only): (a) if the cursor id
   appears in the results, skip everything up to and including it; (b) skip any
   message whose id matches one already delivered live and buffered during this
   attempt. `complete: true` when the pages are exhausted within `limit`;
   `complete: false` if `limit` is hit with pages remaining.

### Ordering guarantee (buffer + flush)

- While a catch-up is running, live messages are buffered, not dispatched
  (`untilAttach` ends at the attach point; live traffic starts after it — no
  overlap in gap mode; manual mode dedupes by id as above).
- After replaying the collected backlog chronologically, the buffer flushes in
  arrival order through the same dispatch path.
- The flush ALWAYS happens (finally-semantics), including when history rejects or
  the engine aborts — live messages must never be lost.
- Buffer safety cap: 1000 messages; exceeding it aborts the catch-up
  (`complete: false`), flushes, and reports via `error()` as well.
- Concurrent attempts: a second gap or `replayMissed()` while a catch-up is
  running coalesces into the running attempt (returns the same promise).

### Failure handling

- History request rejection (e.g. missing `history` capability): fire `error()`
  with the ErrorInfo AND resolve `{complete: false, count: 0}` — never reject the
  auto path; `replayMissed()` resolves with the same result (rejection reserved
  for "replay not configured").

## Architecture

### `src/replay/replay-engine.ts` — isolated, dependency-injected

```ts
type ReplayDeps = {
    history: (params: RealtimeHistoryParams) => Promise<PaginatedResult<InboundMessage>>;
    dispatch: (message: InboundMessage) => void;   // routes to the app's listeners
    onError: (error: unknown) => void;
    limit: number;                                  // normalized, default 100
};

class ReplayEngine {
    constructor(deps: ReplayDeps);
    noteDelivered(message: InboundMessage): void;   // cursor update
    handleMessage(message: InboundMessage): void;   // gate: buffer or (noteDelivered + dispatch)
    gapDetected(): Promise<ReplayResult>;           // auto path; enables buffering synchronously
    replayMissed(): Promise<ReplayResult>;          // manual path
    reset(): void;                                  // clear cursor/buffer (unsubscribe)
}
```

Engine is unit-tested with plain fakes — no ably mock needed.

### AblyChannel wiring — dual-mode message routing

- **Replay OFF (default): the existing per-event ably subscription path is
  byte-for-byte untouched.** All current behavior contracts and tests stand.
- **Replay ON:** the channel registers exactly ONE catch-all ably subscription
  feeding `engine.handleMessage`; `engine.dispatch` routes to an internal
  `routeMessage(message)` that walks the existing listener maps (formatted-name
  match for `listen`-registered wrappers, namespace-stripped delivery for
  `listenToAll`), so `listen`, `listenForWhisper`, `notification`, and
  `listenToAll` all work identically for live, buffered, and replayed messages.
  `listen`/`stopListening` in this mode maintain the internal maps only (no
  per-event ably subscribe/unsubscribe); `unsubscribe()` removes the catch-all,
  calls `engine.reset()`, and clears `recovered` registrations.
- Gap hook: the state handler calls `engine.gapDetected()` and fans the result out
  to `recovered` callbacks. `hasAttachedBefore` tracking lives in the channel.
- Config plumbing: connector normalizes `ably.replay` → `{enabled, limit}` and
  passes it to channel constructors (all three classes — presence channels replay
  regular messages like any channel).

### Presence

- Presence events are NOT in message history and are not replayed. `here()`
  already re-reads on every attach and `presence.enter` re-runs — that heal is
  unchanged and is the documented recovery story for presence state.

## Documentation (README section "Replaying missed events")

Opt-in config + example with `recovered()`; the retention table (no persistence ≈
2 minutes; persist-all rule → 24h free / 72h paid); the `history` capability
requirement (laravel-broadcaster defaults already grant it; custom
`ably-capability` arrays must include it); presence note; the no-partial-replay
rule and what `complete: false` obligates the app to do; `replayMissed()` use case
(e.g. mobile tab thaw).

## Verification

- Engine unit tests (fakes): cursor, both query strategies, pagination, limit,
  no-partial rule, buffer/flush incl. failure flush and cap, coalescing.
- Channel wiring tests (mock harness + new `MockChannel.history` returning
  paginated pages): routing parity in replay mode (listen/listenToAll/whisper/
  notification), gate ordering (live message during catch-up arrives after
  replayed backlog), gap detection (resumed flags), recovered() fan-out,
  replayMissed() rejection when unconfigured, unsubscribe cleanup, presence
  channel replaying regular messages while presence heal is untouched.
- Integration (live sandbox, gated): subscribe with replay on → `detach()` →
  publish 3 via second client → `attach()` → assert gap detected, 3 events
  replayed in order, `recovered` fired `{complete: true, count: 3}`.
- Full gates + CI green. Issue #3 closed with a summary comment on completion.

## Out of scope

- Page-reload `recover` mode (connection recovery key) — README may mention it as
  an ably-js clientOptions passthrough; no driver code, no validation.
- Rewind ergonomics beyond the existing `channelOptions` passthrough.
- Cross-tab cursor persistence (sessionStorage) — future work.
