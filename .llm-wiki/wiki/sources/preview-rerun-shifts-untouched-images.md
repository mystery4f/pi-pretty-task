---
type: source
title: A full preview re-render rewrites images nothing changed
status: insight
category: tooling
created: 2026-11-27
updated: 2026-11-27
slug: preview-rerun-shifts-untouched-images
---

# A full preview re-render rewrites images nothing changed

`npm run preview` in pi-pretty-task rendered all eleven README images every run, and the rasteriser shifted a few hundred bytes on the untouched ones — four tracked PNG/GIF files came back modified with no source change behind them. Reverting them with `git checkout -- docs/preview*.png` is the wrong instinct: the same command throws away a real change to another image sitting beside it, and nothing tells you which is which.

Two fixes, both now in place. `scripts/preview/preview.mjs` takes `--only <label|filename>` and writes exactly one image (a shots table plus a filter, and the GIF is skipped unless asked for), so a one-image change produces a one-file diff. And the README image set is pinned by `test/unit/readme-coverage.test.ts`, which reads the real registries through the extension harness, so an image that names a surface no longer registered fails the test rather than silently ageing.

Related: [[pi-pretty-task 文档索引]].


*Category: tooling*

---
*Captured: 2026-11-27*

## Related

_Add links to related pages._
