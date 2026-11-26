---
type: source
title: pi-matt-implement-flow 脚本层的七个坑（自己重写时的清单）
status: insight
category: architecture
created: 2026-11-26
updated: 2026-11-26
slug: pi-matt-implement-flow-script-gotchas
---

# pi-matt-implement-flow 脚本层的七个坑（自己重写时的清单）

插件 `pi-matt-implement-flow`（npm 包名同，本机 v0.4.0 在 `C:/Users/10781/.pi/agent/npm/node_modules/pi-matt-implement-flow/`，上游 `github.com/toomanyopenfiles/pi-matt-implement-flow`）被用作「按票派子代理 → 复审 → 合并」的编排器。它本身由 JS 脚本驱动，脚本层的七个坑在一次完整 run（pi-pretty-task 七票 + 复盘票，2026-11-25/26）里全部踩到并记录在案。用户已表示可能自己重写一套，所以这里按「重写时该修什么」排列。

## 一、`scripts/mechanical-report.js`：环境缺失被报成数据错误
worktree 里没有 `node_modules` 时，typed gate 返回的是 schema 错误（`validationOutput must be string`），不是「依赖缺失」。编排者因此三次手跑 `npm ci` 才恢复。重写要点：门禁第一步先验证依赖存在，缺失就输出带 `env-missing` 标记的错误，别让它伪装成实现失败。上游 issue：`toomanyopenfiles/pi-matt-implement-flow#43`。

## 二、`scripts/ledger.js add <type>`：参数集无法自证
`add --help` 只印整个命令列表并说「参数集见 --help」，`add <type> --help` 也是同一段文本。实测差异：`settled` 要 `--round --head-sha`、**不收 `--key`**；`dispatch` 收 `--key`；`fix` 必须要 `--fix-no` 与 `--resume-run-id`；`merge` 要求该票最近一条 verdict 是 approved 否则拒绝。一次 run 里因猜参数被拒四次。重写要点：按事件生成帮助，必选/可选分列。上游 issue：`#46`。

## 三、`scripts/ledger.js` 的 `shaExists`：全 SHA 会假否定
它用 `git -C <runtimeDir> cat-file -e <sha>^{commit}` 校验提交。本机 git 2.56 + 多 pack/multi-pack-index 的仓库里，40 位全 SHA 偶发查不到（缩名可查，diff/log/merge 均正常，`git repack -adq` 只短暂缓解）。绕过：入账时传 7 位缩写。重写要点：用 `git rev-parse --verify <sha>^{commit}`，它对两种长度都稳。

## 四、`scripts/ledger.js sync`：合并 SHA 只从票文件的 `## Comments` 节读
第一次 sync 只关掉了父 spec，因为合并 SHA 被写在文件尾部，被静默忽略；补 `## Comments` 段后重跑才全关（幂等 marker 防重复评论）。重写要点：读不到就报错，不要静默跳过。

## 五、封账后一切事件被拒
`close` 入账后 `state=complete`，`add` 一律拒绝；跟进票必须新开 runtime dir 与 `init`。实测为此另建 `.pi/matt-implement/iteration-end/`。重写要点：报错里直接给出新 run 的 `init` 命令行。

## 六、`scripts/axis-axes.js` 与子代理深度冲突
复审者（reviewer 子代理）本身就是 depth 1，再去派双轴子代理会撞 `DEFAULT_SUBAGENT_MAX_DEPTH = 2`（`Nested subagent call blocked (depth=2, max=2)`）。实测 reviewer 自己跑完两条轴、不影响裁决。重写要点：轴分析写成库函数在评审者进程内直接调用，别设计成再派子代理。

## 七、复审裁决的落点不显眼
子代理的 output artifact 会被其自身上下文压缩器覆盖（只剩 `📦 [ACP] Compressed …`），真裁决在 `async-subagent-runs/<runId>/structured-output/<dir>/output.json`，其中 `output-0.log` 有 `Structured output captured.` 可确认。重写要点：把结构化结果落成 run 目录下的固定文件名（如 `verdict.json`），别只靠子代理输出。

## 附带：worktree 准入门槛
`worktree: true` 的派发要求主仓工作树干净，否则 `Worktree admission failed … requires a clean git working tree`。实测触发源是 wiki 插件写 `.llm-wiki/meta/*` 等跟踪文件。编排规则已写进 `~/.pi/agent/AGENTS.md`：派发前必须 `git --no-pager status --porcelain`。

## 相关
- [[sources/matt-implement-sync-ticket-comments]]
- [[sources/matt-implement-gate-needs-node-modules]]
- [[sources/git-cat-file-full-sha-flake-multipack]]
- [[sources/subagent-structured-verdict-path]]


*Category: architecture*

---
*Captured: 2026-11-26*

## Related

_Add links to related pages._
