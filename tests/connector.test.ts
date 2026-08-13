import Echo from "laravel-echo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "../src/auth/token-manager";
import { AblyChannel } from "../src/channels/ably-channel";
import { AblyPresenceChannel } from "../src/channels/ably-presence-channel";
import { AblyPrivateChannel } from "../src/channels/ably-private-channel";
import { AblyConnector } from "../src/connector";
import { VERSION } from "../src/index";
import {
    deferred,
    echoOptions,
    makeJwt,
    settle,
    withoutUnhandledRejections,
} from "./helpers";
import type { MockRealtime } from "./mocks/ably";
import { createMockRealtime } from "./mocks/ably";

/**
 * The ably module is mocked so the client-construction path can be asserted on
 * without a real client ever opening a socket.
 */
const realtimeConstructor = vi.hoisted(() => vi.fn());

vi.mock("ably", () => ({ Realtime: realtimeConstructor }));

/** A token granting everything, so `ensureCapability` resolves from one fetch. */
const TOKEN = makeJwt({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    "x-ably-clientId": "user-42",
    "x-ably-capability": JSON.stringify({ "*": ["*"] }),
});

type Harness = {
    realtime: MockRealtime;
    connector: AblyConnector;
};

/** A connector wired to a mock client, with the auth request stubbed out. */
function setup(driverOptions: Record<string, unknown> = {}): Harness {
    const realtime = createMockRealtime();
    const connector = new AblyConnector(
        echoOptions({
            client: realtime,
            requestTokenFn: vi.fn().mockResolvedValue({ token: TOKEN }),
            ...driverOptions,
        }),
    );

    return { realtime, connector };
}

/** The inverse of the connector's `socketId()` encoding. */
function decodeBase64Url(value: string): string {
    const bytes = Uint8Array.from(
        atob(value.replace(/-/g, "+").replace(/_/g, "/")),
        (character) => character.charCodeAt(0),
    );

    return new TextDecoder().decode(bytes);
}

/** Let the fire-and-forget work a state change kicked off run to completion. */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The connection failing the way a login or a logout makes it fail. */
function failWithMismatch(realtime: MockRealtime): void {
    realtime.connection.emitStateChange({
        current: "failed",
        previous: "connected",
        reason: { code: 40102, message: "client id mismatch" },
    });
}

