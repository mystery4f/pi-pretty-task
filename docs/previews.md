# README 截图

README 里的图不是手工画的，是脚本驱动**仓库里真实的面板组件**渲染出来的：改 `src/ui/panel/` 之后重跑一次，图跟着变，不会和代码漂开。

## 重新生成

```bash
npm run preview                              # = npm run build && node scripts/preview/preview.mjs
npm run preview -- --only cmd-loop           # 只重写这一张，其余文件不碰
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
| `docs/preview.gif` | 动画 16 帧、一轮 28.6 s，顺序与时长只在 `scripts/preview/storyboard.mjs` 的 `TOUR` 里：`session:prompt`、`session:running`、`session:detach`、`session:card`、`story:start`、`story:open the log`、`story:follow`、`story:back to the list`、`story:finished`、`story:filter running`、`story:filter failed`、`story:search`、`story:keep the query`、`cards:finished`、`status:line`、`result:blocked`；窗口标题栏右侧那排按键就是到这一帧为止按过的键（`TOUR` 的 `key` 逐帧累积，最后一枚高亮），窗口下方三行说明只写帧里看不见的键 | 一个人的一次操作：在普通会话里敲命令、`ctrl+shift+b` 把它放走、回执与卡片落下，再用 `Shift↓`（打不动键时用 `/tasks`）读同一个任务——列表、详情、跟随、筛选、搜索，加上结束通知、状态栏与 `wait: true` 的返回 |

README 引用的每一张都必须在上表里、也必须在磁盘上：`test/unit/readme-coverage.test.ts` 会对两边做集合比较，漏一边就红。

需要本机有 Chrome 或 Edge，脚本按常见路径找（Windows 上是 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`），也可以用 `PREVIEW_BROWSER=/path/to/browser` 指定。没有 `ffmpeg` 也行：GIF 由纯 JS 的 `gifenc` 编码。

## 管线

在 `scripts/preview/` 里，十五个文件（`storyboard.d.mts` 只是给 TypeScript 的类型声明，不是脚本；`record/session.json` 是采证快照，不是代码）：

