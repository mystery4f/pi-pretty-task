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
  },
});
