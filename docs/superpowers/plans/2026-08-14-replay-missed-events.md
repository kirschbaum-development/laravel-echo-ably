# Replay Missed Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The auto-replay engine from `docs/superpowers/specs/2026-08-14-replay-missed-events-design.md` (closes issue #3): gap detection, history catch-up, ordered replay through existing listeners, `recovered()` signal, `replayMissed()`.

**Architecture:** A dependency-injected `ReplayEngine` (cursor + catch-up + buffer gate, no ably coupling) in `src/replay/`; `AblyChannel` gains a replay-mode message-routing path (single catch-all + internal routing) that is ONLY active when replay is configured — the default path stays byte-for-byte untouched; the connector normalizes `ably.replay` config.

**Tech Stack:** unchanged (TS strict, Vitest, browser-lib tsconfig, ably ^2 / laravel-echo ^2.3 peers).

**THE SPEC IS THE REQUIREMENTS DOCUMENT.** Every task: read `docs/superpowers/specs/2026-08-14-replay-missed-events-design.md` first, in full. This plan adds task boundaries, file lists, and test obligations — semantic rules (dedupe, no-partial-replay, flush-always, coalescing, cap) live in the spec and are not repeated here.

## Global Constraints

- TypeScript strict; browser-lib tsconfig (no Node globals in src or tests — Web APIs only)
- TDD per task: failing tests → verify fail → implement → verify pass → commit
- Replay OFF must leave the existing message path untouched — all 149 existing tests keep passing unmodified (except where a task explicitly says otherwise, which is: nowhere)
- Verify exact ably type names against `node_modules/ably/ably.d.ts` before using them (`InboundMessage`, `PaginatedResult`, `RealtimeHistoryParams` are the expected v2 names; adjust to reality, note deviations in the report)
- Commits on `main`, conventional style, each ending with:
  `Claude-Session: https://claude.ai/code/session_016uucCguZchxXnHhrqoqiw9`
- Never `npm publish`. Full gates before every commit: `npm test`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`

---

### Task 1: ReplayEngine

**Files:**
- Create: `src/replay/replay-engine.ts`, `src/replay/types.ts` (or fold types into `src/types.ts` — implementer's call, but `ReplayOptions`/`ReplayResult` must end up exported from `src/index.ts` by Task 3)
- Test: `tests/replay-engine.test.ts` (plain fakes — no ably mock)

**Interfaces (exact — Tasks 2/3 consume these):**

```ts
export type ReplayResult = { complete: boolean; count: number };
export type ReplayOptions = boolean | { limit?: number };
export type NormalizedReplay = { enabled: boolean; limit: number }; // limit default 100
export function normalizeReplay(options: ReplayOptions | undefined): NormalizedReplay;

export type ReplayDeps = {
    history: (params: Record<string, unknown>) => Promise<HistoryPage>;
    dispatch: (message: ReplayMessage) => void;
    onError: (error: unknown) => void;
    limit: number;
};
// ReplayMessage: minimal structural type {id: string; name: string; data: unknown; timestamp: number}
// HistoryPage: structural {items: ReplayMessage[]; hasNext(): boolean; next(): Promise<HistoryPage | null>}
// (structural types so the engine tests need no ably import; Task 2 adapts ably's real
//  PaginatedResult<InboundMessage> to HistoryPage at the boundary)

