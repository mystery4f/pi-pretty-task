---
type: synthesis
title: pi-pretty-task 交接：v0.2 收尾状态
tags: handoff, pi-pretty-task
created: 2026-11-15
updated: 2026-11-15
---

# pi-pretty-task 交接：v0.2 收尾状态

交接页，取代 `.tmp/resume.txt`。下次开工先读这一页，再读 `AGENTS.md`、`GLOSSARY.md`、`docs/scope-v1.md`。

## 仓库与代码

- `D:/work/Code/AI/pi/pi-pretty-task`，`main` = `84cf029 fix(pkg): point pi at src/index.ts so a git install needs no build`，已推送，工作树仅剩 wiki 元数据改动（`.llm-wiki/meta/*.json|l`）。
- 集成分支 `feat/v0.2-tasks` 已全部合并，`ticket/*` 分支与 `.tmp/wt/*` worktree 已清理，远端只有 `main`。
- 安装方式：`~/.pi/agent/settings.json` 第 159 行 `"git:github.com/mystery4f/pi-pretty-task"`；入口 `./src/index.ts`（pi 自己转译），所以**本机改完代码不必 build**，但 `dist/` 不再是安装物。
- 工具面：十个 `pretty_task_*`（含 `pretty_task_bg_wait`），无旧别名。
- 闸门：`npm run check` / `npm run lint` / `npm test`（427 测试，约 46s）/ `npm run build` / `npm run verify`；CI `.github/workflows/verify.yml` 跑前三项。

## 已上线能力

进程任务（run/status/logs/grep/follow/kill/wait/rerun、cwd/env、模板、完成通知、OSC 9 终端通知、输出与时长上限、通知与上限两条环境变量）、提示词 Loop（间隔 + 五段 cron、改期、暂停、跳过重叠、失败退避、失败唤醒、每次触发的迭代记录）、命令 Loop（每次触发是一条带 `parentId` 的进程任务）、链（`after:` 串步骤、`/tasks` 里的 Chains 页）、保留期清理、事件总线、面板三页（`1/2/3`、`f` 过滤默认 running、`/` 模糊搜索、`h` 历史、`R` 重跑、`o` 其他会话只读）。

## 未完成

- **issue #31**（面板里创建任务）：主动推迟，唯一未关的票。
- 与 #31 同批推迟的想法：任务链的可视化编辑、`bg_status({templates:true})`（模板查看工具，方案已提未批）、「工具面统一成 `task_*` 再留 `bg_*` 别名的票」（#38 已按用户决定**不留别名**，此条作废）。
- **已知技术债**：`src/ui/tasks-panel.ts` 两千五百行，一个文件扛三页渲染、搜索、详情、键位、取色，四次合并冲突三次落在它身上 —— 拆分规则已写进 `~/.agents/skills/coding-standards`，但拆分本身未做。
- `docs/adr/0002` 等早期 ADR 与实现已有漂移，只有「每份 ADR 在索引里有行」的测试，没有内容一致性检查。

## 本会话新增的规则与技能

- `~/.agents/skills/coding-standards/SKILL.md`：一文件一职责、300/600/1000 行三档、按职责不按行数拆分、seam 与测试规则；已接进 `coder` / `reviewer` / `final-reviewer` 三个 agent 的 frontmatter。
- `~/.agents/skills/tucao/SKILL.md`：证据优先的复盘吐槽，每条必须能指到 commit / file:line / exit code。
- 全局 `AGENTS.md`：删远端分支改走 `gh api -X DELETE`（`git push --delete` 被安全网拦）；子代理规则补「上游截断要 resume 不重写」「1 小时墙钟、每绿即提交、闸门逐条看 exit code」。
- 用户把 `CTX_REPLACE_TRIGGER_BYTES` 写进了 `~/.pi/agent/.env`（context-mode 折叠阈值，默认 4096）。

## 下次开工第一件事

读本页 → `gh issue view 31` 判断是否开工 → 若要动 UI，先拆 `src/ui/tasks-panel.ts` 再改。

相关：[[syntheses/pi-pretty-task-文档索引]]