- `render.mjs` — 用脚本按键驱动 `TasksPanel`，每按一次键 `await panel.settle()` 后 `render(106)` 抓一帧。面板从 `dist/` 导入，所以必须先 build。列表、进程页、loop 页、chain 页、命令 loop 页、筛到 `failed`、搜一次、改道那一帧都从这里出。
- `fixtures.mjs` — 固定的场景：九个进程、三个 loop、一个 chain、若干输出尾巴。时间基准是常量 `CLOCK`（2026-11-21 09:12 UTC），面板按本机时区渲染，所以图上永远是同一批时间戳。
- `card.mjs` — 改道卡不是面板页，按键驱动碰不到它：这里把 `{id, trigger, afterSeconds}` 直接交给 `dist/ui/notification.js` 的 `renderTaskDetached`，两个触发器各画一张，同样的宽度断言。
- `transcript.mjs` — 另外两类不是面板：三张消息卡交给 `renderTaskFinished` / `renderLoopSignal` / `renderLoopWake`，外面套上 pi 给自定义消息加的那层 `Box(1, 1, theme.bg("customMessageBg"))`；状态行直接调 `statusLineText(view.task)`，不复制一份文案。任何一行超宽就抛错，不会静默截断。
- `capture-record.mjs` — 采证：`node scripts/preview/capture-record.mjs [--session <前缀>] [--tasks <tasks.json>]` 把本机真实会话的 `.pi/tasks/<sessionId>/tasks.json` 原样抄进 `record/session.json`，连同每个任务的输出尾巴（每文件最多 200 行 / 32 KB）。不改写路径、不重命名，图里的 id 因此能在原文件里查到。
- `record.mjs` — 动画的素材源：读那份快照，给出 `TASKS`、这条故事的任务 `STORY`（`bg-v5y1b`）、`logLines(id)`，以及一个 `PanelSource`——列表在改道前不含故事任务，输出尾巴在任务结束前只给前 12 行。动画只读它，静图仍读 `fixtures.mjs`，所以静图像素不变。快照按原样保留（id、时间、路径、输出都是那场会话的），但**只有名字和命令是 ASCII 的记录才进画面**：这张图给英文读者看，编造的名字不行、中文的快照名也不该是图里唯一的汉字。过滤在这一层做，不动 `session.json` 一个字节。
- `session.mjs` — 动画的开头四帧：普通会话里的命令、跑到一半的输出、`ctrl+shift+b` 落下的回执、回执之后那张卡。命令原文、输出、回执与卡片内容都来自快照，编辑器是页面里真画的 DOM。
- `page.mjs` — ANSI 转 HTML span，套一个圆角深色终端窗口（标题栏三个圆点 + macOS 风格渐变背景）。字体优先 `Cascadia Mono`，关掉连字（否则 `--` 会被渲染成一根长横线）。
- `shoot.mjs` — `playwright-core` 起本机浏览器截图；`pngjs` 解码 + `gifenc` 编码。每帧停多久由 `TOUR` 的 `ms` 经 `writeGif` 的 `delays` 给，脚本里不再写死 1.1 s / 末帧 2.6 s。
- `dump.mjs` — 不起浏览器，把十张静图与 `TOUR` 的每一帧按纯文本打出来（`npm run preview:dump`，`--only <label>` 只看那一帧）。动画帧的顺序取自 `TOUR`，这里只做筛选，不另存一份顺序。改一帧之后最快的检查方式。GIF 的每帧 PNG 默认删掉，`PREVIEW_FRAMES=1 npm run preview` 保留到 `.tmp/preview/`。
- `theme.mjs` — 24-bit ANSI 配色，换一个色值整份图就换主题；`customMessageBg` 是从 pi 的 `violet` 抄来的面板底色，消息卡靠它成框。脚本还会断言面板每行不超过 106 列、卡片每行不超过 96 列，给纯文本着色后宽度仍是 1，颜色一旦把布局挤歪会直接报错。
- `storyboard.mjs` — 动画的唯一帧表：`TOUR` 逐条写 `label`（渲染器已经抓到的帧名）、`ms`（停多久）、`key`（这一帧答的是哪个键，`preview.mjs` 会拿渲染器给的 badge 逐帧核对）、`surface`（它证明的那一面，取自 `SURFACES`）、`topic`（这一帧讲什么）、`mark`（README alt 里必须出现的那句话）。窗口下方三行说明在 `LEGEND`，上限在 `LIMITS`。`preview.mjs` 按它取帧与逐帧延时，`dump.mjs` 只按它筛选，测试读它做断言——顺序不许有第二份。
- `gif-check.mjs` — 不用浏览器，直接从 `docs/preview.gif` 的字节里读帧数、画布、逐帧延时与每帧数据量，要求帧数等于 `TOUR` 条数、画布高等于 `145 + 19 × 最高一页的文本行 + 19 × legend 行`（`145` 是标题栏、内边距与边框合起来的高度，实测得来；legend 一行就是一个文本行高）、逐帧延时逐项等于 `TOUR` 的 `ms`，并守住 36 s / 1024 KB 两个上限；`node scripts/preview/gif-check.mjs [gif 路径]` 红就说明图和帧表已经漂开，给个路径就能拿同样的尺子量候选编码器的产物。
- 编码器没换，因为量过之后不划算：同一版 20 帧，`gifenc`（192 色）出 794.8 KB；`gifsicle -O3` 是 687.8 KB，`--lossy=80` 是 539.6 KB，但两者都会把逻辑画布按帧并集重写成 1054 px 高，直接违反上面那条画布高断言（读者看到的不变，我们的可预测性没了）；`gifenc` 降到 128 色是 719.9 KB（−8%），代价是深色底的渐变开始起带。结论：体积是帧数与像素数的函数，不是编码器的锅，要变小只能砍帧或缩尺寸。

## 加一帧或换场景

改哪一页就改 `render.mjs` 里对应函数的按键序列，键名和面板一致（`2`/`3` 切 tab、`f` 循环 filter、`/` 搜索、`\r` 打开、`\u001b[D` 返回、`\u001bq` 退出搜索）。

