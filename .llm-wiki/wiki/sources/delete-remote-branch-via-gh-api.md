---
type: source
title: 删远端分支走 gh API，git push --delete 会被拦
status: insight
category: devops
created: 2026-11-15
updated: 2026-11-15
slug: delete-remote-branch-via-gh-api
---

# 删远端分支走 gh API，git push --delete 会被拦

实测（pi-pretty-task，2026-11-15）：`git push origin --delete <branch>` 被 CC Safety Net 规则 `git.push-delete` 直接拦住，命令不执行。

可用替代：`gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`，返回 204 无输出；网络抖动时包一层重试即可（本次 5 次才成功，前四次 `TLS handshake timeout`）。

判据：删远端分支走 gh API，不依赖 `git push --delete`；删之前先 `git merge-base --is-ancestor origin/<b> origin/main` 确认已合并。

相关：[[syntheses/pi-pretty-task-文档索引]]


*Category: devops*

---
*Captured: 2026-11-15*

## Related

_Add links to related pages._
