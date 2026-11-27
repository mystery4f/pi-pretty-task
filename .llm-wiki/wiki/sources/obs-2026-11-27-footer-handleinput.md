---
type: source
title: "Observation: footer 打印字形、handleInput 收的是终端序列：按键测试必须翻译"
tags:
  - testing
  - panel
  - keys
  - pi-pretty-task
status: observation
created: 2026-11-27
updated: 2026-11-27
slug: obs-2026-11-27-footer-handleinput
relevance: high
observed_at: 2026-11-27T18:04:20.127Z
source_context: 为 pi-pretty-task 补面板按键守卫测试
---

# ⭐ Observation: footer 打印字形、handleInput 收的是终端序列：按键测试必须翻译

pi-pretty-task 里写「footer 每个键喂进 TasksPanel.handleInput 必须改变某个状态」这条测试时，第一版直接把手印的字形喂进去（`↑`、`Enter`、`alt+q`），结果 `↑` 永远不动：`src/ui/panel/keys.ts` 的 footer 画的是字形，`handleInput` 用 pi 的 `matchesKey` 比对终端序列，`matchesKey("↑","up") === false`。测试里必须加一层 `PRESS` 映射（`↑→ESC[A`、`↓→ESC[B`、`←→ESC[D`、`Enter→\r`、`alt+q→ESC q`），否则这条断言永远假绿——假绿比红更危险。另一个同类坑：`readme-keys.test.ts` 旧的 `isKey` 用 `[^\w\s]{1,3}`，把 `k`/`a`/`R`/`c`/`x` 这些单字符键全过滤掉了，所以它实际只检查了 4 个键，`←` 才混进 "List keys" 而没被发现。单字符要算键、单词要排除（`all`、`running` 是值不是键）。

*Relevance: high*
*Context: 为 pi-pretty-task 补面板按键守卫测试*
*Tags: testing panel keys pi-pretty-task*

---
*Observed: 2026-11-27T18:04:20.127Z*
