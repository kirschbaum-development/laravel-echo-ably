# Native Ably Driver for Laravel Echo — Design

**Date:** 2026-08-13
**Package:** `@kirschbaum-development/laravel-echo-ably`
**Repo:** `kirschbaum-development/laravel-echo-ably` (public, MIT)
**Status:** Approved

## Purpose

A standalone driver package that gives Laravel Echo 2.x native ably-js v2 support
without forking laravel-echo. It plugs into Echo's custom-connector extension point
(`broadcaster: AblyConnector`) and pairs with the maintained server-side package
`ably/laravel-broadcaster`. It replaces two things: Echo's built-in `ably` broadcaster
(pusher-js speaking the Pusher protocol adapter, which forfeits Ably's continuity
guarantees, history, and token auth) and Ably's stalled `@ably/laravel-echo` fork
(frozen at laravel-echo 1.16 / ably-js v1).

## Context and constraints

- Echo 2.x accepts a constructor as `broadcaster` (`echo.ts:90-94`) and exports the
  `Connector` and `Channel` base classes plus `EventFormatter`. Laravel Wave proves
  this distribution model.
- The server contract comes from `ably/laravel-broadcaster` (v1.0.8, Laravel 13):
  `POST /broadcasting/auth` with `{channel_name, token}` returns
  `{token: <HS256 Ably JWT>, info?: <presence member data>}`. JWT claims: `iat`,
  `exp`, `x-ably-clientId`, `x-ably-capability` (JSON object string mapping channel
  names to capability arrays; capabilities accrete across requests).
- `toOthers()` works when `socketId()` returns
  `base64url(JSON.stringify({connectionKey, clientId}))` — the composite that
  `ably/laravel-broadcaster` decodes.
- Ably channel namespaces mirror the server's `formatChannels()`: `public:`,
  `private:`, `presence:`.
- ably-js v2 is promises-only. The fork's v1 callbacks code does not port directly.

## Decisions (approved)

