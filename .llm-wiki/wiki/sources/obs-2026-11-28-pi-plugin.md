---
type: source
title: "Observation: pi-plugin 六相链补入发版、四层配置与设置页的实测规则"
tags:
  - skill
  - pi-plugin-chain
  - release
  - oidc
  - configuration
  - skills
status: observation
created: 2026-11-28
updated: 2026-11-28
slug: obs-2026-11-28-pi-plugin
relevance: high
observed_at: 2026-11-28T14:51:09.207Z
source_context: pi-pretty-task v1.5.1 发版后的 $retro-full，用户随后调用 $skill-creator
---

# ⭐ Observation: pi-plugin 六相链补入发版、四层配置与设置页的实测规则

用 skill-creator 改进了 `~/.agents/skills` 下的 pi-plugin 六相链（未新增技能——发布流程属于第 6 相，另开一个会碎片化）：

- `pi-plugin-verify/SKILL.md` `### Release`：4 条 → 7 条。新增：版本号单独提交且按文件名 stage（`git add -A` 会吞掉 bump，tag 指向的提交 package.json 还是旧号，工作流 tag 校验门失败）；OIDC 发布三要素（`id-token: write`、不传 `registry-url`、npm ≥ 11.5.1、npm 侧 trusted publisher 的 owner/repo/workflow 文件名逐字匹配）；建 tag 与 Release 的两种合法顺序（`--target main` 由 GitHub 建 tag，或先推 annotated tag 再 `--verify-tag`，不能混）；publish run 用后台任务轮询而非前台 sleep 循环，并以 registry 200/`npm view`/`dist-tags` 为准。新增 `reference/release.md`（122 行）：OIDC 原理、`setup-node` 空 token 陷阱、OIDC 日志只在 `~/.npm/_logs`、发布序列、工作流应有的四道校验、发布后复核清单。
- `pi-plugin-scaffold/SKILL.md:89`：删掉过时的 `needs secrets.NPM_TOKEN`，改为指向第 6 相的 OIDC 决定。
- `pi-plugin-tools/SKILL.md` `### Configuration`：4 条 → 8 条，`reference/runtime-values.md` `## Configuration keys` 同步。新增四层模型（env > project `.pi/<plugin>.json` > agent `$PI_CODING_AGENT_DIR/<plugin>.json` > default，标量独立解析）、来源映射（env/project/agent/default）、成对键的同层配对与整对跨层覆盖、live 与 needs-`/reload` 标记、原子写回且保留同文件其他段、文件出现后冻结环境变量键。
- `pi-plugin-ui/SKILL.md` `### Width, not truncation` 加 1 条，`reference/panel.md` 新增 `## A settings page`（5 条）：显示来源、标注 live/reload、测试用真实宽度渲染（放大宽度让断言通过 = 把截断 bug 放过）、编辑走 loader 同一套校验、写入目标显式可切换。

验证：`validate-chain.py --yaml-only` → All front matter OK；`validate-chain.py pi-plugin` → OK no issues；6 个 SKILL.md 均 `Chain version: 1`；SKILL.md 都 < 500 行（最长 138）。4 个改过的文件都已重读。未跑 skill-creator 对照评估（用户选择不跑真模型调用）。来源：pi-pretty-task ADR-0023、ADR-0029、docs/releasing.md，以及本会话 v1.5.0/v1.5.1 两次发版的实测。

*Relevance: high*
*Context: pi-pretty-task v1.5.1 发版后的 $retro-full，用户随后调用 $skill-creator*
*Tags: skill pi-plugin-chain release oidc configuration skills*

---
*Observed: 2026-11-28T14:51:09.207Z*
