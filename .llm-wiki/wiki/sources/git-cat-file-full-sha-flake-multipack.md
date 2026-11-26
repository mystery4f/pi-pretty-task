---
type: source
title: git cat-file -e rejects a valid full SHA in a multi-pack repo
status: insight
category: bugfix
created: 2026-11-25
updated: 2026-11-25
slug: git-cat-file-full-sha-flake-multipack
---

# git cat-file -e rejects a valid full SHA in a multi-pack repo

In the pi-pretty-task repo (git 2.56, multi-pack with a multi-pack-index), `git cat-file -e <40-char sha>^{commit}` intermittently fails even though the commit exists: abbreviated SHA works, `git diff`/`git log`/merges work, and `git repack -adq` only helps briefly.

That matters because pi-matt-implement-flow's ledger runs exactly that check before accepting a `merge`/`settled` event with `--head-sha`; a correct full SHA can be rejected. The workaround applied through a whole run was passing 7-character abbreviations, which resolve fine and keep the ledger's evidence check green.

*Category: bugfix*

---
*Captured: 2026-11-25*

## Related

_Add links to related pages._
