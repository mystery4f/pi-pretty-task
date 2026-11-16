---
type: source
title: "Observation: Release design for pi-pretty-task 1.0.0"
tags:
  - release
  - npm
  - ci
  - packaging
status: observation
created: 2026-11-16
updated: 2026-11-16
slug: obs-2026-11-16-release-design-for-pi-pretty-task-1-0-0
relevance: high
observed_at: 2026-11-16T07:10:32.902Z
source_context: Adding release-triggered npm auto-publish and packaging 1.0.0
---

# ⭐ Observation: Release design for pi-pretty-task 1.0.0

pi-pretty-task 1.0.0 release design: .github/workflows/publish.yml triggers on GitHub `release: published`, runs check/lint/build, verifies the npm tarball carries src/index.ts, skills/pretty-task-templates/SKILL.md and dist/index.js, enforces tag == package.json version, checks NPM_TOKEN, then `npm publish` (prerelease -> --tag next). Root packaging bug fixed: package.json pi.extensions points at ./src/index.ts and pi.skills at ./skills, but files was [dist] only, so the published tarball could not be loaded by pi; files is now [dist, src, skills], plus publishConfig (public + registry.npmjs.org) and prepack=npm run build. First publish needs a granular npm token with All packages / Read and write / Bypass 2FA (per-package scope fails with misleading E404 because pi-pretty-task does not exist yet); after 1.0.0 is live, scope to the single package or migrate to OIDC trusted publishing. Local gates check=0 lint=0, tarball 132 files / 289041 bytes at .artifacts/pi-pretty-task-1.0.0.tgz.

*Relevance: high*
*Context: Adding release-triggered npm auto-publish and packaging 1.0.0*
*Tags: release npm ci packaging*

---
*Observed: 2026-11-16T07:10:32.902Z*
