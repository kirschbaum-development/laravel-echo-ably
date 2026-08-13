import { describe, expect, it } from "vitest";
import { parseJwt, toTokenDetails } from "../src/auth/jwt";
import { makeJwt } from "./helpers";

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

    it("throws when the capability claim is not JSON", () => {
        expect(() =>
            parseJwt(
                makeJwt({ iat: 1, exp: 2, "x-ably-capability": "not json" }),
            ),
        ).toThrow("Invalid JWT");
    });
});

describe("toTokenDetails", () => {
    it("produces ably TokenDetails", () => {
        const details = toTokenDetails(makeJwt(payload));

        expect(details.token).toBe(makeJwt(payload));
        expect(details.clientId).toBe("user-42");
        expect(details.expires).toBe(1_700_028_800_000);
        expect(details.issued).toBe(1_700_000_000_000);
        expect(JSON.parse(details.capability)).toEqual({
            "public:*": ["subscribe", "history", "channel-metadata"],
            "private:orders": ["*"],
        });
    });
});
