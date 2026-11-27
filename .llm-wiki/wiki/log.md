# Wiki Update Log

## 2026-11-27

- **retro**: {"category":"architecture","slug":"filtering-guards-silently-shrink-their-own-scope","title":"靠正则筛项的守卫会悄悄缩小自己的检查范围"}
- **retro**: {"category":"bugfix","slug":"css-inside-a-js-template-literal-has-no-syntax-check","title":"模板字面量里的 CSS 没有语法检查，坏了只出一个丑图"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-27-footer-handleinput","title":"footer 打印字形、handleInput 收的是终端序列：按键测试必须翻译"}
- **retro**: {"category":"docs","slug":"adr-dated-status-and-index-guard","title":"An undated ADR cannot be checked for staleness"}
- **retro**: {"category":"debugging","slug":"session-record-not-source-is-the-evidence","title":"What the model saw is in the session record, not the source"}
- **retro**: {"category":"tooling","slug":"preview-rerun-shifts-untouched-images","title":"A full preview re-render rewrites images nothing changed"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-27-","title":"改道卡必须是会话条目而非自定义消息"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-27-pi-pretty-task","title":"pi-pretty-task：改道通知带触发器，静默分支以负断言固化"}

## 2026-11-26

- **retro**: {"category":"architecture","slug":"pi-matt-implement-flow-script-gotchas","title":"pi-matt-implement-flow 脚本层的七个坑（自己重写时的清单）"}

## 2026-11-25

- **retro**: {"category":"tooling","slug":"subagent-structured-verdict-path","title":"Subagent structured verdicts live in structured-output/output.json, not the artifact md"}
- **retro**: {"category":"bugfix","slug":"git-cat-file-full-sha-flake-multipack","title":"git cat-file -e rejects a valid full SHA in a multi-pack repo"}
- **retro**: {"category":"devops","slug":"matt-implement-gate-needs-node-modules","title":"A typed workflow gate returns null when its worktree lacks node_modules"}
- **retro**: {"category":"devops","slug":"matt-implement-sync-ticket-comments","title":"matt-implement sync reads merge SHA from a ticket's Comments section"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-25-pi-auto-retry","title":"pi 扩展拿不到 auto_retry 事件，重试进度只能派生"}

## 2026-11-24

- **retro**: {"category":"ci","slug":"npm-trusted-publishing-oidc-not-token","title":"npm 发布改用 trusted publishing（OIDC），放弃绕 2FA 的长期 token"}
- **retro**: {"category":"testing","slug":"pi-pretty-task-full-suite-parallel-flake","title":"全量 integration 套件在 8 worker 下间歇超时，串行才是确定性证据"}
- **retro**: {"category":"pi-plugin","slug":"pi-extension-stale-instance-unhandled-rejection","title":"pi 扩展实例失效后的 sendMessage 抛出会杀死进程"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-24-pi-lens-test-tsconfig","title":"pi-lens 告警清零：抑制语法与 test tsconfig 项目"}

## 2026-11-22

- **observe**: {"relevance":"medium","slug":"obs-2026-11-22-gif","title":"GIF 里\"看不见\"的新功能属于节奏问题"}

## 2026-11-21

- **retro**: {"category":"design","slug":"pi-pretty-task-preview-from-the-built-panel","title":"README 截图从 dist 里的真面板渲染，三处状态陷阱"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-21-","title":"订阅模式不做「一行一触发」，订阅也不新开页签"}

## 2026-11-17

- **observe**: {"relevance":"medium","slug":"obs-2026-11-17-pi-plugin-skills-reference","title":"pi-plugin skills 增加 reference/ 深度层"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-17-readme-key-list-is-test-guarded-against-panel-drift","title":"README key list is test-guarded against panel drift"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-17-pi-dev-gallery-index-misses-pi-pretty-task-publish-event","title":"pi.dev gallery index misses pi-pretty-task publish event"}

## 2026-11-16

- **observe**: {"relevance":"medium","slug":"obs-2026-11-16-docs-reviews","title":"评审报告进 docs/reviews 并登记索引"}
- **observe**: {"relevance":"medium","slug":"obs-2026-11-16-skills-lint-skills-mjs","title":"skills 结构检查脚本 lint-skills.mjs"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-16-biome-noimportcycles","title":"Biome noImportCycles 代替环依赖检查脚本"}
- **retro**: {"category":"architecture","slug":"pi-pretty-task-one-projection-and-formula","title":"一个形状一处投影，一个式子一处实现"}
- **retro**: {"category":"architecture","slug":"pi-pretty-task-side-index-to-field","title":"并行索引应当塌回记录上的一个字段"}
- **retro**: {"category":"architecture","slug":"pi-pretty-task-panel-intents-and-view","title":"面板：键盘说意图，渲染方拿只读视图"}
- **retro**: {"category":"architecture","slug":"pi-pretty-task-session-hub-required","title":"会话 hub 必须由入口注入，默认值会分裂写入权"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-16-7","title":"面板项目 7 项架构重构完成"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-16-pi-plugin-six-phase-skill-chain-created","title":"pi-plugin six-phase skill chain created"}
- **retro**: {"category":"bugfix","slug":"windows-ci-slow-fsync-record-write","title":"Windows CI: fsync per state write outran the record wait"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-16-release-design-for-pi-pretty-task-1-0-0","title":"Release design for pi-pretty-task 1.0.0"}

## 2026-11-15

- **ensure\_page**: {"page_type":"synthesis","path":"syntheses/pi-pretty-task-交接v02-收尾状态","title":"pi-pretty-task 交接：v0.2 收尾状态"}
- **retro**: {"category":"devops","slug":"delete-remote-branch-via-gh-api","title":"删远端分支走 gh API，git push --delete 会被拦"}
- **retro**: {"category":"devops","slug":"pi-git-install-omits-dev-deps-so-ship-ts-entry","title":"pi 的 git 安装不带 devDeps，入口要写 .ts 而不是靠 prepare 构建"}
- **retro**: {"category":"bugfix","slug":"await-state-not-bytes-in-process-tests","title":"进程类测试要等状态，不要等字节"}
- **retro**: {"category":"devops","slug":"slow-suite-timings-not-workers","title":"慢测试先治写死的时长，再谈并行度"}
- **retro**: {"category":"bugfix","slug":"windows-taskkill-t-needs-force-for-console-node","title":"Windows 上 taskkill /T 不加 /F 停不下控制台 node"}

## 2026-11-14

- **observe**: {"relevance":"medium","slug":"obs-2026-11-14-loop-wake-backlog-storms-after-a-long-turn","title":"Loop wake backlog storms after a long turn"}
- **observe**: {"relevance":"high","slug":"obs-2026-11-14-kill-path-skipped-persist-and-notice-in-pi-pretty-task","title":"Kill path skipped persist and notice in pi-pretty-task"}

## 2026-11-13

- **ensure\_page**: {"page_type":"synthesis","path":"syntheses/pi-loop-源码调研","title":"pi-loop 源码调研"}
- **ensure\_page**: {"page_type":"synthesis","path":"syntheses/pi-background-tasks-源码调研","title":"pi-background-tasks 源码调研"}
- **ensure\_page**: {"page_type":"synthesis","path":"syntheses/pi-pretty-task-文档索引","title":"pi-pretty-task 文档索引"}
- **bootstrap**: {"mode":"personal","topic":"pi-pretty-task 插件开发（pi 扩展：后台任务 + 定时唤醒 LLM）"}
