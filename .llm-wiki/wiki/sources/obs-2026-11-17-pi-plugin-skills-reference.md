---
type: source
title: "Observation: pi-plugin skills 增加 reference/ 深度层"
tags:
  - pi-plugin
  - skills
  - skill-system-creator
  - reference
status: observation
created: 2026-11-17
updated: 2026-11-17
slug: obs-2026-11-17-pi-plugin-skills-reference
relevance: medium
observed_at: 2026-11-17T17:25:31.211Z
source_context: 扩充 pi-plugin-* 技能链的参考文档层
---

# 🔍 Observation: pi-plugin skills 增加 reference/ 深度层

给 `~/.agents/skills/pi-plugin-*` 六阶段链条加了 reference/ 层（2026-11-18）：SKILL.md 保留判断标准（90~138 行），深度细节与清单下沉到 `reference/<topic>.md`（52~79 行，每个 8~11 条 `- [ ]` 勾选项，无有序编号）。新增 8 个文件：pi-plugin-process/reference/{spawn,terminate,persistence}.md、pi-plugin-ui/reference/{panel,keys-and-status}.md、pi-plugin-tools/reference/{tool-surface,runtime-values}.md、pi-plugin-verify/reference/readme.md；四个 SKILL.md 在 chain map 行下方各加一行 "Reference docs:" 指针。内容全为通用模式，未引用具体项目代码（用户明确要求）。spec 与 scaffold 未加：其小节已达 28~35 行，再加 reference 属重复。校验手段：`python3 <skill-system-creator>/validate-chain.py --yaml-only --skills-dir C:/Users/10781/.agents/skills` 与 `validate-chain.py pi-plugin --skills-dir ...` → front matter OK、链无环/孤儿/断点、入口 pi-plugin-spec。注意本机无 PyYAML，脚本自动降级为正则检查；pi 的 skill 根目录是 `~/.agents/skills`，脚本默认 `~/.pi/agent/skills`，必须显式传 --skills-dir。

*Relevance: medium*
*Context: 扩充 pi-plugin-* 技能链的参考文档层*
*Tags: pi-plugin skills skill-system-creator reference*

---
*Observed: 2026-11-17T17:25:31.211Z*
