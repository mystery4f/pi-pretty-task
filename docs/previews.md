# README 截图

README 里的四张图不是手工画的，是脚本驱动**仓库里真实的面板组件**渲染出来的：改 `src/ui/panel/` 之后重跑一次，图跟着变，不会和代码漂开。

## 重新生成

```bash
npm run preview      # = npm run build && node scripts/preview/preview.mjs
```

产物直接写进 `docs/`：

| 文件 | 内容 |
|---|---|
| `docs/preview.png` | 进程列表，九条记录、四种状态，dev server 那一行带 `+4.1 KiB ↑` 的生长标记 |
| `docs/preview-tail.png` | 打开一个进程：`npm run dev` 在跑，下面是每秒刷新的输出尾巴 |
| `docs/preview-iteration.png` | 打开一次 loop fire：那一轮唤醒调用的十二个 tool call |
| `docs/preview.gif` | 九帧动画：三个 tab 走一遍，再搜一次 dev server |

需要本机有 Chrome 或 Edge，脚本按常见路径找（Windows 上是 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`），也可以用 `PREVIEW_BROWSER=/path/to/browser` 指定。没有 `ffmpeg` 也行：GIF 由纯 JS 的 `gifenc` 编码。

## 管线

在 `scripts/preview/` 里，四步：

- `render.mjs` — 用脚本按键驱动 `TasksPanel`，每按一次键 `await panel.settle()` 后 `render(106)` 抓一帧。面板从 `dist/` 导入，所以必须先 build。
- `fixtures.mjs` — 固定的场景：九个进程、三个 loop、一个 chain、若干输出尾巴。时间基准是常量 `CLOCK`（2026-11-21 09:12 UTC），面板按本机时区渲染，所以图上永远是同一批时间戳。
- `page.mjs` — ANSI 转 HTML span，套一个圆角深色终端窗口（标题栏三个圆点 + macOS 风格渐变背景）。字体优先 `Cascadia Mono`，关掉连字（否则 `--` 会被渲染成一根长横线）。
- `shoot.mjs` — `playwright-core` 起本机浏览器截图；`pngjs` 解码 + `gifenc` 编码，一帧一秒、末帧停 2.6 秒。

配色在 `theme.mjs`：24-bit ANSI，换一个色值整份图就换主题。脚本还会断言面板每行不超过 106 列、给纯文本着色后宽度仍是 1，颜色一旦把布局挤歪会直接报错。

## 加一帧或换场景

改哪一页就改 `render.mjs` 里对应函数的按键序列，键名和面板一致（`2`/`3` 切 tab、`f` 循环 filter、`/` 搜索、`\r` 打开、`\u001b[D` 返回、`\u001bq` 退出搜索）。

## 踩过的坑

- 面板会记住上次打开的 tab（`rememberedTab` 是模块级变量），所以每个渲染函数开头都调 `rememberPanelTab("processes")`，否则图片内容取决于上一次跑过谁。
- 搜索状态下 `Enter` 不打开详情，`handleSearchInput` 只处理输入和退格；要先 `alt+q` 退出搜索（查询保留）。
- 搜索会连 prompt 正文一起匹配，输入 `web` 会命中 `hourly-review` 的 prompt（"…review the commits… broken." 里的 w-e-b）。要点名某一行，用 `↓` 而不是搜索。
- Windows 上 `docs/preview.gif` 被别的程序打开着（看图软件、浏览器标签）时写不进去，脚本会报 `EBUSY` 并把新图留在 `.tmp/preview/preview.gif`：关掉那个程序再跑一次。