改道那一帧不是面板按键：`ctrl+shift+b` 属于 pi，面板看到的只是"前台命令没了、列表里多了一条"。所以 `renderDetach()` 用 `drive()` 的 `{ name, effect }` 步骤——`effect` 里调 `fixtures.mjs` 的 `detachFront()` 再 `await panel.refresh()`，键名只是帧标签。

新增一张图之后，除了 `preview.mjs` 的文件清单，还要补 `package.json` 的 `files` 和上表：README 的检查只认表格里存在的图，表格漏了一行，图就是没有人认领的文件。动画要不要跟着变，在 `TOUR` 里决定（见下一节）。

## 新功能上线之后

给面板、卡片或状态行加了一页用户看得见的东西之后，二选一，别让它只活在截图之外：

- 补一帧进 `TOUR`，并在那一项写清它证明 README 哪一句（`mark`）。README 第 12 行的 alt 与上表那一行都要跟着改——`test/unit/preview-tour.test.ts` 按顺序比对这三处，`node scripts/preview/gif-check.mjs` 比对字节。
- 不补，并在这一节写下不补的理由：这一页只是既有页的细节（命令 loop 的 fires 已经在上表的 `preview-cmdloop.png` 里），或者它属于会话记录而不是面板（改道卡在 `preview-detach.png`）。

一帧讲不清一件事就别放，也不要为了"功能都露脸"凑帧。一轮总时长上限 36 s、总体积上限 1024 KB（`TOUR` 里的 `LIMITS`）；超了先砍过渡帧，砍了哪帧在提交信息里写明。

### 为什么没有 loop 和 chain 的帧

这一版动画讲的是一个人的一次操作，素材必须来自本机真实记录：命令、输出、id、回执、卡片都逐字取自那份快照。本机三个会话的 store 里全是 process 记录，没有一条 loop 或 chain，所以 `panel:loops`、`panel:chain-detail` 这类页没有真材料可引；`notice:signal` 与 `notice:wake` 两张卡也一样——它们引的是 `lc-`/`lp-` 编号，本机没有一条这样的记录，编一个等于把假 id 印进图里。

按上面第二条，这就是不补的理由：loop 的 fires、chain 的步骤在上表的 `preview-cmdloop.png`、`preview-chain.png` 里仍然可见，signal 与 wake 两张卡在 `preview-cards.png` 里也有，只是不进动画。将来录一场真的带 loop 的会话（`node scripts/preview/capture-record.mjs --session <那次会话>`），`SURFACES` 与 `TOUR` 补上这几帧即可，那时才加——`test/unit/preview-tour.test.ts` 会要求这几页的名字一直写在这里，忘了写就红。

## 踩过的坑

- 面板会记住上次打开的 tab（`rememberedTab` 是模块级变量），所以每个渲染函数开头都调 `rememberPanelTab("processes")`，否则图片内容取决于上一次跑过谁。
- 搜索状态下 `Enter` 不打开详情，`handleSearchInput` 只处理输入和退格；要先 `alt+q` 退出搜索（查询保留）。
- 搜索会连 prompt 正文一起匹配，输入 `web` 会命中 `hourly-review` 的 prompt（"…review the commits… broken." 里的 w-e-b）。要点名某一行，用 `↓` 而不是搜索。
- 按键序列从面板自己的列表推：`render.mjs` 的 `filterSteps(choice)` 按 `PANEL_FILTERS` 与 `DEFAULT_PANEL_FILTER` 算要按几次 `f`，并让每帧以落到的 filter 命名（`--only failed` 就是靠这个前缀选帧）。默认改成 `all` 之后 `renderSearch()` 一次都不用按，`renderFailed()` 仍是两次（先 `running` 再 `failed`）——数字来自推导，不写死。
- Windows 上 `docs/preview.gif` 被别的程序打开着（看图软件、浏览器标签）时写不进去，脚本会报 `EBUSY` 并把新图留在 `.tmp/preview/preview.gif`：关掉那个程序再跑一次。
