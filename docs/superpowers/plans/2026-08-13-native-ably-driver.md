# Native Ably Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone npm package `@kirschbaum-development/laravel-echo-ably` providing a native ably-js v2 connector for Laravel Echo 2.x.

**Architecture:** `AblyConnector extends Connector` (imported from `laravel-echo`) plus three channel classes wrap an `Ably.Realtime` client. A `TokenManager` owns the JWT auth lifecycle against `POST /broadcasting/auth` (the `ably/laravel-broadcaster` server contract). Channel classes gate `attach()` on `TokenManager.ensureCapability()`, so no ably-js internals are patched. Unit tests inject a mock Realtime via the `options.ably.client` escape hatch — no module mocking for connector/channel tests.

**Tech Stack:** TypeScript (strict), Vite lib build (ESM + d.ts via vite-plugin-dts), Vitest, ESLint 9 + Prettier 3, Node >= 20. Peer deps: `laravel-echo ^2.0`, `ably ^2.0`.

**Reference material available on this machine:**
- The spec: `docs/superpowers/specs/2026-08-13-native-ably-driver-design.md` (READ IT FIRST for every task)
- laravel-echo 2.x source (base classes you extend): `/Users/luisdalmolin/Projects/open-source/echo/packages/laravel-echo/src/` — especially `connector/connector.ts` (abstract `Connector`, `EchoOptionsWithDefaults`), `channel/channel.ts` (abstract `Channel`), `channel/pusher-channel.ts` (the surface to mirror), `util/event-formatter.ts`
- laravel-echo tooling to mirror: `/Users/luisdalmolin/Projects/open-source/echo/packages/laravel-echo/{package.json,tsconfig.json,vite.config.ts}`
- ably-js v2 typings (after `npm install`): `node_modules/ably/ably.d.ts`

## Global Constraints

- Package name: `@kirschbaum-development/laravel-echo-ably` (scoped, `"publishConfig": {"access": "public"}`)
- License: MIT. Node engine: `>=20`. TypeScript strict mode.
- Peer dependencies exactly: `"laravel-echo": "^2.0"`, `"ably": "^2.0"` (required, not optional)
- Users never type Ably colon-prefixed names; the package maps Echo names to `public:`/`private:`/`presence:` internally
- `here()` follows Pusher/Echo semantics: member list on subscription success, not on every membership change
- Every code task is TDD: failing test → verify fail → implement → verify pass → commit
- Never run `npm publish`. Never commit `node_modules` or `dist`
- All commits on `main`, message style: conventional (`feat: ...`, `test: ...`, `chore: ...`), each ending with the trailer line `Claude-Session: https://claude.ai/code/session_016uucCguZchxXnHhrqoqiw9`
- Run commands from the repo root: `/Users/luisdalmolin/Projects/open-source/laravel-echo-ably`

---

### Task 1: Scaffold — tooling, configs, CI, smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`, `LICENSE.md`, `.github/workflows/ci.yml`, `src/index.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: working `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; `src/index.ts` exporting `export const VERSION = "0.1.0";` (later tasks add exports to this file)

- [ ] **Step 1: Write package.json**

Mirror `/Users/luisdalmolin/Projects/open-source/echo/packages/laravel-echo/package.json` for structure/versions, adapted:

```json
{
    "name": "@kirschbaum-development/laravel-echo-ably",
    "version": "0.1.0",
    "description": "Native Ably (ably-js v2) driver for Laravel Echo 2.x",
    "license": "MIT",
    "type": "module",
    "main": "dist/index.js",
    "module": "dist/index.js",
    "types": "dist/index.d.ts",
    "exports": {
        ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
    },
    "files": ["dist"],
    "publishConfig": { "access": "public" },
    "repository": { "type": "git", "url": "https://github.com/kirschbaum-development/laravel-echo-ably" },
    "scripts": {
        "build": "vite build",
        "lint": "eslint --config eslint.config.js \"src/**/*.ts\" \"tests/**/*.ts\"",
        "format": "prettier --write .",
        "format:check": "prettier --check .",
        "typecheck": "tsc --noEmit",
        "test": "vitest run",
        "test:watch": "vitest"
    },
    "engines": { "node": ">=20" },
    "peerDependencies": { "ably": "^2.0", "laravel-echo": "^2.0" }
}
```

Then `npm install --save-dev typescript vite vite-plugin-dts vitest eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier` and `npm install --save-dev ably laravel-echo` (dev copies of the peers for tests/types).

