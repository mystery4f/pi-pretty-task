# README 截图

README 里的图不是手工画的，是脚本驱动**仓库里真实的面板组件**渲染出来的：改 `src/ui/panel/` 之后重跑一次，图跟着变，不会和代码漂开。

## 重新生成

```bash
npm run preview                              # = npm run build && node scripts/preview/preview.mjs
npm run preview:dump --only <label>          # 只打文字帧，不起浏览器
```

产物直接写进 `docs/`，一张图对应 README 里的一段话：

| 文件 | 内容 | 这张证明什么 |
|---|---|---|
| `docs/preview.png` | 进程列表，九条记录、四种状态，dev server 那一行带 `+4.1 KiB ↑` 的生长标记 | 三类记录同屏，跑着的行会自己长 |
| `docs/preview-tail.png` | 打开一个进程：`npm run dev` 在跑，下面是每秒刷新的输出尾巴 | 输出落在文件里，一眼看得到最新几行 |
| `docs/preview-iteration.png` | 打开一次 loop fire：那一轮唤醒调用的十二个 tool call | 一次唤醒做了什么，有一个可查的清单 |
| `docs/preview-chain.png` | 打开一个 chain：三步的顺序、`›` 标着的当前步、每一步会落成的 id | 排队是可见的，失败之后后面的步骤是 `skipped` |
| `docs/preview-cmdloop.png` | 打开一个命令 loop：每次 fire 的结局、exit code、耗时、大小，新的在上 | 失败有 exit code 可查，不做成一串同色的行 |
| `docs/preview-failed.png` | 列表按 `f` 筛到 `failed`：两行都带 `exit 1`，表头仍数着被筛掉多少 | 筛选不会把失败的原因一起筛掉 |
| `docs/preview-search.png` | 搜索框输入 `run`，命中名字、命令与 loop 的 prompt | 一次查询能同时搜三种记录 |
| `docs/preview-detach.png` | 改道卡本身：同一张卡的两个触发器（`ctrl+shift+b` 与计时器），带面板底色。卡片是会话条目，面板截图里看不到，只有这一张图能看 | 改道留得下，而且说清是谁结束的等待 |
| `docs/preview-cards.png` | 三张消息卡片：失败任务的尾巴、signalled 命令 loop 的报告、一次唤醒送进来的 prompt | 不进 `/tasks` 也知道发生过什么，卡片和模型读到的是同一份事实 |
| `docs/preview-status.png` | 面板关着时编辑器上方那一行：跑着 / 有信号 / 已结束 / 回来的入口 | 面板收起之后，摘要还在 |
| `docs/preview.gif` | 动画：先按一次 `ctrl+shift+b` 把前台命令改道（提示行消失、命令进列表），再三个 tab 走一遍、搜一次 dev server | 一次真实的改道，加上三个 tab 和一次搜索 |

README 引用的每一张都必须在上表里、也必须在磁盘上：`test/unit/readme-coverage.test.ts` 会对两边做集合比较，漏一边就红。

需要本机有 Chrome 或 Edge，脚本按常见路径找（Windows 上是 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`），也可以用 `PREVIEW_BROWSER=/path/to/browser` 指定。没有 `ffmpeg` 也行：GIF 由纯 JS 的 `gifenc` 编码。

## 管线

在 `scripts/preview/` 里，七个文件：

- `render.mjs` — 用脚本按键驱动 `TasksPanel`，每按一次键 `await panel.settle()` 后 `render(106)` 抓一帧。面板从 `dist/` 导入，所以必须先 build。列表、进程页、loop 页、chain 页、命令 loop 页、筛到 `failed`、搜一次、改道那一帧都从这里出。
- `fixtures.mjs` — 固定的场景：九个进程、三个 loop、一个 chain、若干输出尾巴。时间基准是常量 `CLOCK`（2026-11-21 09:12 UTC），面板按本机时区渲染，所以图上永远是同一批时间戳。
- `card.mjs` — 改道卡不是面板页，按键驱动碰不到它：这里把 `{id, trigger, afterSeconds}` 直接交给 `dist/ui/notification.js` 的 `renderTaskDetached`，两个触发器各画一张，同样的宽度断言。
- `transcript.mjs` — 另外两类不是面板：三张消息卡交给 `renderTaskFinished` / `renderLoopSignal` / `renderLoopWake`，外面套上 pi 给自定义消息加的那层 `Box(1, 1, theme.bg("customMessageBg"))`；状态行直接调 `statusLineText(view.task)`，不复制一份文案。任何一行超宽就抛错，不会静默截断。
- `page.mjs` — ANSI 转 HTML span，套一个圆角深色终端窗口（标题栏三个圆点 + macOS 风格渐变背景）。字体优先 `Cascadia Mono`，关掉连字（否则 `--` 会被渲染成一根长横线）。
- `shoot.mjs` — `playwright-core` 起本机浏览器截图；`pngjs` 解码 + `gifenc` 编码，一帧一秒、末帧停 2.6 秒。
- `dump.mjs` — 不起浏览器，把同样的十帧与动画按纯文本打出来（`npm run preview:dump`，`--only <label>` 只看那一帧）。改一帧之后最快的检查方式。GIF 的每帧 PNG 默认删掉，`PREVIEW_FRAMES=1 npm run preview` 保留到 `.tmp/preview/`。
- `theme.mjs` — 24-bit ANSI 配色，换一个色值整份图就换主题；`customMessageBg` 是从 pi 的 `violet` 抄来的面板底色，消息卡靠它成框。脚本还会断言面板每行不超过 106 列、卡片每行不超过 96 列，给纯文本着色后宽度仍是 1，颜色一旦把布局挤歪会直接报错。

## 加一帧或换场景

改哪一页就改 `render.mjs` 里对应函数的按键序列，键名和面板一致（`2`/`3` 切 tab、`f` 循环 filter、`/` 搜索、`\r` 打开、`\u001b[D` 返回、`\u001bq` 退出搜索）。

改道那一帧不是面板按键：`ctrl+shift+b` 属于 pi，面板看到的只是"前台命令没了、列表里多了一条"。所以 `renderDetach()` 用 `drive()` 的 `{ name, effect }` 步骤——`effect` 里调 `fixtures.mjs` 的 `detachFront()` 再 `await panel.refresh()`，键名只是帧标签。

新增一张图之后，除了 `preview.mjs` 的文件清单，还要补 `package.json` 的 `files` 和上表：README 的检查只认表格里存在的图，表格漏了一行，图就是没有人认领的文件。

## 踩过的坑

- 面板会记住上次打开的 tab（`rememberedTab` 是模块级变量），所以每个渲染函数开头都调 `rememberPanelTab("processes")`，否则图片内容取决于上一次跑过谁。
- 搜索状态下 `Enter` 不打开详情，`handleSearchInput` 只处理输入和退格；要先 `alt+q` 退出搜索（查询保留）。
- 搜索会连 prompt 正文一起匹配，输入 `web` 会命中 `hourly-review` 的 prompt（"…review the commits… broken." 里的 w-e-b）。要点名某一行，用 `↓` 而不是搜索。
- 按键序列依赖默认 filter：`DEFAULT_PANEL_FILTER` 是 `running`，要 `all` 得按四次 `f`，所以脚本里用 `FILTERS_TO_ALL` 算而不是写死数字。
- Windows 上 `docs/preview.gif` 被别的程序打开着（看图软件、浏览器标签）时写不进去，脚本会报 `EBUSY` 并把新图留在 `.tmp/preview/preview.gif`：关掉那个程序再跑一次。
