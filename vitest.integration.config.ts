import { configDefaults, defineConfig } from "vitest/config";

/**
 * The integration suite's own config, because the default one excludes
 * `tests/integration` outright and vitest's CLI `--exclude` only ever adds to
 * that list. Nothing here is shared with the library build: these tests import
 * from `src/`, exactly as the unit suite does.
 */
export default defineConfig({
    test: {
        include: ["tests/integration/**/*.test.ts"],
        exclude: [...configDefaults.exclude],
    },
});
