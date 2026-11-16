---
type: source
title: "Observation: skills 结构检查脚本 lint-skills.mjs"
tags:
  - skills
  - tooling
  - markdown
  - lint
status: observation
created: 2026-11-16
updated: 2026-11-16
slug: obs-2026-11-16-skills-lint-skills-mjs
relevance: medium
observed_at: 2026-11-16T18:34:15.152Z
source_context: 给 ~/.agents/skills 加结构检查
---

# 🔍 Observation: skills 结构检查脚本 lint-skills.mjs

技能文件的三个真实故障都靠脚本才发现：CRLF 让 `---` 判断失效（split("\n") 会留下 \r）、markdown 硬换行的行尾两空格被我误判成噪声、`<question-example>` 包裹块里的标题被误报为缺空行。脚本 `C:\Users\10781\.agents\skills\lint-skills.mjs`（无依赖，node 直跑）检查五项：frontmatter 的 name/description 且 name 等于目录名、标题前后空行、同文件重复 bullet、制表符与末尾换行、description ≤1024 字符。53 个技能全绿；用坏样本验证过它确实能报出 name 不符、缺空行、重复 bullet。

*Relevance: medium*
*Context: 给 ~/.agents/skills 加结构检查*
*Tags: skills tooling markdown lint*

---
*Observed: 2026-11-16T18:34:15.152Z*