export class ReplayEngine {
    constructor(deps: ReplayDeps);
    noteDelivered(message: ReplayMessage): void;
    handleMessage(message: ReplayMessage): void;
    gapDetected(): Promise<ReplayResult>;
    replayMissed(): Promise<ReplayResult>;
    reset(): void;
}
```

**Behavior contract (each is a test; semantics per spec):**
1. `handleMessage` outside a catch-up: `noteDelivered` (cursor = {id, timestamp}) + `dispatch`, in that order.
2. `gapDetected()` flips buffering synchronously; `handleMessage` during catch-up buffers (no dispatch, no cursor update yet).
3. Gap mode: backwards pagination with `untilAttach: true`; collects until cursor id found → replays chronologically via `dispatch` (cursor updated per replayed message) → flushes buffer in arrival order → `{complete: true, count: n}`.
4. Cursor id NOT found within limit / history exhausted → dispatch NOTHING from history, flush buffer, `{complete: false, count: 0}`.
5. No cursor yet → `{complete: false, count: 0}`, no history call in gap mode.
6. Manual mode: forwards-from-cursor-timestamp pagination; dedupe rules (a)/(b) per spec; limit semantics per spec.
7. History rejection → `onError(error)`, buffer still flushes, resolves `{complete: false, count: 0}` (never rejects).
8. Buffer cap 1000 → abort catch-up, flush, `onError`, `{complete: false, count: 0}`.
9. Coalescing: `gapDetected()`/`replayMissed()` during a running attempt returns the same promise (test by identity or by asserting single history-call sequence).
10. `reset()` clears cursor and buffer; a post-reset gap behaves as contract 5.
11. `normalizeReplay`: `undefined→{enabled:false,limit:100}`, `true→{enabled:true,limit:100}`, `{limit:250}→{enabled:true,limit:250}`, `false→{enabled:false,limit:100}`.

- [ ] Write failing tests for all 11 → verify fail → implement → verify pass → full gates → commit `feat: replay engine with cursor tracking and history catch-up`

---

### Task 2: Replay-mode message routing in AblyChannel + mock history

**Files:**
- Modify: `src/channels/ably-channel.ts`, `tests/mocks/ably.ts`
- Test: `tests/ably-channel-replay-routing.test.ts` (new file — keep `tests/ably-channel.test.ts` untouched to prove the default path is stable)

**Interfaces:**
- Consumes: nothing from Task 1 yet (routing is engine-agnostic; the gate hook lands in Task 3). Design the routing so Task 3 can interpose `engine.handleMessage` between the catch-all and `routeMessage`.
- Produces:
  - `AblyChannel` constructor gains an optional 5th param `replay?: NormalizedReplay` (default `{enabled:false,limit:100}`); store as `protected replayConfig`.
  - `protected routeMessage(message): void` — walks the existing listener maps: formatted-name-matched wrappers (the same keys `listen()` registers under, so leading-dot/`listenForWhisper`/`notification` semantics hold) and `listenToAll` callbacks (namespace-stripped, same formatting as today).
  - When `replayConfig.enabled`: `subscribe()` registers ONE catch-all ably subscription that calls a `protected onIncoming(message)` (Task 3 will make this consult the engine; for now it calls `routeMessage` directly); `listen`/`stopListening`/`listenToAll`/`stopListeningToAll` maintain internal maps only (no per-event ably subscribe/unsubscribe); `unsubscribe()` removes the catch-all and behaves as today otherwise.
  - When disabled: existing code path, unchanged.
- `MockChannel.history` added to the harness: `vi.fn()` resolving a paginated result; plus an exported helper `historyPages(pages: Message[][])` building `{items, hasNext, next}` chains for tests.

**Behavior contract (tests, all with `replay: {enabled: true, limit: 100}`):**
1. `listen(".OrderShipped")` and `listen("OrderShipped")` receive matching emitted messages with identical formatting semantics to the default path (assert against a side-by-side default-mode channel in the same test file).
2. `listenForWhisper` + `notification` round-trips work.
3. `listenToAll` receives every message with the namespace-stripping contract.
4. `stopListening(event, cb)` removes exactly that callback; other callbacks for the same event and the catch-all keep working; NO per-event ably `subscribe`/`unsubscribe` calls occur in replay mode (assert the underlying mock).
5. Exactly one ably catch-all subscription regardless of listener count; `unsubscribe()` removes it.
6. Default-mode (replay disabled) channel in the same suite: per-event ably subscriptions still happen (guard test that the mode switch is honored).
7. Existing `tests/ably-channel.test.ts` passes unmodified (full-suite run is the proof).

- [ ] Write failing tests → verify fail → implement → verify → full gates → commit `feat: replay-mode message routing for channels`

---

### Task 3: Gap detection, engine wiring, public API, config plumbing

**Files:**
- Modify: `src/channels/ably-channel.ts` (gap hook + engine + `recovered()`/`replayMissed()`), `src/channels/ably-private-channel.ts` and `src/channels/ably-presence-channel.ts` (their declared constructors must forward the new optional replay param), `src/connector.ts` (normalize + pass replay config), `src/types.ts` (add `replay?: ReplayOptions` to `AblyDriverOptions`), `src/index.ts` (export `ReplayOptions`, `ReplayResult`)
- Test: `tests/ably-channel-replay.test.ts`, additions to `tests/connector.test.ts`

**Interfaces:**
- Consumes: `ReplayEngine`, `normalizeReplay`, `NormalizedReplay` (Task 1); `routeMessage`/`onIncoming` seam (Task 2).
- Produces (public API, exactly per spec):
  - `recovered(cb: (result: ReplayResult) => void): this` — registration list, cleared on `unsubscribe()`, fan-out after every gap-handling attempt.
  - `replayMissed(): Promise<ReplayResult>` — rejects with `Error` containing "ably.replay" when replay not configured; otherwise delegates to the engine and fans out to `recovered` callbacks too.
  - Connector: `ably.replay` normalized once and passed to all three channel constructors; `AblyDriverOptions.replay?: ReplayOptions`.
  - Engine adapter: ably `PaginatedResult<InboundMessage>` → `HistoryPage`; `deps.history` calls `subscription.history(params)`; `deps.dispatch` → `routeMessage`; `deps.onError` → `dispatchError`.

**Behavior contract (tests):**
1. Wiring: with replay enabled, incoming messages flow catch-all → `engine.handleMessage` → `routeMessage`, and the cursor advances (observable via a manual `replayMissed()` whose history call receives `start: cursor.timestamp`).
2. Gap detection: `attached(resumed: false)` after a previous attach triggers exactly one engine catch-up; first attach and `attached(resumed: true)` do not.
3. End-to-end gap heal (mock history pages): 3 missed messages replay in order to `listen` callbacks BEFORE a live message emitted mid-catch-up, `recovered` fires `{complete: true, count: 3}`.
4. Cursor-not-found path: `recovered` fires `{complete: false, count: 0}`, nothing replayed, live buffer flushed.
5. `replayMissed()` without config → rejects; with config → resolves and fans out.
6. History rejection → `error()` callbacks get the reason AND `recovered` fires `{complete: false, count: 0}`.
7. `unsubscribe()` clears `recovered` registrations and resets the engine.
8. Presence channel with replay enabled: regular messages replay; `presence.enter`/`here()` behavior unchanged (existing presence tests keep passing; one explicit test that a presence channel replays a missed regular message).
9. Connector: `ably: {replay: true}` reaches channels (assert a gap on a connector-built channel heals); no `replay` config → `replayMissed()` rejects (proves default-off plumbing).
10. 40160-retry interplay: the re-attach after a token upgrade that reports `resumed: false` triggers the gap flow (this is correct behavior — note it in a test name so it's pinned deliberately).

- [ ] Write failing tests → verify fail → implement → verify → full gates → commit `feat: auto-replay on continuity gaps with recovered() and replayMissed()`

---

### Task 4: README, integration test, issue close, finalization

**Files:**
- Modify: `README.md`, `tests/integration/sandbox.test.ts`
- No src changes expected; if the live run exposes a defect, fix it with a test (cross-task fixes flagged in the report, as Task 9 did for presence).

**Steps:**
- [ ] README section "Replaying missed events" per the spec's Documentation list (config example with `recovered()`, retention table, `history` capability note, presence note, no-partial-replay rule, `replayMissed()` use case). Update the error-table/feature mentions if any now-stale sentence claims replay is unavailable.
- [ ] Integration test (gated, same harness as existing suite): subscribe with `replay: true` → capture a delivered message (cursor anchor) → `detach()` the underlying channel → publish 3 via the second raw client → `attach()` → assert the 3 events arrive in order via `listen` and `recovered` fired `{complete: true, count: 3}`. Run it live if `ABLY_SANDBOX_KEY` is available in the environment; otherwise verify it skips cleanly and report that the live run is pending a key.
- [ ] Full gates + push + `gh run watch` until CI green.
- [ ] Close issue #3 with a summary comment (`gh issue close 3 --comment "..."`) describing the shipped API and linking the spec.
- [ ] Final verification: cold `npm ci` + full suite; report counts.
