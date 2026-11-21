# 窄 pane / 矮 pane 下的面板与详情

Herdr 分格之后，`/tasks` 的详情页"看不到信息"。这是两个独立缺陷叠在一起，不是一个宽度问题。

## 现象与根因

- **面板完全不知道高度**：`DETAIL_OUTPUT_LINES` 与 `LIST_VISIBLE_ROWS` 都是写死的 12，`render(width)` 只拿得到宽度。overlay 的 `maxHeight: "80%"`（`src/ui/tasks-command.ts`）在矮 pane 上比内容短，pi 的 `compositeOverlays` 用 `overlayLines.slice(0, maxHeight)` 自顶向下裁剪，于是最先消失的正好是底部的输出尾巴、位置行和键提示。
- **标签列固定 12 列**：`field()` 的值空间是 `renderWidth - 2 - LABEL_WIDTH - 2`，27 列的 pane 里只剩 11 列，`Output`/`CWD`/`Command` 一律变成 `C:\Users\1…`。
- **数字放在行尾**：chain 步骤行固定 36 列 padding，fire 行与 iteration 行是单行右截，窄的时候 `exit 1` 和耗时先被吃掉。

## 决策

- **D1 面板自己算高度预算**：`panelHeightBudget(rows)` 复刻 pi overlay 的算式（`min(floor(rows × PANEL_HEIGHT_SHARE), rows − margin × 2)`），`tasks-command` 用同一组常量生成 `maxHeight`，两边不会漂。`render()` 每次刷新预算，pane 一改尺寸下一次绘制就按新预算走。
- **D2 按预算分配，而不是画完再被裁**：列表行数、详情字段数、输出窗口行数都由预算算出来。溢出发生在面板内部，读者能看到"还有东西"，而不是底部整块被终端切掉。
- **D3 字段与窗口按同一份预算分配**：`detailRows(height, below)` 把一页可用的行（`height − FRAME_ROWS − 2 条框线 − 窗口下方行数`）分成字段行与窗口行两块。窗口先拿到 `DETAIL_MIN_OUTPUT_LINES`，最多长到 `DETAIL_OUTPUT_LINES`；字段拿剩下的、上限是 `DETAIL_FIELD_RESERVE`，放不下就按整块丢字段，并以 `… N more fields — a taller pane shows them` 收尾。矮 pane 上先让位的是字段，不是输出尾巴。
- **D4 宽度分两档，长值折行**：≥ `DETAIL_WIDE_MIN_WIDTH` 时标签列 `LABEL_WIDTH` 内联、仍超宽才截断；更窄时标签独占一行、值折行缩进 2 列。`Command` / `CWD` / `Output` / `Prompt` / `Error` 这类长值统一走 `block()`，一律 `wrapTextWithAnsi` 折行，不再出现 `C:\Users\1…`。
- **D5 子行状态前置**：chain 步骤行是 `标记 + 状态 + 名字 + · exit/耗时`，fire 行与 iteration 行的名字在状态前、数字在名字后，窄的时候被截的是名字尾巴，`exit 1` 和耗时优先留下。
## 代价

- 矮 pane 上详情会隐藏靠后的字段（Exit code / Started / PID / Size / CWD …），加宽或放大 pane 才会回来；`… N more fields — a taller pane shows them` 说明这件事，不静默。
- 输出窗口在 14 行的 pane 上只剩 2 行、20 行的 pane 上 3 行，读更多要靠 ↑/↓。
- 折行让一页的行数变多，短 pane 上更依赖 D3 的分配。

## 验证

- 单测直接驱动这两种 pane：27×14 的帧行数不超过 14、每行不超过 27 列，且 `Output tail:` 与最新几行输出仍在页面上；20 行的 pane 上字段被裁时给出省略提示。`detailRows` 的分配与 `block()` 的折行另有只测函数的用例（不出现 `…`、每行都装得下）。
- 现有 `npm run verify` 三关照旧。

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/ui/panel/model.ts` | 高度与宽度分档常量、`panelHeightBudget`、`listRowsFor`、`PanelTerminal` |
| `src/ui/panel/view.ts` | `PanelView.renderHeight` |
| `src/ui/panel/tasks-panel.ts` | 每帧从 `tui.terminal.rows` 重算预算，滚动按预算钳位 |
| `src/ui/panel/list.ts` | 列表行数按预算收窄，分页行自己占一行 |
| `src/ui/panel/detail.ts` | `detailRows` 分配、`fitFields` 裁字段、`field`/`block` 折行、输出与 calls 窗口 |
| `src/ui/panel/input.ts` | 翻页步长取 `listRowsFor` / 窗口行数 |
| `src/ui/panel/format.ts` | `callsHeading`/`callTopFor` 报真实画出的区间 |
| `src/ui/tasks-command.ts` | overlay 的 `maxHeight` 与 `margin` 由同一组常量生成 |
