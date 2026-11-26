# 0019 — 面板按 pane 的尺寸规划 body

## 状态

已接受（2026-11-21）

## 背景

Herdr 分格之后 `/tasks` 的详情页"看不到信息"，实测两个 pane：27 列 × 14 行、100 列 × 40 行。三个独立原因叠在一起：

- **面板拿不到高度**。`render(width)` 只有宽度，overlay 的 `maxHeight: "80%"` 在矮 pane 上比 body 短，而 pi 的 `compositeOverlays` 用 `overlayLines.slice(0, maxHeight)` 自顶向下裁剪——最先消失的正好是页底的输出尾巴、位置行与键提示。面板自己以为画出去了，读者一行也没见到。
- **标签列固定 12 列**。`field()` 的值空间是 `renderWidth - 2 - LABEL_WIDTH - 2`，27 列的 pane 里只剩 11 列，`Command` / `CWD` / `Output` 一律变成 `C:\Users\1…`，而这一页被打开的原因通常就在被截掉的那半段路径里。
- **数字在行尾**。chain 步骤行是 36 列固定 padding、fire 行与 iteration 行单行右截，窄的时候 `exit 1` 与耗时先被吃掉，留下的是可以推测的名字。

根因是一条：面板把"终端很宽很高"当成了常量，把裁剪交给了别人。

## 决策

**面板自己算预算，先分账再画，溢出发生在面板内部。**

`panelHeightBudget(rows)` 复刻 pi overlay 的算式（`min(floor(rows × PANEL_HEIGHT_SHARE), rows − margin × 2)`），`tasks-command` 的 `maxHeight` / `margin` 由同一组常量生成，两处不会漂。`TasksPanel.render()` 每帧从 `tui.terminal.rows` 重算，pane 一改尺寸下一次绘制就按新预算走；拿不到 `terminal` 时用 `DEFAULT_RENDER_ROWS`，所以假 tui（测试、无 TTY）照样能画。

`detailRows(height, below)` 把一页可用的行（`height − FRAME_ROWS − 两条框线 − 窗口下方行数`）分成字段与窗口两块，**窗口优先**：先拿 `DETAIL_MIN_OUTPUT_LINES`，最多长到 `DETAIL_OUTPUT_LINES`；字段拿剩下的、上限 `DETAIL_FIELD_RESERVE`。矮 pane 上先让位的是字段——一页 process 详情存在的理由就是看输出。字段按整块丢，用 `… N more fields — a taller pane shows them` 明说，不静默少画。

宽度分两档：≥ `DETAIL_WIDE_MIN_WIDTH` 标签列 `LABEL_WIDTH` 内联、仍超宽才截断；更窄时标签独占一行、值缩进 2 列。`Command` / `CWD` / `Output` / `Prompt file` / `Error` 这类长值一律 `wrapTextWithAnsi` 折行，不再右截成省略号——折行让行数变多，正是上面那份预算要处理的事。

子行的状态前置：chain 步骤是 `标记 + 状态 + 名字 + · exit/耗时`，被截时留下的是能解释卡住的那两个字。列表的分页行从窗口里扣（`listWindow`），滚动钳位与渲染读同一个数，否则最后一行永远在折叠线下。

## 代价

- 矮 pane 上靠后的字段（Exit code / Started / PID / Size / CWD …）不显示，放大 pane 才回来。
- 14 行的 pane 输出窗口只剩 2 行，读更多靠 ↑/↓ 与 `r` 重跟。
- 每页多了一次折行计算，且测试要显式给 pane 尺寸（`openPanel(..., rows)`），否则断言的是 `DEFAULT_RENDER_ROWS` 那个假设值。

## 相关

- 详细推导与实测数字：[`docs/panel-narrow-detail.md`](../panel-narrow-detail.md)
- 面板三页与只列根的取舍见 [ADR-0012](0012-panel-tabs-and-roots.md)