describe("AblyConnector", () => {
    beforeEach(() => {
        realtimeConstructor.mockReset();
        // A `function`, not an arrow: the connector calls this with `new`, and
        // the object it returns stands in for the client ably would have built.
        realtimeConstructor.mockImplementation(function () {
            return createMockRealtime();
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    describe("connect", () => {
        it("uses an injected client verbatim", () => {
            const { realtime, connector } = setup();

            expect(connector.ably).toBe(realtime);
            expect(realtimeConstructor).not.toHaveBeenCalled();
        });

        it("hands an injected client to the token manager", () => {
            const setClient = vi.spyOn(TokenManager.prototype, "setClient");
            const { realtime, connector } = setup();

            expect(connector.tokenManager).toBeInstanceOf(TokenManager);
            expect(setClient).toHaveBeenCalledWith(realtime);
        });

        it("constructs a client with the driver defaults when none is injected", () => {
            const setClient = vi.spyOn(TokenManager.prototype, "setClient");
            const connector = new AblyConnector(echoOptions());

            expect(realtimeConstructor).toHaveBeenCalledTimes(1);

            const options = realtimeConstructor.mock.calls[0][0];

            expect(options).toMatchObject({
                useTokenAuth: true,
                queryTime: true,
                echoMessages: false,
                agents: { "laravel-echo-ably": VERSION },
            });
            expect(options.authCallback).toBe(
                connector.tokenManager.authCallback,
            );
            expect(setClient).toHaveBeenCalledWith(connector.ably);
        });

        it("lets user clientOptions win over the defaults, except the auth callback", () => {
            const authCallback = vi.fn();
            const connector = new AblyConnector(
                echoOptions({
                    clientOptions: {
                        useTokenAuth: false,
                        queryTime: false,
                        echoMessages: true,
                        agents: { "my-wrapper": "1.2.3" },
                        environment: "sandbox",
                        authCallback,
                    },
                }),
            );

            const options = realtimeConstructor.mock.calls[0][0];

            expect(options).toMatchObject({
                useTokenAuth: false,
                queryTime: false,
                echoMessages: true,
                agents: { "my-wrapper": "1.2.3" },
                environment: "sandbox",
            });
            // The driver's whole capability lifecycle hangs off this callback.
            expect(options.authCallback).toBe(
                connector.tokenManager.authCallback,
            );
            expect(options.authCallback).not.toBe(authCallback);
        });

        it("builds the token manager from the merged Echo options", async () => {
            const fetchMock = vi
                .fn()
                .mockResolvedValue(
                    new Response(JSON.stringify({ token: TOKEN })),
                );

            vi.stubGlobal("fetch", fetchMock);

            const realtime = createMockRealtime();
            const connector = new AblyConnector({
                broadcaster: AblyConnector,
                bearerToken: "bearer-value",
                ably: { client: realtime },
            });

            await settle(connector.privateChannel("orders"));

            // Both the endpoint and the Authorization header come from the
            // merge Echo's base connector performs, not from what was passed in.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0][0]).toBe("/broadcasting/auth");
            expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
                Authorization: "Bearer bearer-value",
            });
        });
    });

    describe("channels", () => {
        it("creates and caches a public channel", async () => {
            const { realtime, connector } = setup();
            const channel = connector.channel("orders");

            expect(channel).toBeInstanceOf(AblyChannel);
            expect(channel).not.toBeInstanceOf(AblyPrivateChannel);
            expect(channel.name).toBe("public:orders");
            expect(connector.channel("orders")).toBe(channel);
            expect(connector.channels["public:orders"]).toBe(channel);

            await settle(channel);

            expect(realtime.channels.get).toHaveBeenCalledWith(
                "public:orders",
                undefined,
            );
        });

        it("creates and caches a private channel", async () => {
            const { realtime, connector } = setup();
            const channel = connector.privateChannel("orders");

            expect(channel).toBeInstanceOf(AblyPrivateChannel);
            expect(channel).not.toBeInstanceOf(AblyPresenceChannel);
            expect(channel.name).toBe("private:orders");
            expect(connector.privateChannel("orders")).toBe(channel);
            expect(connector.channels["private:orders"]).toBe(channel);

            await settle(channel);

            expect(realtime.channels.get).toHaveBeenCalledWith(
                "private:orders",
                undefined,
            );
        });

        it("creates and caches a presence channel", async () => {
            const { realtime, connector } = setup();
            const channel = connector.presenceChannel("chat");

            expect(channel).toBeInstanceOf(AblyPresenceChannel);
            expect(channel.name).toBe("presence:chat");
            expect(connector.presenceChannel("chat")).toBe(channel);
            expect(connector.channels["presence:chat"]).toBe(channel);

            await settle(channel);

            expect(realtime.channels.get).toHaveBeenCalledWith(
                "presence:chat",
                undefined,
            );
        });

        it("keeps the variants of one base name apart", () => {
            const { connector } = setup();

            expect(connector.channel("orders")).not.toBe(
                connector.privateChannel("orders"),
            );
            expect(Object.keys(connector.channels)).toEqual([
                "public:orders",
                "private:orders",
            ]);
        });
    });

    describe("listen", () => {
        it("listens for the event on the public channel of that name", async () => {
            const { realtime, connector } = setup();
            const callback = vi.fn();

            const channel = connector.listen(
                "orders",
                "OrderShipped",
                callback,
            );

            // Echo delegates `echo.listen(...)` straight through to here, and
            // the channel it hands back is the cached public one.
            expect(channel).toBe(connector.channel("orders"));
            expect(channel.name).toBe("public:orders");

            await settle(channel);

            realtime.channels.all["public:orders"].emitMessage({
                name: "App\\Events\\OrderShipped",
                data: { id: 1 },
            });

            expect(callback).toHaveBeenCalledWith({ id: 1 });
        });
    });

    describe("leaveChannel", () => {
        it.each(["private-orders", "private:orders", "orders"])(
            "unsubscribes the one cached private channel given %s",
            async (name) => {
                const { connector } = setup();
                const channel = connector.privateChannel("orders");
                const unsubscribe = vi.spyOn(channel, "unsubscribe");

                await settle(channel);

                connector.leaveChannel(name);

                expect(unsubscribe).toHaveBeenCalledTimes(1);
                expect(connector.channels["private:orders"]).toBeUndefined();
            },
        );

        it("leaves only the named variant when the name carries a prefix", async () => {
            const { connector } = setup();
            const publicChannel = connector.channel("orders");
            const privateChannel = connector.privateChannel("orders");
            const unsubscribe = vi.spyOn(privateChannel, "unsubscribe");

            await settle(publicChannel);
            await settle(privateChannel);

            connector.leaveChannel("private-orders");

            expect(unsubscribe).toHaveBeenCalledTimes(1);
            expect(connector.channels["public:orders"]).toBe(publicChannel);
        });

        it("leaves every cached variant of a bare name", async () => {
            const { connector } = setup();
            const publicChannel = connector.channel("orders");
            const presenceChannel = connector.presenceChannel("orders");
            const other = connector.privateChannel("invoices");
            const unsubscribes = [publicChannel, presenceChannel, other].map(
                (channel) => vi.spyOn(channel, "unsubscribe"),
            );

            await settle(presenceChannel);

            connector.leaveChannel("orders");

            expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
            expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
            expect(unsubscribes[2]).not.toHaveBeenCalled();
            expect(Object.keys(connector.channels)).toEqual([
                "private:invoices",
            ]);
        });

        it("is a no-op for a name nothing is cached under", async () => {
            const { connector } = setup();
            const channel = connector.channel("orders");
            const unsubscribe = vi.spyOn(channel, "unsubscribe");

            await settle(channel);

            connector.leaveChannel("invoices");
            connector.leaveChannel("private:invoices");

            expect(unsubscribe).not.toHaveBeenCalled();
            expect(connector.channels["public:orders"]).toBe(channel);
        });
    });

    describe("leave", () => {
        it("unsubscribes every variant of the base name, and nothing else", async () => {
            const { connector } = setup();
            const channels = [
                connector.channel("orders"),
                connector.privateChannel("orders"),
                connector.presenceChannel("orders"),
                connector.privateChannel("invoices"),
            ];
            const unsubscribes = channels.map((channel) =>
                vi.spyOn(channel, "unsubscribe"),
            );

            await Promise.all(channels.map((channel) => settle(channel)));

            connector.leave("orders");

            expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
            expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
            expect(unsubscribes[2]).toHaveBeenCalledTimes(1);
            expect(unsubscribes[3]).not.toHaveBeenCalled();
            expect(Object.keys(connector.channels)).toEqual([
                "private:invoices",
            ]);
        });

        it("accepts a prefixed name and still leaves the other variants", async () => {
            const { connector } = setup();
            const publicChannel = connector.channel("orders");
            const privateChannel = connector.privateChannel("orders");
            const unsubscribes = [publicChannel, privateChannel].map(
                (channel) => vi.spyOn(channel, "unsubscribe"),
            );

            await settle(privateChannel);

            connector.leave("private-orders");

            expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
            expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
            expect(connector.channels).toEqual({});
        });

        it("is a no-op when no variant was ever joined", () => {
            const { connector } = setup();

            expect(() => connector.leave("orders")).not.toThrow();
        });
    });

    describe("leaving and rejoining the same name", () => {
        it("leaves the successor channel working when the predecessor tears down", async () => {
            // React StrictMode's mount → cleanup → mount, and any quick
            // leave→rejoin: the teardown is still queued behind a token request
            // when the successor is created, and `channels.get` hands that
            // successor the very same underlying ably channel.
            const gate = deferred<{ token: string }>();
            const { realtime, connector } = setup({
                requestTokenFn: vi.fn().mockReturnValue(gate.promise),
            });

            const first = connector.privateChannel("orders");

            connector.leaveChannel("private-orders");

            const second = connector.privateChannel("orders");
            const subscribed = vi.fn();
            const message = vi.fn();

            expect(second).not.toBe(first);

            second.subscribed(subscribed);
            second.listen(".OrderShipped", message);

            gate.resolve({ token: TOKEN });

            await settle(first);
            await settle(second);
            await flush();

            const underlying = realtime.channels.all["private:orders"];
            const attached = underlying.attach.mock.invocationCallOrder;

            // ably does not refcount attach intents, so any detach the channel
            // being left issues has to land before the successor attaches —
            // one landing after would leave it silently unattached.
            underlying.detach.mock.invocationCallOrder.forEach((order) =>
                expect(order).toBeLessThan(attached[attached.length - 1]),
            );

            subscribed.mockClear();
            underlying.emitStateChange({
                current: "attached",
                previous: "attaching",
            });

            expect(subscribed).toHaveBeenCalledTimes(1);

            underlying.emitMessage({ name: "OrderShipped", data: { id: 1 } });

            expect(message).toHaveBeenCalledWith({ id: 1 });
        });

        it("keeps the successor presence channel entering and reporting members", async () => {
            const gate = deferred<{ token: string }>();
            const { realtime, connector } = setup({
                requestTokenFn: vi.fn().mockReturnValue(gate.promise),
            });

            const first = connector.presenceChannel("chat");

            connector.leaveChannel("presence-chat");

            const second = connector.presenceChannel("chat");
            const joined = vi.fn();

            second.joining(joined);

            gate.resolve({ token: TOKEN });

            await settle(first);
            await settle(second);
            await flush();

            const underlying = realtime.channels.all["presence:chat"];

            underlying.presence.enter.mockClear();
            underlying.emitStateChange({
                current: "attached",
                previous: "attaching",
            });
            await flush();

            // Exactly one: the successor re-enters, the channel that was left
            // does not.
            expect(underlying.presence.enter).toHaveBeenCalledTimes(1);

            underlying.presence.emit("enter", {
                clientId: "u1",
                data: { id: 1 },
            });

            expect(joined).toHaveBeenCalledWith({ id: 1 });
        });

        it("does not wipe the successor's registrations when the teardown lands late", async () => {
            // The same race, with the ordering forced rather than left to the
            // microtask queue: the predecessor's attach is still in flight
            // while the successor subscribes, so its teardown runs after the
            // successor has registered everything it cares about.
            const { realtime, connector } = setup();
            const underlying = realtime.channels.get("private:orders");
            const attaching = deferred<null>();

            underlying.attach.mockReturnValueOnce(attaching.promise);

            const first = connector.privateChannel("orders");

            connector.leaveChannel("private-orders");

            const second = connector.privateChannel("orders");
            const subscribed = vi.fn();
            const message = vi.fn();

            second.subscribed(subscribed);
            second.listen(".OrderShipped", message);

            await settle(second);

            attaching.resolve(null);
            await settle(first);
            await flush();

            expect(underlying.detach).not.toHaveBeenCalled();

            subscribed.mockClear();
            underlying.emitStateChange({
                current: "attached",
                previous: "attaching",
            });

            expect(subscribed).toHaveBeenCalledTimes(1);

            underlying.emitMessage({ name: "OrderShipped", data: { id: 1 } });

            expect(message).toHaveBeenCalledWith({ id: 1 });
        });

        it("does not strip the successor's presence registrations or its membership", async () => {
            const { realtime, connector } = setup();
            const underlying = realtime.channels.get("presence:chat");
            const attaching = deferred<null>();

            underlying.attach.mockReturnValueOnce(attaching.promise);

            const first = connector.presenceChannel("chat");

            connector.leaveChannel("presence-chat");

            const second = connector.presenceChannel("chat");
            const joined = vi.fn();

            second.joining(joined);

            await settle(second);

            expect(underlying.presence.enter).toHaveBeenCalledTimes(1);

            attaching.resolve(null);
            await settle(first);
            await flush();

            // The channel that was left must not take the successor's member
            // out of the presence set: both instances are the same client.
            expect(underlying.presence.leave).not.toHaveBeenCalled();

            underlying.presence.emit("enter", {
                clientId: "u1",
                data: { id: 1 },
            });

            expect(joined).toHaveBeenCalledWith({ id: 1 });
        });

        it("detaches once the last instance of the channel has left", async () => {
            const { realtime, connector } = setup();

            const channel = connector.privateChannel("orders");

            await settle(channel);

            connector.leaveChannel("private-orders");
            await flush();

            expect(
                realtime.channels.all["private:orders"].detach,
            ).toHaveBeenCalledTimes(1);
        });
    });

    describe("socketId", () => {
        it("is undefined until the connection has a key", () => {
            const { realtime, connector } = setup();

            realtime.connection.key = undefined;

            expect(connector.socketId()).toBeUndefined();
        });

        it("is the base64url connection key and client id composite", () => {
            const { realtime, connector } = setup();

            realtime.connection.key = "connection-key-1";
            realtime.auth.clientId = "user-42";

            const socketId = connector.socketId();

            expect(socketId).toBeDefined();
            // base64url: no padding, and none of base64's URL-hostile characters.
            expect(socketId).not.toMatch(/[+/=]/);
            expect(JSON.parse(decodeBase64Url(socketId as string))).toEqual({
                connectionKey: "connection-key-1",
                clientId: "user-42",
            });
        });

        it("reports a null client id for an anonymous connection", () => {
            const { realtime, connector } = setup();

            realtime.connection.key = "connection-key-1";
            realtime.auth.clientId = null;

            expect(
                JSON.parse(decodeBase64Url(connector.socketId() as string)),
            ).toEqual({
                connectionKey: "connection-key-1",
                clientId: null,
            });
        });

        it("round-trips a non-ascii client id", () => {
            const { realtime, connector } = setup();

            realtime.connection.key = "connection-key-1";
            realtime.auth.clientId = "usuário-✓";

            expect(
                JSON.parse(decodeBase64Url(connector.socketId() as string)),
            ).toEqual({
                connectionKey: "connection-key-1",
                clientId: "usuário-✓",
            });
        });
    });

    describe("connectionStatus", () => {
        it.each([
            ["initialized", "connecting"],
            ["connecting", "connecting"],
            ["connected", "connected"],
            ["disconnected", "reconnecting"],
            ["suspended", "reconnecting"],
            ["closing", "disconnected"],
            ["closed", "disconnected"],
            ["failed", "failed"],
        ])("maps the ably %s state to %s", (state, status) => {
            const { realtime, connector } = setup();

            realtime.connection.state = state;

            expect(connector.connectionStatus()).toBe(status);
        });
    });

    describe("onConnectionChange", () => {
        it("reports the mapped status of every connection state change", () => {
            const { realtime, connector } = setup();
            const callback = vi.fn();

            connector.onConnectionChange(callback);

            realtime.connection.emitStateChange({
                current: "connected",
                previous: "connecting",
            });
            realtime.connection.emitStateChange({
                current: "suspended",
                previous: "connected",
            });

            expect(callback.mock.calls).toEqual([
                ["connected"],
                ["reconnecting"],
            ]);
        });

        it("returns an unsubscriber that stops the reports", () => {
            const { realtime, connector } = setup();
            const callback = vi.fn();

            const unsubscribe = connector.onConnectionChange(callback);

            realtime.connection.emitStateChange({ current: "connected" });

            unsubscribe();

            realtime.connection.emitStateChange({ current: "closed" });

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith("connected");
        });
    });

    describe("client id mismatch recovery", () => {
        it("resets the token, reconnects, then re-subscribes every channel", async () => {
            const { realtime, connector } = setup();
            const channels = [
                connector.channel("orders"),
                connector.privateChannel("orders"),
            ];

            await Promise.all(channels.map((channel) => settle(channel)));

            const reset = vi.spyOn(connector.tokenManager, "reset");
            const subscribes = channels.map((channel) =>
                vi.spyOn(channel, "subscribe"),
            );

            failWithMismatch(realtime);

            expect(reset).toHaveBeenCalledTimes(1);
            expect(realtime.connect).toHaveBeenCalledTimes(1);
            expect(subscribes[0]).toHaveBeenCalledTimes(1);
            expect(subscribes[1]).toHaveBeenCalledTimes(1);
            // The token has to be gone, and the connection reopening, before a
            // channel asks for capability again.
            expect(reset.mock.invocationCallOrder[0]).toBeLessThan(
                realtime.connect.mock.invocationCallOrder[0],
            );
            expect(realtime.connect.mock.invocationCallOrder[0]).toBeLessThan(
                subscribes[0].mock.invocationCallOrder[0],
            );

            await flush();
        });

        it("ignores a connection failure with any other reason", async () => {
            const { realtime, connector } = setup();
            const channel = connector.privateChannel("orders");

            await settle(channel);

            const reset = vi.spyOn(connector.tokenManager, "reset");
            const subscribe = vi.spyOn(channel, "subscribe");

            realtime.connection.emitStateChange({
                current: "failed",
                previous: "connected",
                reason: { code: 40140, message: "token expired" },
            });
            realtime.connection.emitStateChange({
                current: "failed",
                previous: "connected",
            });

            expect(reset).not.toHaveBeenCalled();
            expect(realtime.connect).not.toHaveBeenCalled();
            expect(subscribe).not.toHaveBeenCalled();
        });

        it("ignores a 40102 that did not fail the connection", async () => {
            const { realtime, connector } = setup();
            const channel = connector.privateChannel("orders");

            await settle(channel);

            const subscribe = vi.spyOn(channel, "subscribe");

            realtime.connection.emitStateChange({
                current: "disconnected",
                previous: "connected",
                reason: { code: 40102, message: "client id mismatch" },
            });

            expect(realtime.connect).not.toHaveBeenCalled();
            expect(subscribe).not.toHaveBeenCalled();
        });

        it("routes a failed re-subscribe to the channel's error callbacks", async () => {
            const requestTokenFn = vi.fn().mockResolvedValue({ token: TOKEN });
            const { realtime, connector } = setup({ requestTokenFn });
            const channel = connector.privateChannel("orders");

            await settle(channel);

            const error = vi.fn();
            const failure = new Error("auth endpoint down");

            channel.error(error);
            requestTokenFn.mockRejectedValue(failure);

            const rejections = await withoutUnhandledRejections(async () => {
                failWithMismatch(realtime);

                await flush();
            });

            expect(error).toHaveBeenCalledWith(failure);
            expect(rejections).toEqual([]);
        });

        it("recovers once for a run of failures, not once per failure", async () => {
            const { realtime, connector } = setup();
            const channel = connector.privateChannel("orders");

            await settle(channel);

            const reset = vi.spyOn(connector.tokenManager, "reset");
            const subscribe = vi.spyOn(channel, "subscribe");

            failWithMismatch(realtime);
            failWithMismatch(realtime);
            failWithMismatch(realtime);

            // A mismatch that survives the recovery is not going to be fixed by
            // running it again: the connection stays failed, which is what
            // connectionStatus() and onConnectionChange subscribers report.
            expect(reset).toHaveBeenCalledTimes(1);
            expect(realtime.connect).toHaveBeenCalledTimes(1);
            expect(subscribe).toHaveBeenCalledTimes(1);

            await flush();
        });

        it("recovers again once the connection has come back", async () => {
            const { realtime, connector } = setup();
            const channel = connector.privateChannel("orders");

            await settle(channel);

            const reset = vi.spyOn(connector.tokenManager, "reset");
            const subscribe = vi.spyOn(channel, "subscribe");

            failWithMismatch(realtime);

            realtime.connection.emitStateChange({
                current: "connected",
                previous: "connecting",
            });

            // A later mismatch is a new identity change, not the same one
            // failing again.
            failWithMismatch(realtime);

            expect(reset).toHaveBeenCalledTimes(2);
            expect(realtime.connect).toHaveBeenCalledTimes(2);
            expect(subscribe).toHaveBeenCalledTimes(2);

            await flush();
        });
    });

    describe("disconnect", () => {
        it("closes the ably connection", () => {
            const { realtime, connector } = setup();

            connector.disconnect();

            expect(realtime.close).toHaveBeenCalledTimes(1);
        });
    });

    describe("through Echo", () => {
        it("drives a private channel end to end", async () => {
            const realtime = createMockRealtime();
            const echo = new Echo({
                broadcaster: AblyConnector,
                ably: {
                    client: realtime,
                    requestTokenFn: () => Promise.resolve({ token: TOKEN }),
                },
            });

            const channel = echo.private("orders") as AblyPrivateChannel;

            expect(echo.connector).toBeInstanceOf(AblyConnector);
            expect(channel).toBeInstanceOf(AblyPrivateChannel);
            expect(channel.name).toBe("private:orders");

            await settle(channel);

            expect(realtime.channels.get).toHaveBeenCalledWith(
                "private:orders",
                undefined,
            );
            expect(
                realtime.channels.all["private:orders"].attach,
            ).toHaveBeenCalled();
        });

        it("delivers echo.listen() through to a public channel", async () => {
            const realtime = createMockRealtime();
            const echo = new Echo({
                broadcaster: AblyConnector,
                ably: { client: realtime },
            });
            const callback = vi.fn();

            const channel = echo.listen(
                "orders",
                "OrderShipped",
                callback,
            ) as AblyChannel;

            expect(channel).toBeInstanceOf(AblyChannel);
            expect(channel.name).toBe("public:orders");

            await settle(channel);

            realtime.channels.all["public:orders"].emitMessage({
                name: "App\\Events\\OrderShipped",
                data: { id: 7 },
            });

            expect(callback).toHaveBeenCalledWith({ id: 7 });
        });
    });
});
