---
type: source
title: "Observation: pi.dev gallery index misses pi-pretty-task publish event"
tags:
  - pi.dev
  - gallery
  - npm
  - publish
  - visibility
status: observation
created: 2026-11-17
updated: 2026-11-17
slug: obs-2026-11-17-pi-dev-gallery-index-misses-pi-pretty-task-publish-event
relevance: high
observed_at: 2026-11-17T16:36:33.345Z
source_context: README/visibility improvement work for pi-pretty-task v1.0.3
---

# ⭐ Observation: pi.dev gallery index misses pi-pretty-task publish event

pi.dev package gallery (pi.dev/packages) does NOT list pi-pretty-task despite: npm keyword "pi-package" present, detail page /packages/pi-pretty-task returns 200 with live download count. Diagnostic evidence (2026-11-17): filter ?name=pi-pretty-task returns "0 / 5645"; ?name=pretty returns 13 results without us; gallery universe is 5,645 packages vs npm's 13,942 with the keyword. Neighbors in the sort=recent index at the exact same minute (2026-11-16 14:33-14:35Z) are all listed, only our publish event (modified 2026-11-16T14:34Z) is absent. Ruled out: missing keyword (present), .ts entrypoint (pi-actio/pi-delegation-policy use ./src/index.ts and ARE listed), missing pi manifest (@heihei0299/pi-switch has no pi field and IS listed), low downloads (pi-smart-quota dl=337 listed, we have 775). Conclusion: indexer missed our publish event. Remedy: republish a patch version so a fresh publish event enters the stream, then re-check ?name=pi-pretty-task goes from 0 to 1.

*Relevance: high*
*Context: README/visibility improvement work for pi-pretty-task v1.0.3*
*Tags: pi.dev gallery npm publish visibility*

---
*Observed: 2026-11-17T16:36:33.345Z*