1. **ably-js consumption:** peer-dependency on `ably ^2`, standard build imported by
   default; `options.ably.client` accepts a pre-built `Realtime`/`BaseRealtime`
   instance (mirrors `PusherConnector`'s `options.client` escape hatch) so users can
   opt into the `ably/modular` build for bundle size.
2. **Auth without monkey-patching:** our channel classes own the subscribe lifecycle,
   so `AblyChannel.subscribe()` awaits `TokenManager.ensureCapability(name)` before
   `channel.attach()`. No patching of ably-js internals (the fork's approach).
3. **Names stay Echo-style everywhere.** Users never type colon prefixes. Internal
   mapping to `public:`/`private:`/`presence:` namespaces; `leaveChannel()` accepts
   pusher-style (`private-foo`), ably-style (`private:foo`), or bare names.
4. **`here()` matches Pusher/Echo semantics:** fires with the full member list on
   subscription success (and on each resubscription), not on every membership change.
   `joining()`/`leaving()` deliver deltas.
5. **Peer deps are required, not optional:** `laravel-echo ^2`, `ably ^2`.
6. **v1 scope:** core driver + docs. Out of scope, tracked as GitHub issues:
   encrypted private channels (blocked by Echo's `instanceof` gate, `echo.ts:172`),
   typed hooks support (needs upstream laravel/echo PRs), replay/`recovered` API
   (v1 ships only the `channelOptions` passthrough, which enables `rewind`).

## Package layout

```
src/
  index.ts                      // public exports
  connector.ts                  // AblyConnector extends Connector
  channels/
    ably-channel.ts             // public channels
    ably-private-channel.ts     // + whisper()
    ably-presence-channel.ts    // + here()/joining()/leaving(), auto presence.enter
  auth/
    token-manager.ts            // capability-aware JWT lifecycle
    jwt.ts                      // JWT payload parsing → TokenDetails
  util/
    channel-name.ts             // normalization helpers
  types.ts                      // AblyOptions and public types
tests/                          // Vitest unit tests (mocked ably) + sandbox integration
docs/superpowers/specs/         // this document
.github/workflows/ci.yml        // lint + typecheck + test + build
```

Tooling mirrors laravel/echo 2.x: Vite library build (ESM + IIFE), `vite-plugin-dts`,
Vitest, ESLint + Prettier, TypeScript strict, Node >= 20, MIT license.

## Public API

```ts
import Echo from "laravel-echo";
import { AblyConnector } from "@kirschbaum-development/laravel-echo-ably";

window.Echo = new Echo({
    broadcaster: AblyConnector,
    authEndpoint: "/broadcasting/auth",
    ably: {
        clientOptions: {},            // merged into Ably.Realtime options
        client: undefined,            // pre-built Realtime instance (modular build)
        requestTokenFn: undefined,    // (channelName, existingToken) => Promise<{token, info?}>
        channelOptions: {},           // per-channel-name → Ably ChannelOptions (params, modes)
    },
});
```

- All Ably-specific options live under the `ably` key; everything else is standard
  Echo options (`authEndpoint`, `auth.headers`, `bearerToken`, `csrfToken`,
  `namespace`).
- `requestTokenFn` is the Sanctum/custom-auth escape hatch and replaces the internal
  HTTP call when provided.
- `channelOptions` keys are matched against the resolved Ably channel name
  (e.g. `"private:orders"`), values passed to `ably.channels.get(name, options)` —
  this is how users get `rewind`/`delta` today.
- Works with `configureEcho({ broadcaster: AblyConnector, ... })` from the hook
  packages at runtime; typed support documented as pending upstream.

## Components

### AblyConnector (`connector.ts`)

Implements the ten abstract `Connector` methods:

- `connect()`: use `options.ably.client` if provided, else
  `new Ably.Realtime({...defaults, ...clientOptions})` with defaults:
  `useTokenAuth: true`, `queryTime: true`, `echoMessages: false`,
  `authCallback` wired to TokenManager, `agents: {'laravel-echo-ably': VERSION}`.
- `channel(name)` → `AblyChannel` on `public:{name}`; `privateChannel(name)` →
  `AblyPrivateChannel` on `private:{name}`; `presenceChannel(name)` →
  `AblyPresenceChannel` on `presence:{name}`. Instances cached in `channels`
  (declared property, keyed by resolved Ably name, so `Echo.leaveAllChannels()` works).
- `leave(name)`: strip any known prefix to a base name, leave all three variants.
- `leaveChannel(name)`: normalize (see channel-name rules) then unsubscribe + drop.
- `socketId()`: base64url `{connectionKey, clientId}` composite; `undefined` until
  connected.
- `connectionStatus()` mapping: `initialized|connecting → connecting`,
  `connected → connected`, `disconnected|suspended → reconnecting`,
  `closing|closed → disconnected`, `failed → failed`.
- `onConnectionChange(cb)`: subscribe to `connection.on()`, return unsubscriber.
- `disconnect()`: `ably.close()`.

Error recovery at the connection level: on connection `failed` with Ably code
40102 (clientId mismatch after login), reconnect and re-attach all channels.

### Channel classes (`channels/`)

`AblyChannel extends Channel` (from laravel-echo):

- Constructor: `(ably, name, options, tokenManager)`; calls `subscribe()`.
- `subscribe()`: `await tokenManager.ensureCapability(name)` for guarded channels
  (public channels skip auth), then `channels.get(name, resolvedChannelOptions)`,
  register a channel state listener (Echo `subscribed()` callbacks on `attached`;
  `error()` callbacks when a state change carries a `reason`), then `attach()`.
  Errors during async subscribe are routed to `error()` callbacks, never unhandled
  rejections.
- `listen(event, cb)`: `channel.subscribe(eventFormatter.format(event), wrapper)`
  where wrapper calls `cb(message.data)`; a `Map<original → wrapper>` (per event
  name) supports `stopListening(event, cb?)`.
- `listenToAll(cb)`: subscribe without filter, strip the namespace prefix from
  `message.name` (same formatting contract as `PusherChannel.listenToAll`).
- `stopListeningToAll(cb?)`, `subscribed(cb)`, `error(cb)`, `on(event, cb)` —
  aligned with `PusherChannel`'s surface.
- `unsubscribe()`: `channel.unsubscribe()`, clear listeners, `channel.off()`,
  `channel.detach()`.
- Inherited from Echo's abstract `Channel`: `listenForWhisper` (listens for
  `.client-{event}`) and `notification()` — work unchanged because `listen()`
  honors the leading-dot bypass via `EventFormatter`.

`AblyPrivateChannel extends AblyChannel`:

- `whisper(event, data)`: `channel.publish('client-' + event, data)` (raw name, no
  namespace formatting — matches how `listenForWhisper` subscribes). Returns `this`;
  publish failures routed to `error()` callbacks.
- Channel `failed` state with Ably code 40160 (capability rejection): request a
  token upgrade via TokenManager, then re-attach.

`AblyPresenceChannel extends AblyPrivateChannel`:

- On `attached`: `presence.enter(memberData)` where `memberData` is the `info`
  payload TokenManager captured from the auth response for this channel.
- `here(cb)`: on subscription success, `presence.get()` → `cb(members.map(m => m.data))`.
- `joining(cb)`: `presence.subscribe(['enter', 'update'], m => cb(m.data))`.
- `leaving(cb)`: `presence.subscribe('leave', m => cb(m.data))`.
- `unsubscribe()`: `presence.leave()` + `presence.unsubscribe()` + super.

### TokenManager (`auth/`)

- State: current `TokenDetails` + parsed capability map + per-channel presence
  `info` data + a promise chain serializing token requests.
- `ensureCapability(channelName)`: resolve immediately when the cached token covers
  the channel and isn't within 30s of expiry (vs server-time offset when
  `queryTime` supplies one); otherwise enqueue a token request.
- Token request: `requestTokenFn(channelName, currentToken)` when provided, else
  `fetch(authEndpoint, {method: 'POST', headers: options.auth.headers + CSRF/Bearer,
  body: {channel_name, token}})`. Response `{token, info?}` → `jwt.ts` converts the
  JWT to `TokenDetails` (`x-ably-clientId` → clientId, `exp`/`iat` seconds → ms) —
  parse-only, no signature verification client-side.
- After a new token: `ably.auth.authorize(null, {token})` to apply it to the live
  connection.
- `authCallback` (wired into Realtime options): returns current or freshly fetched
  TokenDetails — covers ably-js-initiated renewals on expiry.

### Channel-name rules (`util/channel-name.ts`)

- `toPublic(name)` / `toPrivate(name)` / `toPresence(name)`: prefix with
  `public:` / `private:` / `presence:` after stripping any existing known prefix
  (`public:`, `private:`, `presence:`, `private-`, `presence-`, `private-encrypted-`).
- `normalize(name)`: pusher-style → ably-style (`private-foo` → `private:foo`,
  `presence-foo` → `presence:foo`); already-prefixed ably-style passes through;
  bare names → `public:{name}`.
- `baseName(name)`: strip any known prefix.

## Error handling summary

| Failure | Behavior |
| --- | --- |
| Auth endpoint non-2xx / network error | Reject the pending attach; fire channel `error()` callbacks with the error |
| Ably 40160 on channel | One token-upgrade + re-attach attempt, then surface via `error()` |
| Ably 40102 on connection | Reconnect + re-attach all channels (login/logout clientId change) |
| Token near expiry | Proactive refresh via `ensureCapability`; reactive via `authCallback` |
| `encryptedPrivate()` | Throws: "Encrypted private channels require upstream laravel-echo support" (README links the tracking issue) |

Error callbacks receive Ably `ErrorInfo` objects (documented difference from Pusher
status codes, with a README table of common codes: 40140-40142 token expiry, 40160
capability, 80016 connection).

## Testing

- **Unit (bulk of coverage):** Vitest with `vi.mock('ably')` — a fake
  Realtime/Channels/Presence surface. Covers: connector wiring and caching, name
  normalization, connection-status mapping, socketId composite, TokenManager
  (capability reuse, accretion, serialization, expiry, requestTokenFn override,
  40160/40102 recovery), channel listen/stopListening wrapper bookkeeping,
  whisper publish, presence enter/here/joining/leaving, unsubscribe cleanup.
- **Integration (thin):** against the free Ably sandbox, gated behind an
  `ABLY_SANDBOX` env/secret so forks and PRs without credentials skip it.
- CI: lint + typecheck + unit tests + build on push/PR (Node 20 + 22 matrix).

## Documentation (README)

Install; server-side setup with `ably/laravel-broadcaster` (required companion for
v1); full Echo usage examples; hooks (`configureEcho`) usage with the typing caveat;
migration from the Pusher-adapter config; migration from `@ably/laravel-echo`
(naming differences, `here()` semantics, error objects); Ably error-code table;
`channelOptions` passthrough with a `rewind` example.

## Out of scope (file as issues on repo creation)

1. Encrypted private channels — pending upstream `laravel/echo` duck-typing PR.
2. Typed hooks/`Broadcaster` map support — pending upstream `laravel/echo` PRs
   (interface merging, hooks generics).
3. Replay/`recovered` API — design tracked in the research memo; v1 ships
   `channelOptions` (rewind) only.
4. npm publish automation — first publish is manual after user review.
