# Laravel Echo Ably

[![CI](https://github.com/kirschbaum-development/laravel-echo-ably/actions/workflows/ci.yml/badge.svg)](https://github.com/kirschbaum-development/laravel-echo-ably/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

A native [Ably](https://ably.com) driver for [Laravel Echo](https://github.com/laravel/echo) 2.x, built on `ably-js` v2.

Echo ships with an `ably` broadcaster, but it is a Pusher-protocol adapter: `pusher-js` pointed at `realtime-pusher.ably.io`. That works, and it gives up most of what you are paying Ably for — connection continuity, token auth with capabilities, history and rewind, and Ably's own presence protocol. Ably's own `@ably/laravel-echo` fork speaks the native protocol but is frozen on Echo 1.16 and `ably-js` v1.

This package is neither: it is a standalone connector that plugs into Echo 2.x's custom-broadcaster extension point and drives `ably-js` v2 directly. You keep Echo's API — `Echo.private('orders').listen(...)` — and get Ably's protocol underneath.

## Requirements

- `laravel-echo` ^2.3.0 and `ably` ^2.0 (both peer dependencies) — 2.3 is where Echo started exporting `ConnectionStatus`, which this package's types reference
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
    },
});
```

| Option           | Type                                                      | Purpose                                                                            |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `clientOptions`  | `Partial<Ably.ClientOptions>`                             | Merged into the options the driver hands `new Ably.Realtime(...)`.                 |
| `client`         | `Ably.Realtime`                                           | Use a client you built yourself, instead of one the driver builds.                 |
| `requestTokenFn` | `(channelName, existingToken) => Promise<{token, info?}>` | Replaces the driver's own request to `authEndpoint`.                               |
| `channelOptions` | `Record<string, Ably.ChannelOptions>`                     | Per-channel Ably options, keyed by **resolved** channel name (`"private:orders"`). |

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

## React and Vue hooks

`configureEcho()` from `@laravel/echo-react` and `@laravel/echo-vue` works at runtime:

```tsx
import { configureEcho } from "@laravel/echo-react";
import { AblyConnector } from "@kirschbaum-development/laravel-echo-ably";

configureEcho({
    // @ts-expect-error The hooks type `broadcaster` as one of Echo's built-in
    // driver names; a custom connector is not in that union yet.
    broadcaster: AblyConnector,
});
```

That suppression is the whole caveat: the hook packages type `broadcaster` against Echo's map of built-in drivers, which no third-party connector can be a member of until the upstream `laravel/echo` PRs land. `useEcho`, `useEchoPresence` and friends behave normally. If you would rather not carry a suppression, use a plain `Echo` instance.

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

## Error handling

Error callbacks receive Ably [`ErrorInfo`](https://ably.com/docs/api/realtime-sdk/types#error-info) objects — `{code, statusCode, message}` — not Pusher status codes:

```js
Echo.private("orders").error((error) => {
    if (error.code === 40160) {
        // The user is not authorized for this channel.
    }
});
```

| Code            | Meaning                                                                                                                           | What the driver does                                                                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `40102`         | Incompatible credentials — the connection's client id no longer matches the token's, which is what a login or a logout looks like | Drops the cached token, reconnects and re-subscribes every channel. Once per connection cycle, re-armed by the next successful connection. Implemented and unit-tested against a mocked client; verification against live Ably is tracked in [#5](https://github.com/kirschbaum-development/laravel-echo-ably/issues/5). |
| `40140`–`40142` | Token not accepted, revoked or expired                                                                                            | `ably-js` re-invokes the driver's auth callback. A token with more than 30 seconds of life left is replayed as it is; one that is missing or inside that window is replaced by a fresh request to `authEndpoint` for the last channel capability was granted for.                                                        |
| `40160`         | The token does not grant this channel                                                                                             | Private and presence channels force a token upgrade and re-attach, once per attach cycle: the retry is re-armed by every successful attach, so a channel that had been working gets a silent retry of its own. Two rejections in a row reach `error()`.                                                                  |
| `40170`/`80019` | Your auth endpoint or `requestTokenFn` failed                                                                                     | Surfaces as a connection error. Expected once on the very first connection — see the note above.                                                                                                                                                                                                                         |
| `80016`         | The connection was replaced by a newer one                                                                                        | Handled inside `ably-js`; no driver action.                                                                                                                                                                                                                                                                              |
| `80017`         | Connection closed                                                                                                                 | Delivered to channel `error()` callbacks after `Echo.disconnect()`. Expected.                                                                                                                                                                                                                                            |

Failures during subscription — a rejected auth request, a refused attach — are routed to the channel's `error()` callbacks rather than thrown, and the most recent one is replayed to callbacks registered after it, so an `error()` handler added on the same tick as the channel still sees it.

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
- **Typed hooks.** `configureEcho({broadcaster: AblyConnector})` needs a suppression until the upstream `laravel/echo` typing PRs land.
- **A replay / `recovered` API.** Use `channelOptions` with `rewind` in the meantime.
- **Connections that only ever use public channels.** Supply a token through `clientOptions`, or a self-authenticating `client` — see the note above, and [#4](https://github.com/kirschbaum-development/laravel-echo-ably/issues/4).

Progress and requests: [github.com/kirschbaum-development/laravel-echo-ably/issues](https://github.com/kirschbaum-development/laravel-echo-ably/issues).

## Contributing

```shell
npm install
npm test            # unit suite, ably-js mocked
npm run lint
npm run typecheck
npm run build
```

The integration suite talks to a real Ably app and is skipped unless a key is present:

```shell
ABLY_SANDBOX_KEY="name:secret" npm run test:integration
```

Set `ABLY_SANDBOX_ENDPOINT` as well when the key belongs to a non-production app (`nonprod:sandbox` for one of Ably's ephemeral sandbox apps); without it the tests talk to production. CI runs the suite only when the repository secret is configured, so forks and pull requests without it are unaffected.

## License

MIT — see [LICENSE.md](LICENSE.md). Built and maintained by [Kirschbaum Development Group](https://kirschbaumdevelopment.com).
