/**
 * Vitest config. The scope is deliberately narrow: only our own `test/` folder —
 * `.tmp/` holds upstream clones whose test suites must never run here.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".tmp/**", ".pi/**"],
    passWithNoTests: true,
    // Tests drive real processes, and a stop is a real `taskkill` per phase;
    // the default 5s is not enough headroom on a busy CI.
    testTimeout: 30000,
    // Cleanup is the flakiest hook of all: `afterEach` kills whatever a test left
    // behind, and on a machine where spawning `taskkill` is slow that wait lands
    // in the hook, not in the test. The hook timeout is a ceiling on cleanup, not
    // a claim about the code, so it gets the same headroom as a test.
    hookTimeout: 30000,
  },
});
