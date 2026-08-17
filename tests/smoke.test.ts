import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index";

describe("package", () => {
    it("reports the version package.json declares", async () => {
        // `npm version` rewrites package.json and nothing else, so the agent
        // string this driver sends to Ably drifts silently unless something
        // holds the two together. This is that something.
        const manifest = (await import("../package.json")) as unknown as {
            default: { version: string };
        };

        expect(VERSION).toBe(manifest.default.version);
    });

    it("can import laravel-echo base classes", async () => {
        const { Connector, Channel } = await import("laravel-echo");
        expect(Connector).toBeDefined();
        expect(Channel).toBeDefined();
    });
});
