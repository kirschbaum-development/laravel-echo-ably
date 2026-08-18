# Laravel Echo Ably

[![CI](https://github.com/kirschbaum-development/laravel-echo-ably/actions/workflows/ci.yml/badge.svg)](https://github.com/kirschbaum-development/laravel-echo-ably/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

A native [Ably](https://ably.com) driver for [Laravel Echo](https://github.com/laravel/echo) 2.x, built on `ably-js` v2.

Echo ships with an `ably` broadcaster, but it is a Pusher-protocol adapter: `pusher-js` pointed at `realtime-pusher.ably.io`. That works, and it gives up most of what you are paying Ably for — connection continuity, token auth with capabilities, history and rewind, and Ably's own presence protocol. Ably's own `@ably/laravel-echo` fork speaks the native protocol but is frozen on Echo 1.16 and `ably-js` v1.

This package is neither: it is a standalone connector that plugs into Echo 2.x's custom-broadcaster extension point and drives `ably-js` v2 directly. You keep Echo's API — `Echo.private('orders').listen(...)` — and get Ably's protocol underneath.

## Requirements

- `laravel-echo` ^2.3.7 and `ably` ^2.0 (both peer dependencies) — 2.3 is where Echo started exporting `ConnectionStatus`, which this package's types reference, and 2.3.7 is where `broadcaster` started accepting a third-party connector without a type suppression
- Node 20+ for the build tooling; the package itself targets the browser
- Laravel with [`ably/laravel-broadcaster`](https://github.com/ably/laravel-broadcaster) — the server side is **required**, because the driver authenticates with the Ably JWTs that package signs

## Installation

### Server (Laravel)

```shell
composer require ably/laravel-broadcaster
```

```dotenv
BROADCAST_CONNECTION=ably
ABLY_KEY=your-ably-root-api-key
```

`ABLY_KEY` is the full `name:secret` key from the Ably dashboard — it stays on the server, which signs a short-lived JWT per user. On Laravel 10 or older use `BROADCAST_DRIVER` instead of `BROADCAST_CONNECTION`, and uncomment `App\Providers\BroadcastServiceProvider::class` in `config/app.php`.

Your `routes/channels.php` authorization callbacks are unchanged. `POST /broadcasting/auth` receives `{channel_name, token}` and answers `{token, info?}`, where `info` is whatever your presence channel callback returned — that becomes the member's presence data.

### Client

```shell
npm install @kirschbaum-development/laravel-echo-ably laravel-echo ably
```

## Quick start

```js
import Echo from "laravel-echo";
import { AblyConnector } from "@kirschbaum-development/laravel-echo-ably";

window.Echo = new Echo({
    broadcaster: AblyConnector,
    authEndpoint: "/broadcasting/auth", // the default; shown for clarity
});
```

That is the whole client configuration for a standard Laravel app. There is no API key, host, port or cluster on the client: the connection authenticates with the token your Laravel app signs.

```js
// Public channel.
Echo.channel("orders").listen("OrderShipped", (event) => {
    console.log(event.order);
});

// Private channel, with an error callback.
Echo.private(`orders.${orderId}`)
    .listen("OrderShipped", (event) => console.log(event.order))
    .error((error) => console.error(error.code, error.message));

// Presence channel.
Echo.join("chat")
    .here((members) => console.log(members))
    .joining((member) => console.log(`${member.name} joined`))
    .leaving((member) => console.log(`${member.name} left`))
    .listen("MessageSent", (event) => console.log(event));

// Whispers.
Echo.private("chat").whisper("typing", { name: "Jane" });
Echo.private("chat").listenForWhisper("typing", (event) => console.log(event));

// Notifications.
Echo.private(`App.Models.User.${userId}`).notification((notification) => {
    console.log(notification.type);
});

// Leaving.
Echo.leaveChannel("private-orders"); // one channel
Echo.leave("orders"); // the public, private and presence variants
```

`Echo.socketId()` returns the composite `ably/laravel-broadcaster` decodes, so `toOthers()` works as it does on any other driver. It is `undefined` until the connection is established.

## The `ably` options

Everything driver-specific lives under the `ably` key. Every other option is standard Echo (`authEndpoint`, `auth.headers`, `bearerToken`, `csrfToken`, `namespace`).

```ts
new Echo({
    broadcaster: AblyConnector,
    ably: {
        clientOptions: {}, // merged into the Ably.Realtime options
        client: undefined, // a pre-built Realtime instance
        requestTokenFn: undefined, // replaces the built-in auth request
        channelOptions: {}, // resolved channel name → Ably.ChannelOptions
        replay: false, // replay the events a lost attachment missed
    },
});
```

| Option           | Type                                                      | Purpose                                                                            |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `clientOptions`  | `Partial<Ably.ClientOptions>`                             | Merged into the options the driver hands `new Ably.Realtime(...)`.                 |
| `client`         | `Ably.Realtime`                                           | Use a client you built yourself, instead of one the driver builds.                 |
| `clientFactory`  | `() => Ably.Realtime`                                     | Builds a replacement client when Ably reports 40102 — required with `client`.      |
| `requestTokenFn` | `(channelName, existingToken) => Promise<{token, info?}>` | Replaces the driver's own request to `authEndpoint`.                               |
| `channelOptions` | `Record<string, Ably.ChannelOptions>`                     | Per-channel Ably options, keyed by **resolved** channel name (`"private:orders"`). |
| `replay`         | `boolean \| {limit?: number}`                             | Opt into replaying missed events after a continuity gap — see below.               |

### `clientOptions`

The driver builds its client with `useTokenAuth: true`, `queryTime: true`, `echoMessages: false` and an `agents` entry, then merges your `clientOptions` over them. The `authCallback` is applied last and is always the driver's own — the token lifecycle (capability upgrades, renewal at expiry, the 40160 retry, the 40102 recovery) runs through it. If you need a different auth mechanism, supply a whole `client` instead.

```ts
ably: {
    clientOptions: {
        logLevel: 2,
        transportParams: { heartbeatInterval: 20000 },
    },
}
```

### `client`

```ts
import { BaseRealtime, WebSocketTransport, FetchRequest } from "ably/modular";

const client = new BaseRealtime({
    authUrl: "/ably/token",
    plugins: { WebSocketTransport, FetchRequest },
});

new Echo({ broadcaster: AblyConnector, ably: { client } });
```

The driver uses the instance as it is — transport, plugins, auth configuration — and routes capability upgrades through it. One caveat worth knowing: the first private or presence subscribe hands the client a token signed by `ably/laravel-broadcaster`, since that is the only thing carrying Laravel's channel capability, and `auth.authorize()` _replaces_ ably's stored auth options rather than merging them. The driver includes its own `authCallback` in that call, so token renewal keeps working and goes to `authEndpoint` from then on — but the `authUrl` or key the instance was built with is no longer consulted. A client that only ever serves public channels never reaches that point and keeps its own auth story intact.

This is the escape hatch for the modular build (smaller bundles) and for auth stories the driver does not model.

### `clientFactory`

Ably ties a connection's `clientId` to the credential it opened with, so an identity change — a login, a logout — surfaces as error 40102 and cannot be fixed on the connection that hit it. The driver recovers by building a replacement client, moving every live channel onto it, and closing the one that was stranded.

That works out of the box when the driver built the client. When _you_ supplied one through `client`, the driver has no way to build another, so give it a factory:

```ts
import * as Ably from "ably";

const makeClient = () => new Ably.Realtime({ authUrl: "/ably/token" });

new Echo({
    broadcaster: AblyConnector,
    ably: { client: makeClient(), clientFactory: makeClient },
});
```

The factory must return a **new** client each call — returning the same instance hands the driver back the connection it is trying to replace. Without a factory, an injected client gets a best-effort reconnect instead, which will not clear a genuine `clientId` mismatch.

### `requestTokenFn`

The driver's own auth request is a `fetch` POST to `authEndpoint` carrying `{channel_name, token}` plus `options.auth.headers` (which is where Echo puts your CSRF token and `bearerToken`). Same-origin cookie sessions work out of the box. Supply `requestTokenFn` when they do not — a token endpoint somewhere else, a cross-origin SPA, Sanctum:

```ts
import axios from "axios";
import type { RequestTokenFn } from "@kirschbaum-development/laravel-echo-ably";

const requestTokenFn: RequestTokenFn = async (channelName, existingToken) => {
    const { data } = await axios.post(
        "/api/broadcasting/auth",
        { channel_name: channelName, token: existingToken },
        { withCredentials: true },
    );

    return data; // { token: "<Ably JWT>", info?: <presence data> }
};

new Echo({ broadcaster: AblyConnector, ably: { requestTokenFn } });
```

Pass `existingToken` back to the server: `ably/laravel-broadcaster` accretes each new grant onto the capability the token already carries, so returning it is what keeps a second channel from revoking the first one's access. Return the response body untouched — `info` is the presence data the member enters with.

The annotation is worth keeping. Echo types its own options bag loosely, so nothing inside `ably` is contextually typed: an inline callback's parameters would be implicitly `any`. The package exports `AblyDriverOptions`, `RequestTokenFn` and `TokenResponse` for exactly this.

### `channelOptions`

Keyed by the **resolved** Ably name, not the Echo name, and read when the channel is first created:

```ts
new Echo({
    broadcaster: AblyConnector,
    ably: {
        channelOptions: {
            // Replay the last message to every new subscriber.
            "private:orders": { params: { rewind: "1" } },
            "public:ticker": { params: { rewind: "30s" } },
        },
    },
});
```

`Echo.private('orders')` resolves to `private:orders`, `Echo.join('chat')` to `presence:chat`, `Echo.channel('ticker')` to `public:ticker`. This is also how you reach `modes`, `params` and deltas — anything `ably.channels.get(name, options)` accepts.

`rewind` hands every new subscriber the same last N messages. To fill the gap one client actually missed, see [Replaying missed events](#replaying-missed-events) below.

## Knowing when continuity is lost

Ably keeps a connection's state for about two minutes. A drop shorter than that _resumes_ and nothing is missed. Past that window the channel re-attaches **without continuity**, and everything published in the meantime is gone as far as this client is concerned — the screen keeps rendering state that is quietly out of date.

`continuityLost()` is how the driver tells you that happened. It fires on every channel state change Ably marks `resumed: false` — both of the events [Ably's discontinuity guide](https://ably.com/docs/pub-sub/guides/handling-discontinuity) names:

- an `attached` after a disconnection outlived the resume window;
- an `update` when continuity breaks while the channel stays attached.

The channel's very first attach is not a gap and never fires it: there is nothing behind it to have missed.

```js
Echo.private(`auctions.${auctionId}`)
    .listen("BidPlaced", (event) => store.apply(event))
    .continuityLost(({ reason }) => {
        // The channel is live again, but there is a hole behind it.
        store.markRecovering();

        return store.refetchSnapshot(); // your server is the authority
    });
```

It is **independent of `replay`**: it fires whether or not a catch-up is configured, and always _before_ one starts. That ordering is the point — `recovered()` cannot report anything until a history round-trip has finished, which is too late to put a "Reconnecting…" state on screen. If you use both, `continuityLost()` opens the recovering state and `recovered()` closes it.

The callback receives:

| Field         | Type                        | Notes                                                                              |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `channel`     | `string`                    | The resolved Ably name, e.g. `private:auctions.7`.                                 |
| `stateChange` | `Ably.ChannelStateChange`   | Ably's own object, untouched — `current`, `previous`, `resumed`, `hasBacklog`.     |
| `reason`      | `Ably.ErrorInfo｜undefined` | `stateChange.reason`. Where 90003 and 90005 turn up — **often absent**, see below. |
| `willReplay`  | `boolean`                   | Whether a replay catch-up was started for this gap.                                |

**Do not detect gaps by error code.** A re-attach that simply could not resume frequently carries no `reason` at all, so nothing reaches `error()` and no code is available to match on. `resumed: false` is the signal; 90003 and 90005 are extra detail when Ably chooses to send it. Registrations are dropped when the channel is left, the same as `listen()` registrations.

## Replaying missed events

Ably keeps a connection's state for about two minutes. A drop shorter than that _resumes_: ably-js re-attaches with continuity intact, Ably itself re-delivers whatever the connection missed, and none of this section applies. Past that window the resume fails, the channel re-attaches without continuity, and everything published in the meantime is gone as far as the client is concerned.

`replay` closes that hole. The driver notices the re-attach that lost continuity, reads the missed messages back out of Ably's history, and pushes them through the listeners you already registered — in order, ahead of the live traffic that arrived behind them. Replayed messages take the same route a live one does, so `listen`, `listenToAll`, `listenForWhisper` and `notification` callbacks see no difference.

```ts
new Echo({
    broadcaster: AblyConnector,
    ably: { replay: true },
});
```

It is off by default, and off means nothing changes: no cursor is tracked, no history request is ever made, `recovered()` never fires and `replayMissed()` rejects. [`continuityLost()`](#knowing-when-continuity-is-lost) still fires either way — an app that recovers from its own server snapshot needs no replay at all, and `replay: false` is the simpler contract: one signal, one refetch, no `history` capability required. (This is not `rewind`, which is a `channelOptions` param that hands _every_ new subscriber the last N messages regardless of what it has already seen. Replay is scoped to the one gap this client had.)

`limit` caps how many messages a single catch-up may replay. It defaults to 100, and a value below 1 falls back to that default:

```ts
new Echo({
    broadcaster: AblyConnector,
    ably: { replay: { limit: 250 } },
});
```

The package exports `ReplayOptions` (the config) and `ReplayResult` (`{complete, count}`) for annotating your own handlers. In TypeScript, `recovered()` and `replayMissed()` are driver methods rather than part of Echo's own channel contract, so type the channel as the exported `AblyChannel` (or `AblyPrivateChannel`, `AblyPresenceChannel`) to reach them.

### `recovered()`

Every catch-up attempt reports its outcome to the channel's `recovered()` callbacks — whether it healed the channel or not:

```js
Echo.private(`orders.${orderId}`)
    .listen("OrderShipped", (event) => store.apply(event))
    .recovered(({ complete, count }) => {
        if (!complete) {
            return store.refetch(); // The gap stands; reload from the server.
        }

        console.log(`Replayed ${count} missed events`);
    });
```

One call per attempt: a gap detected while a catch-up is already running joins that one rather than starting a second, and the single result is fanned out once. Registrations are dropped when the channel is left (`Echo.leave()`, `Echo.leaveChannel()`), the same as `listen()` registrations.

### `replayMissed()`

Not every gap announces itself as a lost attachment. A phone that slept and woke, a mobile browser tab thawed after being frozen — the connection may come back believing it is fine while the app knows it has been away. Ask for a catch-up directly:

```js
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        Echo.private(`orders.${orderId}`).replayMissed();
    }
});
```

It resolves with the same `{complete, count}` result the callbacks receive, and fires them too. It rejects for exactly one reason — replay is not configured on this connection; a catch-up that _fails_ is not an exception, it resolves `{complete: false, count: 0}` like any other unhealed gap.

### Nothing is replayed halfway

`complete: false` means the driver could not account for everything that was missed, and in that case it replays **nothing**: `count` is always `0`. A backlog with a hole in it is worse than an honest miss, because the app has no way to know which events are absent. `complete: false` tells it the one thing it can act on: refetch state from the server.

A catch-up reports `{complete: false, count: 0}` when:

- the missed run is longer than `limit`, or reaches further back than history goes;
- the history request itself fails (see the capability note below);
- nothing has been delivered on the channel yet, so there is no cursor to catch up from;
- **a second continuity gap opened while the catch-up was still running.** A gap-mode catch-up queries `untilAttach`, which anchors it to the attach point in force when the request went out, so it is blind to anything published during a later outage. The walk's backlog is then a prefix of what was actually missed, and a prefix is reported as a miss rather than as a recovery;
- more than 1000 live messages piled up behind the catch-up while it ran. The catch-up is abandoned rather than the traffic — the buffered live messages are still delivered — and the abandonment is also reported through `error()`.

A manual `replayMissed()` that joins a running catch-up is not a second gap: it reports no new outage, so it joins the attempt and shares its result unchanged.

### How far back history goes

A catch-up can only return what Ably still holds:

| Channel setup                      | History window |
| ---------------------------------- | -------------- |
| Default — no persistence           | ~2 minutes     |
| Persist all messages, free package | 24 hours       |
| Persist all messages, paid package | 72 hours       |

"Persist all messages" is a channel rule you add in the Ably dashboard, matched against a channel _namespace_ — the part before the first `:`. This driver namespaces every channel by kind (`public:orders`, `private:orders`, `presence:chat`), so a rule on `private` covers every private channel the app opens. Ably's [message storage docs](https://ably.com/docs/storage-history/storage) are the authority on the retention numbers for your package.

The default window is worth a second thought: on Ably's current defaults it is the same two minutes as the resume window. A gap the driver detects is by definition one that outlived the resume window, so while those two clocks match, un-persisted history has expired right along with it and the catch-up reports `complete: false` — an honest miss your app refetches from, rather than a partial replay. Both windows are Ably's to set, so this is a description of how the defaults line up today, not a guarantee to lean on: turn persistence on for the namespaces you want auto-replay to actually heal.

### The `history` capability

A catch-up is a history request, so the token has to grant `history` on the channel. `ably/laravel-broadcaster` grants it by default and there is nothing to do: guarded channels are signed with `["*"]`, and public channels with `["subscribe", "history", "channel-metadata"]`.

It only becomes a question when a channel authorization callback returns its own `ably-capability`, which _replaces_ that `["*"]` default for the channel:

```php
Broadcast::channel('orders.{orderId}', function ($user, $orderId) {
    return [
        // Replaces the default ["*"] for this channel, so a catch-up on it
        // needs 'history' to be in the list.
        'ably-capability' => ['subscribe', 'history'],
    ];
});
```

A history request the token does not authorize is delivered to the channel's `error()` callbacks as an Ably `ErrorInfo`, and the catch-up resolves `{complete: false, count: 0}`. The automatic path never rejects — there would be nobody to catch it.

### Presence is not replayed

Presence events are not message history and are never replayed. They do not need to be: `here()` re-reads the full member list on every successful attach, and the driver re-enters the presence set on re-attach, so a presence channel heals its own state on the very re-attach that triggers the catch-up. Regular events published on a presence channel replay like they do anywhere else.

### A listener that throws does not abort the replay

Replay dispatches through your own callbacks, and one of them throwing does not abandon the run: the error is reported to the channel's `error()` callbacks and the messages behind it are delivered anyway. Neither a `listen` nor a `listenToAll` callback can strand the rest of the backlog.

## React and Vue hooks

`configureEcho()` from `@laravel/echo-react` and `@laravel/echo-vue` works at runtime:

```tsx
import { configureEcho } from "@laravel/echo-react";
import { AblyConnector } from "@kirschbaum-development/laravel-echo-ably";

configureEcho({
    broadcaster: AblyConnector,
});
```

No type suppression is needed on the versions this package supports. Echo 2.3.0–2.3.2 typed `broadcaster` as a union its own built-in driver names could satisfy and a constructor could not, which is why earlier revisions of this README carried a `@ts-expect-error`; that is fixed from 2.3.7 on, and the suppression is now itself an error (`TS2578: Unused '@ts-expect-error' directive`) — which is why the peer range starts at 2.3.7.

`useEcho`, `useEchoPresence` and friends behave normally. Payload types still resolve to `any` rather than to this driver's channel classes, because Echo routes constructor broadcasters through its `function` slot — tracked in [#2](https://github.com/kirschbaum-development/laravel-echo-ably/issues/2). Type the channel as the exported `AblyChannel` / `AblyPrivateChannel` / `AblyPresenceChannel` where you need the driver's own methods.

Create the Echo instance **once per browser tab**, at module scope or in a provider — never inside a component body. Each connector opens its own Ably connection, and Ably bills and rate-limits per connection; `configureEcho()` and a single module-level `new Echo(...)` both do the right thing, a `new Echo(...)` inside a component does not.

## Behavior notes

**Channel names stay Echo-style.** You never type `private:` or `presence:` prefixes — not in `channel()`, `private()`, `join()`, and not in `leaveChannel()` either. The driver maps them onto Ably's `public:` / `private:` / `presence:` namespaces, which is what `ably/laravel-broadcaster` grants capability for.

**`leaveChannel()` with a bare name leaves every variant.** Every channel this driver opens is namespaced, so a bare `"orders"` does not identify one Ably channel. `Echo.leaveChannel("orders")` therefore leaves the public, private and presence variants — the same thing `Echo.leave("orders")` does. Pass a prefixed name (`"private-orders"` or `"private:orders"`) to leave exactly one. On a Pusher connector, the bare name would only have matched a channel literally called `orders`.

**`here()` is a snapshot, not a feed.** It fires once per successful subscription, with the full member list, matching Pusher and Echo semantics. Membership changes after that arrive through `joining()` and `leaving()`.

**Presence re-enters on re-attach.** When Ably re-attaches a channel after a dropped connection, the driver re-enters the presence set — otherwise the member would be silently absent from then on. Other clients may observe that as an `update`, or as a `joining()` call for a member they already knew about.

**Public channels ride an authenticated connection.** Ably authenticates the connection, not the channel, and the driver requests a token the first time you subscribe to a private or presence channel. `ably/laravel-broadcaster` grants `public:*` on every token it signs, so public channels work on any connection your app has already authenticated. An app that subscribes to _nothing but_ public channels never triggers a token request, so its connection has no credential to offer. Give it one up front:

```ts
new Echo({
    broadcaster: AblyConnector,
    ably: { clientOptions: { token: tokenFromYourEndpoint } },
});
```

That static token has an expiry cliff: it dies at its TTL and nothing renews it. The driver's auth callback renews by asking `/broadcasting/auth` for the last channel it was granted capability for, and a public-only connection never made such a request — so its token cache is empty and there is nothing to renew from. When the token expires the connection is left without a credential. Tracked as [#4](https://github.com/kirschbaum-development/laravel-echo-ably/issues/4).

For anything longer-lived than a page view, hand the driver a client that can authenticate itself instead — `authUrl` (or a key, server-side only) gives ably-js its own renewal path, and a public-only app never triggers the driver's own token push, so that configuration stays in force:

```ts
import * as Ably from "ably";

const client = new Ably.Realtime({ authUrl: "/ably/token" });

new Echo({ broadcaster: AblyConnector, ably: { client } });
```

**The first connection reports one failure.** Echo opens the connection as soon as it is constructed, which is before any channel has fetched a token. `ably-js` asks for one, is told there is none yet, and reports a `disconnected` (80019 / 40170) — then connects as soon as the first channel's token arrives. Subscribers to `onConnectionChange` see a brief `reconnecting` before `connected`.

**`whisper()` takes a plain object.** Its parameter is `Record<string, unknown>`. An object literal is fine; a payload typed with an `interface` is not assignable to it, so declare those with a type alias:

```ts
type TypingPayload = { name: string }; // not `interface TypingPayload`

const payload: TypingPayload = { name: user.name };

Echo.private("chat").whisper("typing", payload);
```

**A whisper sent before the ably channel exists is dropped.** If the subscribe failed at the auth step — a rejected `/broadcasting/auth` request — there is no ably channel to publish on, so the whisper is discarded silently: the failure already reached that channel's `error()` callbacks, and re-reporting it as a publish failure would say the same thing twice. A whisper on a channel whose _attach_ failed is different: the channel object exists, the publish is attempted, and ably's rejection is delivered to `error()` like any other publish failure.

**`Echo.disconnect()` reaches channel `error()` callbacks.** Closing the connection detaches its channels with an 80017 (`Connection closed`) `ErrorInfo`. It is the expected outcome of a deliberate close, not a fault.

**`Echo.disconnect()` closes an injected client too.** If you passed your own client through `ably.client`, `disconnect()` still calls `close()` on it. That is deliberate — Echo's contract is that `disconnect()` ends the connection, and a connector that quietly left a socket open would leak one per Echo instance. If you need the client to outlive the Echo instance, keep your own reference and call `connect()` on it again afterwards.

**One Echo instance per browser tab.** Each connector builds and owns one Ably `Realtime` client, shared by every channel it hands out; channels are cached by resolved name, so `Echo.private('orders')` twice is one subscription. What is _not_ deduplicated is a second `new Echo(...)` — that is a second connection, billed and rate-limited separately. Construct Echo once at module scope (or through `configureEcho()`) and import it; never inside a React component body.

**`subscribed()` fires again on a discontinuity.** Ably reports lost continuity on an already-attached channel as an `update`, which the driver treats as a fresh attach: `subscribed()` callbacks run, presence members are re-entered, and `here()` re-reads the member list. That is required — a presence member who is not re-entered after a continuity break is silently absent from then on. It does mean `subscribed()` is "attached, possibly again", not "attached for the first time". If you set `updateOnAttached` through `channelOptions`, expect it on every attach acknowledgement.

**Multiple Ably SDK instances share one recovery slot.** `ably-js` stashes its connection-recovery data in `sessionStorage` under a fixed key, `ably-connection-recovery`. Two Ably clients on the same origin — this driver plus a separate `@ably/chat` or `@ably/spaces` client, say — will overwrite each other's entry. Give one of them its own key if that applies to you:

```ts
new Echo({
    broadcaster: AblyConnector,
    ably: { clientOptions: { recoveryKeyStorageName: "ably-echo" } },
});
```

This only matters if you opt into reload recovery (`clientOptions.recover`); with the default `closeOnUnload: true` nothing is persisted in the first place.

## Error handling

Error callbacks receive Ably [`ErrorInfo`](https://ably.com/docs/api/realtime-sdk/types#error-info) objects — `{code, statusCode, message}` — not Pusher status codes:

```js
Echo.private("orders").error((error) => {
    if (error.code === 40160) {
        // The user is not authorized for this channel.
    }
});
```

| Code            | Meaning                                                                                                                           | What the driver does                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `40102`         | Incompatible credentials — the connection's client id no longer matches the token's, which is what a login or a logout looks like | Drops the cached token, reconnects and re-subscribes every channel. Once per connection cycle, re-armed by the next successful connection. Implemented and unit-tested against a mocked client; verification against live Ably is tracked in [#5](https://github.com/kirschbaum-development/laravel-echo-ably/issues/5).                                              |
| `40140`–`40142` | Token not accepted, revoked or expired                                                                                            | `ably-js` re-invokes the driver's auth callback. A token with more than 30 seconds of life left is replayed as it is; one that is missing or inside that window is replaced by a fresh request to `authEndpoint` for the last channel capability was granted for.                                                                                                     |
| `40160`         | The token does not grant this channel                                                                                             | Private and presence channels force a token upgrade and re-attach, once per attach cycle: the retry is re-armed by every successful attach, so a channel that had been working gets a silent retry of its own. Two rejections in a row reach `error()`.                                                                                                               |
| `40170`/`80019` | Your auth endpoint or `requestTokenFn` failed                                                                                     | Surfaces as a connection error. Expected once on the very first connection — see the note above.                                                                                                                                                                                                                                                                      |
| `80016`         | The connection was replaced by a newer one                                                                                        | Handled inside `ably-js`; no driver action.                                                                                                                                                                                                                                                                                                                           |
| `80017`         | Connection closed                                                                                                                 | Delivered to channel `error()` callbacks after `Echo.disconnect()`. Expected.                                                                                                                                                                                                                                                                                         |
| `90003`/`90005` | Continuity lost — messages expired, or the channel could not be resumed                                                           | Delivered to `error()` when Ably attaches it to the state change. **Do not gate recovery on these codes** — a gap often carries no reason at all. Use [`continuityLost()`](#knowing-when-continuity-is-lost), which fires on `resumed: false` whether or not an error came with it.                                                                                   |
| `42913`         | Rate limit exceeded, e.g. on `[meta]connection.lifecycle`                                                                         | Passed through untouched. Reachable via `onConnectionStateChange()` — `onConnectionChange()` maps to Echo's four statuses and cannot carry a code. A limit on `[meta]connection.lifecycle` counts **connection** churn (connect/close cycles), not published messages: it points at reconnect storms or connections created per component, not at message throughput. |

Failures during subscription — a rejected auth request, a refused attach — are routed to the channel's `error()` callbacks rather than thrown, and the most recent one is replayed to callbacks registered after it, so an `error()` handler added on the same tick as the channel still sees it.

### Connection telemetry

`Echo.connector.onConnectionChange()` answers Echo's own contract, which has four statuses — `connecting`, `connected`, `reconnecting`, `disconnected`, `failed` — where Ably has eight states and a `reason` on each. For diagnostics you usually want the unmapped feed:

```ts
import type { AblyConnector } from "@kirschbaum-development/laravel-echo-ably";

// Echo types `connector` against its own built-in drivers, so in TypeScript
// reach a third-party one through the exported class — the same cast the
// channel classes need.
const connector = Echo.connector as unknown as AblyConnector;

const stop = connector.onConnectionStateChange((change) => {
    Sentry.addBreadcrumb({
        category: "ably",
        message: `${change.previous} → ${change.current}`,
        data: {
            code: change.reason?.code, // e.g. 42913, 80019, 40102
            statusCode: change.reason?.statusCode,
            connectionId: connector.ably.connection.id,
        },
    });
});

stop(); // unsubscribes, like onConnectionChange
```

Nothing is rewritten or swallowed on the way through: these are Ably's own `ConnectionStateChange` objects, carrying its own `ErrorInfo`. The underlying client stays reachable as `Echo.connector.ably` for anything the driver does not model — `connection.id`, `connection.key`, transport details.

## Migrating

### From the built-in `ably` broadcaster

The built-in broadcaster is `pusher-js` against Ably's Pusher-protocol adapter. Replacing it touches both ends.

```diff
-import Echo from "laravel-echo";
-import Pusher from "pusher-js";
-
-window.Pusher = Pusher;
-window.Echo = new Echo({
-    broadcaster: "ably",
-    key: import.meta.env.VITE_ABLY_PUBLIC_KEY,
-    wsHost: "realtime-pusher.ably.io",
-    wsPort: 443,
-    disableStats: true,
-    encrypted: true,
-});
+import Echo from "laravel-echo";
+import { AblyConnector } from "@kirschbaum-development/laravel-echo-ably";
+
+window.Echo = new Echo({
+    broadcaster: AblyConnector,
+});
```

- `npm uninstall pusher-js` and drop the `window.Pusher` global.
- Remove `key`, `wsHost`, `wsPort`, `forceTLS`, `encrypted`, `disableStats` and `cluster`, along with the `VITE_ABLY_PUBLIC_KEY` env var they read. None of them apply; the client holds no key.
- On the server, `composer require ably/laravel-broadcaster` and set `ABLY_KEY` to your **full** key. The Pusher adapter needed "Pusher protocol support" enabled on the Ably app and only the public half of the key; the native driver needs neither.
- Your events, `routes/channels.php` and `toOthers()` are unchanged.

### From `@ably/laravel-echo`

- Swap the dependency (`@ably/laravel-echo` and `ably@1.x` out, this package, `laravel-echo` ^2.3 and `ably` ^2 in), and drop the `window.Ably` global — the driver imports `ably` itself.
- `broadcaster: "ably"` becomes `broadcaster: AblyConnector`.
- **Names are Echo-style everywhere.** No `private:` or `presence:` prefixes in application code, including `leaveChannel()`. Pusher-style (`private-orders`) and Ably-style (`private:orders`) names are both still accepted there, so existing calls keep working.
- **`here()` fires on subscription success**, with the member list, and not again as members come and go. Anything that relied on `here()` re-firing for membership changes belongs in `joining()` / `leaving()`.
- **Errors are `ErrorInfo` objects.** Handlers reading Pusher-shaped status codes need to read `error.code` (and `error.statusCode`) instead; the table above lists the ones worth branching on.
- Server-side, `ably/laravel-broadcaster` is the same companion package, so nothing changes there.

## Not supported yet

- **Encrypted private channels.** `Echo.encryptedPrivate()` throws for any non-Pusher connector — Echo's core gates it with an `instanceof` check on its own connectors, so no third-party driver can implement it today.
- **Typed hook payloads.** `configureEcho({broadcaster: AblyConnector})` type-checks, but Echo routes constructor broadcasters through a slot typed `any`, so `useEcho` payloads do not resolve to this driver's channel classes until the upstream `laravel/echo` PRs land.
- **Page-reload recovery.** Replay heals a live connection's gap; it does not carry a cursor across a page load. Ably's own connection `recover` key is available through `clientOptions` if you need it.
- **Connections that only ever use public channels.** Supply a token through `clientOptions`, or a self-authenticating `client` — see the note above, and [#4](https://github.com/kirschbaum-development/laravel-echo-ably/issues/4).

Progress and requests: [github.com/kirschbaum-development/laravel-echo-ably/issues](https://github.com/kirschbaum-development/laravel-echo-ably/issues).

## Contributing

```shell
npm install
npm test            # unit suite, ably-js mocked
npm run lint
npm run typecheck
npm run build
npm run verify:package   # packs, then compiles a real consumer against the tarball
```

The integration suite talks to a real Ably app and is skipped unless a key is present:

```shell
ABLY_SANDBOX_KEY="name:secret" npm run test:integration
```

Set `ABLY_SANDBOX_ENDPOINT` as well when the key belongs to a non-production app (`nonprod:sandbox` for one of Ably's ephemeral sandbox apps); without it the tests talk to production. CI runs the suite only when the repository secret is configured, so forks and pull requests without it are unaffected.

### Releasing

`dist/` is not committed — `prepack` rebuilds it, and `npm run verify:package` proves the tarball that comes out is installable. Both CI and the publish workflow run that check, so a release cannot ship a package whose entry points are missing.

One-time setup:

1. Create an **automation** access token on npmjs.com and add it as the `NPM_TOKEN` repository secret.
2. After the first publish, consider switching to [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): register this repository and `publish.yml` as a trusted publisher, then delete the secret and the `NODE_AUTH_TOKEN` line. `--provenance` already works either way, and needs the repository to be public.

To cut a release:

```shell
npm version minor      # or patch / major — bumps package.json and tags
git push --follow-tags
```

Pushing a `v*` tag runs lint, format, typecheck, tests, build and the packaging check, refuses to continue if the tag does not match `package.json` or the version is already on npm, publishes with provenance, and opens a GitHub release with generated notes. Run the workflow manually from the Actions tab first if you want a rehearsal — it defaults to a dry run.

> `src/version.ts` carries the version reported to Ably as an agent string, and is not updated by `npm version`. Bump it in the same commit.

## License

MIT — see [LICENSE.md](LICENSE.md). Built and maintained by [Kirschbaum Development Group](https://kirschbaumdevelopment.com).
