import { configDefaults, defineConfig } from "vitest/config";
import dts from "vite-plugin-dts";

export default defineConfig({
    plugins: [
        dts({
            insertTypesEntry: true,
            rollupTypes: true,
            include: ["src/**/*.ts"],
        }),
    ],
    build: {
        lib: {
            entry: "src/index.ts",
            formats: ["es"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            external: ["ably", "laravel-echo"],
        },
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: true,
        minify: false,
        target: "es2022",
    },
    test: {
        // Integration tests hit a live Ably account and are run by a
        // dedicated script, never by the default `npm test`.
        exclude: [...configDefaults.exclude, "tests/integration/**"],
    },
});