- [ ] **Step 2: Write tsconfig.json, vite.config.ts, eslint.config.js, .prettierrc.json, .gitignore, LICENSE.md**

Copy the shape from the laravel-echo package (paths above), adjusting: single entry `src/index.ts`, `formats: ["es"]`, `external: ["ably", "laravel-echo"]`, dts plugin on. Prettier: 4-space indent to match laravel-echo style. `.gitignore`: `node_modules/`, `dist/`, `coverage/`, `.DS_Store`. LICENSE.md: MIT, copyright Kirschbaum Development Group.

- [ ] **Step 3: Write the smoke test**

```ts
// tests/smoke.test.ts
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index";

describe("package", () => {
    it("exports a version", () => {
        expect(VERSION).toBe("0.1.0");
    });

    it("can import laravel-echo base classes", async () => {
        const { Connector, Channel } = await import("laravel-echo");
        expect(Connector).toBeDefined();
        expect(Channel).toBeDefined();
    });
});
```

- [ ] **Step 4: Run test to verify it fails** — `npm test` → FAIL (`src/index.ts` missing)

- [ ] **Step 5: Write `src/index.ts`** — `export const VERSION = "0.1.0";`

- [ ] **Step 6: Verify everything passes** — `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` all succeed; `dist/index.js` + `dist/index.d.ts` exist

- [ ] **Step 7: Write CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
    push: { branches: [main] }
    pull_request:
jobs:
    test:
        runs-on: ubuntu-latest
        strategy:
            matrix: { node: [20, 22] }
        steps:
            - uses: actions/checkout@v6
            - uses: actions/setup-node@v7
              with: { node-version: "${{ matrix.node }}", cache: npm }
            - run: npm ci
            - run: npm run lint
            - run: npm run format:check
            - run: npm run typecheck
            - run: npm test
            - run: npm run build
```

- [ ] **Step 8: Commit** — `chore: scaffold package tooling and CI`

---

### Task 2: Types + channel-name utilities

**Files:**
- Create: `src/types.ts`, `src/util/channel-name.ts`
- Test: `tests/channel-name.test.ts`
- Modify: `src/index.ts` (re-export types + utils)

**Interfaces:**
- Produces (exact — later tasks import these):

```ts
// src/types.ts
import type { ChannelOptions, ClientOptions, Realtime } from "ably";

export type TokenResponse = { token: string; info?: unknown };

export type RequestTokenFn = (
    channelName: string,
    existingToken: string | null,
) => Promise<TokenResponse>;

export type AblyDriverOptions = {
    clientOptions?: Partial<ClientOptions>;
    client?: Realtime;
    requestTokenFn?: RequestTokenFn;
    channelOptions?: Record<string, ChannelOptions>;
};

// src/util/channel-name.ts
export function baseName(name: string): string;
export function toPublic(name: string): string; // "public:" + baseName(name)
export function toPrivate(name: string): string; // "private:" + baseName(name)
export function toPresence(name: string): string; // "presence:" + baseName(name)
export function normalize(name: string): string;
export function isGuarded(name: string): boolean; // starts with "private:" or "presence:"
```

- [ ] **Step 1: Write failing tests**

```ts
// tests/channel-name.test.ts
import { describe, expect, it } from "vitest";
import { baseName, isGuarded, normalize, toPresence, toPrivate, toPublic } from "../src/util/channel-name";

describe("baseName", () => {
    it.each([
        ["orders", "orders"],
        ["private-orders", "orders"],
        ["presence-chat", "chat"],
        ["private-encrypted-secrets", "secrets"],
        ["public:orders", "orders"],
        ["private:orders", "orders"],
        ["presence:chat", "chat"],
        ["private-with-dashes-in-name", "with-dashes-in-name"],
    ])("baseName(%s) === %s", (input, expected) => {
        expect(baseName(input)).toBe(expected);
    });
});

describe("prefixing", () => {
    it("builds ably names from any input style", () => {
        expect(toPublic("orders")).toBe("public:orders");
        expect(toPrivate("orders")).toBe("private:orders");
        expect(toPrivate("private-orders")).toBe("private:orders");
        expect(toPresence("presence-chat")).toBe("presence:chat");
    });
});

describe("normalize", () => {
    it.each([
        ["private-orders", "private:orders"],
        ["presence-chat", "presence:chat"],
        ["private:orders", "private:orders"],
        ["presence:chat", "presence:chat"],
        ["public:orders", "public:orders"],
        ["orders", "public:orders"],
    ])("normalize(%s) === %s", (input, expected) => {
        expect(normalize(input)).toBe(expected);
    });
});

