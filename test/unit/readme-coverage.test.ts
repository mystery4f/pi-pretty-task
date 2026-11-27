/**
 * The README as a checklist instead of a story.
 *
 * The front page is assembled in the order the features were built, so a tool
 * added later, a card nobody photographed or a section that drifted out of the
 * image list is invisible: a reader cannot miss what they never knew to look
 * for. This test makes the page complete by comparing it against the package's
 * own registration tables — `registerTool`, `registerMessageRenderer` and
 * `registerEntryRenderer` are exactly the set of surfaces a user can meet — and
 * against the files in `docs/`, so an image the page claims is on disk and an
 * image on disk is on the page.
 *
 * The literal lists live in one place, the registration call site: a rename that
 * reaches the code and not the page fails here, before a release.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "../support/extension-harness.js";
import { makeTempDir } from "../support/processes.js";

const ROOT = join(import.meta.dirname, "..", "..");
const README = join(ROOT, "README.md");
const PREVIEWS = join(ROOT, "docs", "previews.md");
const DOCS = join(ROOT, "docs");
const IMAGE = /^preview[\w.-]*\.(?:png|gif)$/u;

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function loadHarness(): Promise<Harness> {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  return createHarness({ cwd: directory.path, sessionId: "session-readme-coverage" });
}

/** The image file names the page points at, in the order it points at them. */
function imagesIn(text: string): string[] {
  return [...text.matchAll(/docs\/(preview[\w.-]*\.(?:png|gif))/gu)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "");
}

/** `missing` is the whole point of every case: an empty list means the page kept up. */
function missing(names: readonly string[], text: string): string[] {
  return names.filter((name) => !text.includes(name));
}

describe("the README's coverage", () => {
  it("names every tool the package registers", async () => {
    const harness = await loadHarness();
    const readme = await readFile(README, "utf8");

    expect(missing(harness.toolNames, readme)).toEqual([]);
  });

  it("names every card the package draws", async () => {
    const harness = await loadHarness();
    const readme = await readFile(README, "utf8");

    expect(harness.rendererTypes.length).toBeGreaterThan(0);
    expect(harness.entryRendererTypes.length).toBeGreaterThan(0);
    expect(missing([...harness.rendererTypes, ...harness.entryRendererTypes], readme)).toEqual([]);
  });

  it("points at images that are on disk, and none that is not", async () => {
    const readme = await readFile(README, "utf8");
    const referenced = imagesIn(readme);
    const onDisk = (await readdir(DOCS)).filter((name) => IMAGE.test(name));

    expect(referenced.length).toBeGreaterThan(0);
    expect([...new Set(referenced)].sort()).toEqual(referenced.sort());
    // Both directions: a missing file breaks the page, an unlisted file drifts.
    expect(onDisk.sort()).toEqual([...new Set(referenced)].sort());
  });

  it("keeps the image list and the gallery in step, one row per image", async () => {
    const readme = await readFile(README, "utf8");
    const previews = await readFile(PREVIEWS, "utf8");
    const listed = [...new Set(imagesIn(previews))].sort();

    expect(listed).toEqual([...new Set(imagesIn(readme))].sort());
  });
});
