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
