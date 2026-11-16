---
type: source
title: "Observation: Biome noImportCycles 代替环依赖检查脚本"
tags:
  - biome
  - lint
  - architecture
  - cycles
  - tooling
status: observation
created: 2026-11-16
updated: 2026-11-16
slug: obs-2026-11-16-biome-noimportcycles
relevance: high
observed_at: 2026-11-16T18:34:05.830Z
source_context: 评审后的收尾：给仓库加环依赖检查
---

# ⭐ Observation: Biome noImportCycles 代替环依赖检查脚本

Biome 2.6.7 自带 lint/suspicious/noImportCycles，不需要引入 madge/dependency-cruiser。在 biome.json 的 linter.rules.suspicious 里加一行 "noImportCycles": "error"，`npm run lint` / biome check 就会把环依赖报在两个文件上，CI 里已有的 lint 步骤自动覆盖。已用临时目录实测：a.ts↔b.ts 互相 import 时两个文件各报一条，并给出「which imports b.ts … which is the file we're importing from」的链路。pi-pretty-task 87 个文件干干净净。

*Relevance: high*
*Context: 评审后的收尾：给仓库加环依赖检查*
*Tags: biome lint architecture cycles tooling*

---
*Observed: 2026-11-16T18:34:05.830Z*