describe("isGuarded", () => {
    it("only private/presence ably names are guarded", () => {
        expect(isGuarded("private:orders")).toBe(true);
        expect(isGuarded("presence:chat")).toBe(true);
        expect(isGuarded("public:orders")).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run tests/channel-name.test.ts` → FAIL (module missing)

- [ ] **Step 3: Implement**

```ts
// src/util/channel-name.ts
const STRIP_PREFIXES = [
    "public:",
    "private-encrypted-",
    "private:",
    "private-",
    "presence:",
    "presence-",
] as const;

export function baseName(name: string): string {
    for (const prefix of STRIP_PREFIXES) {
        if (name.startsWith(prefix)) {
            return name.slice(prefix.length);
        }
    }
    return name;
}

export function toPublic(name: string): string {
    return "public:" + baseName(name);
}

export function toPrivate(name: string): string {
    return "private:" + baseName(name);
}

export function toPresence(name: string): string {
    return "presence:" + baseName(name);
}

export function normalize(name: string): string {
    if (name.startsWith("private:") || name.startsWith("presence:") || name.startsWith("public:")) {
        return name;
    }
    if (name.startsWith("private-encrypted-") || name.startsWith("private-")) {
        return toPrivate(name);
    }
    if (name.startsWith("presence-")) {
        return toPresence(name);
    }
    return toPublic(name);
}

export function isGuarded(name: string): boolean {
    return name.startsWith("private:") || name.startsWith("presence:");
}
```

Write `src/types.ts` exactly as in the Interfaces block (with real bodies — it is type-only). Re-export both modules from `src/index.ts`.

- [ ] **Step 4: Verify pass** — `npx vitest run tests/channel-name.test.ts` → PASS; `npm run typecheck` → clean
- [ ] **Step 5: Commit** — `feat: channel name mapping and driver option types`

---

### Task 3: JWT parsing

**Files:**
- Create: `src/auth/jwt.ts`
- Test: `tests/jwt.test.ts`

**Interfaces:**
- Produces:

```ts
// src/auth/jwt.ts
import type { TokenDetails } from "ably";

export type ParsedJwt = {
    clientId: string | null;
    issued: number; // ms epoch
    expires: number; // ms epoch
    capability: Record<string, string[]>; // parsed x-ably-capability, {} when absent
};

export function parseJwt(jwt: string): ParsedJwt; // throws Error("Invalid JWT") on malformed input
export function toTokenDetails(jwt: string): TokenDetails;
```

- [ ] **Step 1: Write failing tests**

Build tokens in-test with a helper (no signature needed — parse-only):

```ts
// tests/jwt.test.ts
import { describe, expect, it } from "vitest";
import { parseJwt, toTokenDetails } from "../src/auth/jwt";

function makeJwt(payload: Record<string, unknown>): string {
    const b64 = (obj: unknown) =>
        Buffer.from(JSON.stringify(obj)).toString("base64url");
    return `${b64({ alg: "HS256", typ: "JWT", kid: "keyName" })}.${b64(payload)}.signature`;
}

const payload = {
    iat: 1_700_000_000,
    exp: 1_700_028_800,
    "x-ably-clientId": "user-42",
    "x-ably-capability": JSON.stringify({
        "public:*": ["subscribe", "history", "channel-metadata"],
        "private:orders": ["*"],
    }),
};

describe("parseJwt", () => {
    it("extracts claims and converts seconds to ms", () => {
        const parsed = parseJwt(makeJwt(payload));
        expect(parsed.clientId).toBe("user-42");
        expect(parsed.issued).toBe(1_700_000_000_000);
        expect(parsed.expires).toBe(1_700_028_800_000);
        expect(parsed.capability["private:orders"]).toEqual(["*"]);
    });

    it("defaults missing claims", () => {
        const parsed = parseJwt(makeJwt({ iat: 1, exp: 2 }));
        expect(parsed.clientId).toBeNull();
        expect(parsed.capability).toEqual({});
    });

    it("throws on malformed input", () => {
        expect(() => parseJwt("not-a-jwt")).toThrow("Invalid JWT");
        expect(() => parseJwt("a.###.c")).toThrow("Invalid JWT");
    });
});

describe("toTokenDetails", () => {
    it("produces ably TokenDetails", () => {
        const details = toTokenDetails(makeJwt(payload));
        expect(details.token).toBe(makeJwt(payload));
        expect(details.clientId).toBe("user-42");
        expect(details.expires).toBe(1_700_028_800_000);
        expect(details.issued).toBe(1_700_000_000_000);
    });
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run tests/jwt.test.ts` → FAIL

- [ ] **Step 3: Implement**

```ts
// src/auth/jwt.ts
import type { TokenDetails } from "ably";

export type ParsedJwt = {
    clientId: string | null;
    issued: number;
    expires: number;
    capability: Record<string, string[]>;
};

function decodeSegment(segment: string): Record<string, unknown> {
    // atob-based base64url decode: works in browsers and Node >= 20
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
        atob(base64)
            .split("")
            .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
            .join(""),
    );
    return JSON.parse(json) as Record<string, unknown>;
}

export function parseJwt(jwt: string): ParsedJwt {
    const segments = jwt.split(".");
    if (segments.length !== 3) {
        throw new Error("Invalid JWT");
    }
    let payload: Record<string, unknown>;
    try {
        payload = decodeSegment(segments[1]);
    } catch {
        throw new Error("Invalid JWT");
    }
    const capabilityRaw = payload["x-ably-capability"];
    return {
        clientId: typeof payload["x-ably-clientId"] === "string" ? (payload["x-ably-clientId"] as string) : null,
        issued: typeof payload.iat === "number" ? payload.iat * 1000 : 0,
        expires: typeof payload.exp === "number" ? payload.exp * 1000 : 0,
        capability: typeof capabilityRaw === "string" ? (JSON.parse(capabilityRaw) as Record<string, string[]>) : {},
    };
}

export function toTokenDetails(jwt: string): TokenDetails {
    const parsed = parseJwt(jwt);
    return {
        token: jwt,
        clientId: parsed.clientId ?? undefined,
        issued: parsed.issued,
        expires: parsed.expires,
        capability: JSON.stringify(parsed.capability),
    } as TokenDetails;
}
```

- [ ] **Step 4: Verify pass**, plus `npm run typecheck`
- [ ] **Step 5: Commit** — `feat: parse broadcaster JWTs into ably TokenDetails`

---

### Task 4: TokenManager

**Files:**
- Create: `src/auth/token-manager.ts`
- Test: `tests/token-manager.test.ts`

**Interfaces:**
- Consumes: `parseJwt`/`toTokenDetails` (Task 3), `isGuarded` (Task 2), `AblyDriverOptions`/`TokenResponse` (Task 2)
- Produces:

```ts
// src/auth/token-manager.ts
import type { Realtime, TokenDetails } from "ably";
import type { AblyDriverOptions } from "../types";

export type TokenManagerEchoOptions = {
    authEndpoint: string;
    auth: { headers: Record<string, string> };
};

export class TokenManager {
    constructor(echoOptions: TokenManagerEchoOptions, driverOptions: AblyDriverOptions);
    setClient(client: Realtime): void;
    // resolves when the current token covers channelName; requests/upgrades otherwise.
    // {force: true} always requests a fresh token (40160 recovery).
    ensureCapability(channelName: string, opts?: { force?: boolean }): Promise<void>;
    presenceInfo(channelName: string): unknown; // info captured from the auth response
    currentToken(): string | null;
    reset(): void; // drop cached token state (40102 recovery / logout)
    // ably-js v2 authCallback signature; wire into ClientOptions.authCallback
    authCallback: (tokenParams: unknown, callback: (error: unknown, tokenDetails: TokenDetails | null) => void) => void;
}
```

Behavior contract (test each):
1. `ensureCapability("public:foo")` resolves immediately, no HTTP.
2. First guarded call POSTs `authEndpoint` with JSON body `{channel_name, token: null}` and headers `{"Content-Type": "application/json", ...auth.headers}`; stores token; calls `client.auth.authorize(null, {token})` when a client is set.
3. Second call for a channel already in the token's parsed capability (or covered by a `*` / `namespace:*` wildcard key) resolves with no HTTP.
4. Uncovered channel → POSTs again with `token: <current>` (capability accretion happens server-side).
5. Concurrent `ensureCapability` calls serialize: two uncovered channels requested simultaneously produce two sequential POSTs, the second carrying the first's token.
6. Non-2xx response → rejects with `Error` containing status; token state unchanged.
7. Token within 30s of expiry counts as not covering → refresh.
8. `requestTokenFn` (when provided) replaces fetch entirely.
9. Presence responses' `info` retrievable via `presenceInfo(channelName)`.
10. `authCallback` invokes callback with current TokenDetails (fetching `public:*`-only token via one POST with `channel_name: null` if none cached yet... **No** — keep it simple and deterministic: if no token is cached, `authCallback` calls back with an error asking for a channel subscription first; ably-js only invokes it after we set `useTokenAuth` and we always `ensureCapability` before attach, so a cached token exists in practice).
11. `reset()` clears token + capability so the next call re-fetches.

- [ ] **Step 1: Write failing tests** — cover the 11 behaviors. Use `vi.stubGlobal("fetch", vi.fn())` returning `new Response(JSON.stringify({token}), {status: 200})`; build JWTs with the same `makeJwt` helper as Task 3 (extract it to `tests/helpers.ts` and update `tests/jwt.test.ts` to import it). Use `vi.useFakeTimers()` + `vi.setSystemTime()` for the expiry test. Example for behavior 5:

```ts
it("serializes concurrent token requests, second carries first's token", async () => {
    const tokenA = makeJwt({ iat: NOW_S, exp: NOW_S + 3600, "x-ably-capability": JSON.stringify({ "private:a": ["*"] }) });
    const tokenB = makeJwt({ iat: NOW_S, exp: NOW_S + 3600, "x-ably-capability": JSON.stringify({ "private:a": ["*"], "private:b": ["*"] }) });
    const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ token: tokenA }))
        .mockResolvedValueOnce(jsonResponse({ token: tokenB }));
    vi.stubGlobal("fetch", fetchMock);

    const manager = new TokenManager(ECHO_OPTIONS, {});
    await Promise.all([
        manager.ensureCapability("private:a"),
        manager.ensureCapability("private:b"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).token).toBe(tokenA);
});
```

- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement.** Core shape:

```ts
export class TokenManager {
    private parsed: ParsedJwt | null = null;
    private token: string | null = null;
    private client: Realtime | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private info = new Map<string, unknown>();

    private covers(channelName: string): boolean {
        if (!this.parsed || !this.token) return false;
        if (this.parsed.expires - Date.now() < 30_000) return false;
        const capability = this.parsed.capability;
        if (capability[channelName] || capability["*"]) return true;
        const namespace = channelName.split(":")[0];
        return Boolean(capability[`${namespace}:*`]);
    }

    ensureCapability(channelName: string, opts: { force?: boolean } = {}): Promise<void> {
        if (!isGuarded(channelName)) return Promise.resolve();
        const run = this.queue.then(async () => {
            if (!opts.force && this.covers(channelName)) return;
            const response = this.driverOptions.requestTokenFn
                ? await this.driverOptions.requestTokenFn(channelName, this.token)
                : await this.requestToken(channelName);
            if (response.info !== undefined) this.info.set(channelName, response.info);
            this.token = response.token;
            this.parsed = parseJwt(response.token);
            if (this.client) await this.client.auth.authorize(null, { token: this.token });
        });
        // keep the chain alive after failures so later requests still run
        this.queue = run.catch(() => undefined);
        return run;
    }
    // requestToken(): fetch POST authEndpoint, JSON body {channel_name, token},
    // headers {"Content-Type": "application/json", ...auth.headers};
    // non-2xx → throw new Error(`Auth request failed with status ${status}`)
}
```

- [ ] **Step 4: Verify pass**; full suite `npm test`; `npm run typecheck`
- [ ] **Step 5: Commit** — `feat: capability-aware token manager for broadcasting auth`

---

### Task 5: Mock Ably harness + AblyChannel

**Files:**
- Create: `tests/mocks/ably.ts`, `src/channels/ably-channel.ts`
- Test: `tests/ably-channel.test.ts`

**Interfaces:**
- Consumes: `TokenManager` (Task 4 — constructor-injected; tests may pass a stub `{ ensureCapability: vi.fn().mockResolvedValue(undefined), presenceInfo: () => undefined }` cast to `TokenManager`), `EventFormatter` from `laravel-echo`
- Produces:

```ts
// tests/mocks/ably.ts — used by Tasks 5-8
export class MockChannel {
    name: string;
    state: string; // "initialized" | "attaching" | "attached" | "failed" | ...
    presence: MockPresence;
    attach: Mock; detach: Mock; subscribe: Mock; unsubscribe: Mock; publish: Mock;
    on(listener): void; on(event, listener): void; off(): void;
    emitStateChange(change: { current: string; previous?: string; reason?: unknown; resumed?: boolean }): void;
    emitMessage(message: { name: string; data: unknown }): void; // fires subscribe listeners (filtered + catch-all)
}
export class MockPresence {
    enter: Mock; leave: Mock; get: Mock; // get resolves [] by default
    subscribe: Mock; unsubscribe: Mock;
    emit(action: "enter" | "update" | "leave", member: { clientId: string; data: unknown }): void;
}
export class MockRealtime {
    channels: { get(name, options?): MockChannel; released: string[]; requestedOptions: Record<string, unknown> };
    connection: { state: string; key: string; on: ...; off: ...; emitStateChange(change): void };
    auth: { clientId: string | null; authorize: Mock };
    close: Mock; connect: Mock;
}
export function createMockRealtime(): MockRealtime;

// src/channels/ably-channel.ts
import { Channel } from "laravel-echo";
export class AblyChannel extends Channel {
    constructor(ably: Realtime, name: string /* resolved ably name */, options: EchoOptionsWithDefaults<any>, tokenManager: TokenManager);
    name: string;
    subscription: RealtimeChannel; // the underlying ably channel (created in subscribe())
    ready: Promise<void>; // resolves once attach() has been initiated post-auth
    subscribe(): Promise<void>;
    unsubscribe(): void;
    listen(event: string, callback: CallableFunction): this;
    listenToAll(callback: CallableFunction): this;
    stopListening(event: string, callback?: CallableFunction): this;
    stopListeningToAll(callback?: CallableFunction): this;
    subscribed(callback: CallableFunction): this;
    error(callback: CallableFunction): this;
    on(event: string, callback: CallableFunction): this; // raw ably event name, no formatting
}
```

Behavior contract (test each):
1. `subscribe()` awaits `tokenManager.ensureCapability(name)` before `channels.get` + `attach()` (assert ordering via call log).
2. `channelOptions` matching the resolved name are passed to `channels.get(name, options)`.
3. `listen(".OrderShipped", cb)` and `listen("OrderShipped", cb)` respect `EventFormatter` + `options.namespace` (mirror `PusherChannel.listen`); message wrapper calls `cb(message.data)`.
4. `stopListening` removes exactly the given callback's wrapper (other callbacks for the same event survive); without callback removes all for the event.
5. `listenToAll` strips the namespace prefix like `PusherChannel.listenToAll` (formatted as `"." + event` for foreign events) and ignores nothing (no `pusher:` filtering needed — Ably meta events don't arrive via `subscribe`).
6. `subscribed(cb)` fires on state change to `attached`. `error(cb)` fires when a state change carries a `reason`, and buffers: an error occurring before `error(cb)` registration is delivered on registration.
7. `ensureCapability` rejection routes to `error()` callbacks, no unhandled rejection.
8. `unsubscribe()` calls `channel.unsubscribe()`, `channel.off()`, `channel.detach()`.
9. Listener registrations made before `ready` resolves are applied after (queued through `ready.then(...)`).

- [ ] **Step 1: Write the mock harness** (plain code, no test yet — it is test infrastructure; keep every Mock a `vi.fn()` so tests can assert)
- [ ] **Step 2: Write failing tests** for the 9 behaviors, constructing `new AblyChannel(createMockRealtime() as unknown as Realtime, "private:orders", OPTIONS, stubTokenManager)` with `OPTIONS = { namespace: "App.Events", ... }`
- [ ] **Step 3: Verify fail**
- [ ] **Step 4: Implement `AblyChannel`.** Key mechanics: constructor stores deps, sets `this.ready = this.subscribe()`. `subscribe()` = `await tokenManager.ensureCapability(this.name)` → `this.subscription = ably.channels.get(this.name, this.resolveChannelOptions())` → register one channel-wide state listener → `await this.subscription.attach()`, all wrapped in try/catch → `this.dispatchError(err)`. Maintain `listeners: Map<string, Map<CallableFunction, Function>>` for wrapper bookkeeping; every underlying subscribe/unsubscribe chained on `this.ready.then(...)` and `.catch(() => {})`. `dispatchError` stores `lastError` and invokes registered error callbacks; `error(cb)` replays `lastError` if present.
- [ ] **Step 5: Verify pass**; full suite; typecheck
- [ ] **Step 6: Commit** — `feat: AblyChannel with auth-gated attach and echo event semantics`

---

### Task 6: AblyPrivateChannel

**Files:**
- Create: `src/channels/ably-private-channel.ts`
- Test: `tests/ably-private-channel.test.ts`

**Interfaces:**
- Consumes: `AblyChannel` (Task 5), mock harness
- Produces:

```ts
export class AblyPrivateChannel extends AblyChannel {
    whisper(eventName: string, data: Record<string, unknown>): this;
}
```

Behavior contract:
1. `whisper("typing", {a: 1})` publishes raw name `client-typing` with the data (no namespace formatting) via `channel.publish`, chained on `ready`.
2. Publish rejection routes to `error()` callbacks.
3. Channel state `failed` with `reason.code === 40160` triggers exactly one `tokenManager.ensureCapability(name, {force: true})` + re-`attach()`; a second consecutive 40160 surfaces via `error()` without a second retry (reset the retry latch on successful `attached`).
4. `listenForWhisper` (inherited from Echo's abstract `Channel`) receives whispers end-to-end: `emitMessage({name: "client-typing", data})` reaches the callback.

- [ ] **Step 1: Write failing tests** for the 4 behaviors
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement** (40160 handling lives in an override of the state-listener hook from Task 5 — make `AblyChannel`'s state handler call a protected `onChannelFailed(change)` that the private channel overrides)
- [ ] **Step 4: Verify pass**; full suite; typecheck
- [ ] **Step 5: Commit** — `feat: private channels with whispers and capability retry`

---

### Task 7: AblyPresenceChannel

**Files:**
- Create: `src/channels/ably-presence-channel.ts`
- Test: `tests/ably-presence-channel.test.ts`

**Interfaces:**
- Consumes: `AblyPrivateChannel` (Task 6), `TokenManager.presenceInfo` (Task 4), mock harness
- Produces:

```ts
import type { PresenceChannel } from "laravel-echo";
export class AblyPresenceChannel extends AblyPrivateChannel implements PresenceChannel {
    here(callback: CallableFunction): this;
    joining(callback: CallableFunction): this;
    leaving(callback: CallableFunction): this;
}
```

Behavior contract:
1. On state `attached`, calls `presence.enter(tokenManager.presenceInfo(name))`.
2. `here(cb)`: on each `attached`, `presence.get()` → `cb(members.map(m => m.data))` — NOT on membership changes.
3. `joining(cb)` fires with `member.data` for presence `enter` and `update` actions; `leaving(cb)` for `leave`.
4. `unsubscribe()` calls `presence.leave()` and `presence.unsubscribe()` before super's teardown.

- [ ] **Step 1: Write failing tests** (4 behaviors) — drive with `mockChannel.emitStateChange({current: "attached"})` and `mockPresence.emit("enter", {clientId: "u1", data: {id: 1}})`
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Verify pass**; full suite; typecheck
- [ ] **Step 5: Commit** — `feat: presence channels with pusher-parity here() semantics`

---

### Task 8: AblyConnector + public exports

**Files:**
- Create: `src/connector.ts`
- Modify: `src/index.ts` (final export surface)
- Test: `tests/connector.test.ts`

**Interfaces:**
- Consumes: everything above; `Connector` + `EchoOptionsWithDefaults` from `laravel-echo`
- Produces:

```ts
// src/connector.ts
import { Connector } from "laravel-echo";
export class AblyConnector extends Connector<"function" & any, AblyChannel, AblyPrivateChannel, AblyPresenceChannel> {
    ably: Realtime;
    channels: Record<string, AblyChannel>; // keyed by resolved ably name
    connect(): void;
    channel(name: string): AblyChannel;
    privateChannel(name: string): AblyPrivateChannel;
    presenceChannel(name: string): AblyPresenceChannel;
    leave(name: string): void;
    leaveChannel(name: string): void;
    socketId(): string | undefined;
    connectionStatus(): ConnectionStatus;
    onConnectionChange(callback: (status: ConnectionStatus) => void): () => void;
    disconnect(): void;
}
// src/index.ts exports: AblyConnector, AblyChannel, AblyPrivateChannel,
// AblyPresenceChannel, TokenManager, types, channel-name utils, VERSION
```

(Note on the generic: `Connector`'s type parameter is keyed to Echo's built-in driver map; use the loosest instantiation that satisfies `tsc --strict` — check how `EchoOptionsWithDefaults` is consumed in `/Users/luisdalmolin/Projects/open-source/echo/packages/laravel-echo/src/connector/connector.ts` and prefer `Connector<any, ...>` with a lint suppression comment over contorting the types.)

Behavior contract:
1. `connect()` with `options.ably.client` uses it verbatim (no `new Ably.Realtime`); without it, constructs `Ably.Realtime` with defaults `{useTokenAuth: true, queryTime: true, echoMessages: false, authCallback: tokenManager.authCallback, agents: {"laravel-echo-ably": VERSION}}` merged under user `clientOptions` (user wins except `authCallback`).
2. `channel("orders")` → `AblyChannel` on `public:orders`; `privateChannel("orders")` → `private:orders`; `presenceChannel("chat")` → `presence:chat`; repeated calls return the cached instance.
3. `leaveChannel` accepts `private-orders`, `private:orders`, and `orders` — all unsubscribe the same cached channel; unknown names are a no-op.
4. `leave("orders")` unsubscribes `public:orders`, `private:orders`, `presence:orders` (whichever exist).
5. `socketId()` returns base64url `JSON.stringify({connectionKey, clientId})` using `ably.connection.key` and `ably.auth.clientId ?? null`; `undefined` when no connection key. Assert round-trip decode.
6. `connectionStatus()` mapping: `initialized|connecting → "connecting"`, `connected → "connected"`, `disconnected|suspended → "reconnecting"`, `closing|closed → "disconnected"`, `failed → "failed"`.
7. `onConnectionChange(cb)` fires with the mapped status on connection state changes and returns a working unsubscriber.
8. Connection state change to `failed` with `reason.code === 40102` → `tokenManager.reset()` + `ably.connect()` + every cached channel's `subscribe()` re-runs.
9. `disconnect()` → `ably.close()`.
10. Constructing via Echo end-to-end works: `new Echo({broadcaster: AblyConnector, ably: {client: mockRealtime}})` followed by `echo.private("orders")` returns an `AblyPrivateChannel` (import Echo from `laravel-echo` in the test — this is the integration seam that proves the custom-connector contract).

- [ ] **Step 1: Write failing tests** (10 behaviors)
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement connector; finalize `src/index.ts` exports**
- [ ] **Step 4: Verify pass**; full suite; `npm run typecheck`; `npm run build`
- [ ] **Step 5: Commit** — `feat: AblyConnector — native ably-js driver for Laravel Echo`

---

### Task 9: Sandbox integration test (gated) + README

**Files:**
- Create: `tests/integration/sandbox.test.ts`, `README.md`
- Modify: `.github/workflows/ci.yml` (integration job), `package.json` (`test:integration` script)

**Interfaces:**
- Consumes: the full public API from Task 8

- [ ] **Step 1: Write the gated integration test.** `test:integration` script runs `vitest run tests/integration`; the suite calls `describe.skipIf(!process.env.ABLY_SANDBOX_KEY)`. Test flow against the real `ably` package pointed at Ably's sandbox environment (`environment: "sandbox"` client option, key from `ABLY_SANDBOX_KEY`): construct `AblyConnector` with a `requestTokenFn` that mints a sandbox token request locally, subscribe to a public channel, publish via a second raw ably-js client, assert the Echo `listen` callback receives the payload within 10s. Exclude `tests/integration` from the default `test` script (`vitest run --exclude "tests/integration/**"` or vitest config `exclude`).
- [ ] **Step 2: Verify** — `npm test` (integration skipped, all green); `ABLY_SANDBOX_KEY=... npm run test:integration` documented as manual/CI-secret-gated. In CI add a separate job with `if: ${{ secrets.ABLY_SANDBOX_KEY != '' }}` guard.
- [ ] **Step 3: Write README.md** per the spec's Documentation section: install, server-side setup (`ably/laravel-broadcaster` required, `BROADCAST_CONNECTION=ably`), quick start (`new Echo({broadcaster: AblyConnector, ...})`), hooks usage (`configureEcho`) with typing caveat, `ably` options reference table (`clientOptions`, `client`, `requestTokenFn` with a Sanctum example, `channelOptions` with a rewind example), migration from Pusher-adapter config, migration from `@ably/laravel-echo` (Echo-style names, `here()` semantics, `ErrorInfo` objects), Ably error-code table (40140-40142, 40160, 80016), CI badge, MIT footer.
- [ ] **Step 4: Full verification** — `npm test && npm run lint && npm run format:check && npm run typecheck && npm run build`
- [ ] **Step 5: Commit** — `docs: README and gated sandbox integration suite`

---

### Task 10: Repo finalization

**Files:**
- Modify: none (GitHub state + final verification only)

- [ ] **Step 1: Push and verify CI** — `git push origin main`, then `gh run watch` until green (fix forward if red)
- [ ] **Step 2: File the out-of-scope tracking issues** on `kirschbaum-development/laravel-echo-ably` via `gh issue create`: (1) "Encrypted private channels (blocked on upstream laravel/echo instanceof gate)", (2) "Typed hooks + Broadcaster map support (needs upstream laravel/echo PRs)", (3) "Replay / recovered API design (rewind ships via channelOptions in v1)" — each body referencing the spec section
- [ ] **Step 3: Final full-suite run + summary** — report test count, coverage of the behavior contracts, and anything deferred
