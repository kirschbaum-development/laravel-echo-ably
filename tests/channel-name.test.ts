import { describe, expect, it } from "vitest";
import {
    baseName,
    isGuarded,
    normalize,
    toPresence,
    toPrivate,
    toPublic,
} from "../src/util/channel-name";

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
