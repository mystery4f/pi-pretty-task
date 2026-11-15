/**
 * Vitest config. The scope is deliberately narrow: only our own `test/` folder —
 * `.tmp/` holds upstream clones whose test suites must never run here.
 *
 * The suite is split into two projects so the cost of a change is visible and a
 * fast subset exists: `test/unit/` holds tests of pure logic (parsing, schedules,
 * stores over temp files, panels over records) and `test/integration/` holds the
 * tests that spawn a real child and stop a real tree. `npm test` runs both; the
 * `test:unit` script is the inner loop for a change that cannot reach a process.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

/** Settings both projects share, so neither can drift from the other. */
const shared = {
  exclude: ["node_modules/**", "dist/**", ".tmp/**", ".pi/**"],
  passWithNoTests: true,
  // Integration tests drive real processes, and a stop is a real `taskkill` per
  // phase; the default 5s is not enough headroom on a busy CI.
  testTimeout: 30000,
  // Cleanup is the flakiest hook of all: `afterEach` kills whatever a test left
  // behind, and on a machine where spawning `taskkill` is slow that wait lands
  // in the hook, not in the test. The hook timeout is a ceiling on cleanup, not
  // a claim about the code, so it gets the same headroom as a test.
  hookTimeout: 30000,
  // One worker per core is the wrong shape here: most of these tests spend their
  // time waiting on real children and on `taskkill`, so a queue of nineteen of
  // them on a twenty-core machine thrashes instead of overlapping. Measured on
  // this repository's own suite (425 tests): the default nineteen workers took
  // 54s and failed four tests to timeouts, six workers took 49s and failed none.
  // Eight is the cap; `--maxWorkers` on the command line still wins for a run
  // that wants another number.
  maxWorkers: Math.min(8, availableParallelism()),
} as const;
export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { test: { ...shared, name: "integration", include: ["test/integration/**/*.test.ts"] } },
    ],
  },
});
