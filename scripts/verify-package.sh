#!/usr/bin/env bash
#
# Pack the package exactly as `npm publish` would, then prove the tarball is
# actually usable: the built entry points are inside it, a fresh TypeScript
# consumer compiles against the published types, and Node can import the ESM
# entry with only the declared peers installed.
#
# Run it before tagging, or let CI run it on every pull request:
#
#     npm run verify:package
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"

# `--ignore-scripts=false` is deliberate. `dist/` is gitignored and rebuilt by
# the `prepack` script, so a publisher whose ~/.npmrc sets `ignore-scripts=true`
# would otherwise pack a tarball with no `dist/` at all — every entry point
# pointing at a file that is not there. That is the exact failure this guards,
# so the guard must not be able to inherit it.
TARBALL="$WORK/$(npm pack --pack-destination "$WORK" --ignore-scripts=false | tail -1)"

echo "==> packed $(basename "$TARBALL")"

echo "==> checking the published entry points are in the tarball"
CONTENTS="$(tar -tzf "$TARBALL")"

for entry in dist/index.js dist/index.d.ts; do
    if ! printf '%s\n' "$CONTENTS" | grep -qx "package/$entry"; then
        echo "FAIL: $entry is missing from the tarball." >&2
        echo "      package.json points main/module/types at files that will not ship." >&2
        exit 1
    fi

    echo "    ok  $entry"
done

echo "==> building a throwaway consumer against the tarball"
mkdir -p "$WORK/consumer/src"
cd "$WORK/consumer"

cat > package.json <<'JSON'
{
    "name": "packaging-smoke-test",
    "private": true,
    "type": "module",
    "version": "0.0.0"
}
JSON

cat > tsconfig.json <<'JSON'
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "bundler",
        "lib": ["DOM", "ES2022"],
        "strict": true,
        "noEmit": true,
        "skipLibCheck": true,
        "verbatimModuleSyntax": true,
        "isolatedModules": true
    },
    "include": ["src"]
}
JSON

# Imports only from the package root: a consumer that has to reach into
# `dist/...` to type something is a packaging bug, not a consumer bug.
cat > src/main.ts <<'TS'
import Echo from "laravel-echo";
import {
    AblyChannel,
    AblyConnector,
    AblyPresenceChannel,
    AblyPrivateChannel,
    VERSION,
} from "@kirschbaum-development/laravel-echo-ably";
import type {
    AblyDriverOptions,
    ContinuityLostEvent,
    ReplayResult,
    RequestTokenFn,
    TokenResponse,
} from "@kirschbaum-development/laravel-echo-ably";

const requestTokenFn: RequestTokenFn = async (channelName, existingToken) => {
    const response = await fetch("/broadcasting/auth", {
        method: "POST",
        body: JSON.stringify({ channel_name: channelName, token: existingToken }),
    });

    return (await response.json()) as TokenResponse;
};

const options: AblyDriverOptions = { requestTokenFn, replay: { limit: 250 } };
const echo = new Echo({ broadcaster: AblyConnector, ably: options });

const orders = echo.private("orders") as unknown as AblyPrivateChannel;

orders
    .listen("OrderShipped", (event: unknown) => console.log(event))
    .continuityLost((event: ContinuityLostEvent) =>
        console.log(event.channel, event.reason?.code, event.willReplay),
    )
    .recovered(({ complete, count }: ReplayResult) => console.log(complete, count))
    .error((error: { code: number }) => console.log(error.code));

orders.whisper("typing", { name: "Jane" });
void orders.replayMissed();

const chat = echo.join("chat") as unknown as AblyPresenceChannel;

chat.here((members: unknown[]) => console.log(members))
    .joining(() => {})
    .leaving(() => {});

const ticker: AblyChannel = echo.channel("ticker") as unknown as AblyChannel;

ticker.listenToAll((event: string, data: unknown) => console.log(event, data));

// Echo types `connector` as a union of its own built-in connectors, so a
// third-party one is reached through the exported class — the same cast the
// README documents for channels.
const connector = echo.connector as unknown as AblyConnector;

const stop = connector.onConnectionStateChange((change) =>
    console.log(change.current, change.reason?.code),
);

stop();
console.log(VERSION, echo.socketId(), connector.connectionStatus());
echo.disconnect();
TS

npm install --silent --no-audit --no-fund \
    "$TARBALL" \
    "ably@^2" \
    "laravel-echo@^2.3.7" \
    "typescript@^5"

echo "==> typechecking the consumer"
npx --no-install tsc --noEmit
echo "    ok  consumer compiles against the published types"

echo "==> importing the ESM entry point in Node"
node --input-type=module -e '
import { AblyConnector, VERSION } from "@kirschbaum-development/laravel-echo-ably";

if (typeof AblyConnector !== "function") {
    throw new Error("AblyConnector is not exported from the packed tarball");
}

if (typeof AblyConnector.prototype.onConnectionStateChange !== "function") {
    throw new Error("onConnectionStateChange is missing from the packed build");
}

console.log("    ok  imported version " + VERSION);
'

echo
echo "Package verified: $(basename "$TARBALL")"
