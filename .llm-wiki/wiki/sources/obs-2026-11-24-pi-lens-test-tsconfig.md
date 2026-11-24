---
type: source
title: "Observation: pi-lens 告警清零：抑制语法与 test tsconfig 项目"
tags:
  - pi-pretty-task
  - pi-lens
  - lint
  - suppression
  - tsconfig
status: observation
created: 2026-11-24
updated: 2026-11-24
slug: obs-2026-11-24-pi-lens-test-tsconfig
relevance: high
observed_at: 2026-11-24T02:02:18.280Z
source_context: 处理 pi-pretty-task 的 pi-lens（LSP）检查告警
---

# ⭐ Observation: pi-lens 告警清零：抑制语法与 test tsconfig 项目

pi-pretty-task 的 pi-lens 告警清理收尾（提交 533c842 + 74cd398，已推送 origin/main）。13 处 nested-ternary 全改写（tasks-panel 抽 bestMatchFirst/newestFire、keys.ts 的 1/2/3 改 ReadonlyMap 查表 TAB_KEY、process/tools.ts 抽 templateList/followNote/waitHeadline/chainStopHeadline/stopHeadline、loop-tasks.ts 的 create 改 if/else 与 fireOutcome 私有方法）；16 条抑制全带理由（7 条穷尽 switch、2 条 Promise.all 误报、sort-without-comparator ×2、ts-while-index-length、no-flag-argument、Semgrep detect-child-process）。关键新知识：ast-grep 抑制用 `// pi-lens-ignore: <rule> -- <理由>`（被标记行上一行），Semgrep 用 `// nosemgrep: <rule-id>` 且不能带 `-- 理由`（会被并入 id）。另一个根因：test/ 不在任何 tsconfig project 里导致 LSP 用推断设置检查，43 个文件针对 vitest 的 typescript:2307 与 extension-harness.ts:430 的 keyText 全是假告警 —— 新增 test/tsconfig.json（extends ../tsconfig.dev.json，include 用 ../src、../test、../vitest.config.ts）后 88 文件 0 告警。闸门 check/lint/test 全 0（499 测试）。

*Relevance: high*
*Context: 处理 pi-pretty-task 的 pi-lens（LSP）检查告警*
*Tags: pi-pretty-task pi-lens lint suppression tsconfig*

---
*Observed: 2026-11-24T02:02:18.280Z*
