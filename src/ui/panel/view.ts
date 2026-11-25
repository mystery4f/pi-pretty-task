/**
 * What a page may read of the panel.
 *
 * The panel is one object with mutable state, and a page draws from it without
 * ever changing it. Typing the renderers against this view instead of the panel
 * says so in one place: a write through it does not compile, and `list.ts` no
 * longer has to import the file that imports it back.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CmdLoopTask, FireRecord, PromptLoopTask } from "../../tasks/base/task.js";
import type { Iteration } from "../../tasks/loop/iteration.js";
import type { PromptPreview } from "../../tasks/loop/prompt-file.js";
import type { PanelFilter, PanelMode, PanelSource, PanelTab, PanelTaskView } from "./model.js";
import type { RowMatch } from "./query.js";

export interface PanelView {
  readonly theme: Theme;
  readonly now: () => number;
  readonly source: PanelSource;
  /** Width of the frame being drawn; field values are cut against it. */
  readonly renderWidth: number;
  /**
   * Rows the pane leaves the panel, as the last render measured them. A page
   * plans its body against this, so nothing is drawn where pi's overlay would
   * cut it away.
   */
  readonly renderHeight: number;
  readonly mode: PanelMode;
  readonly tab: PanelTab;
  readonly filter: PanelFilter;
  readonly query: string;
  readonly searching: boolean;
  /** What the reader may open: the filter has already been applied. */
  readonly rows: readonly PanelTaskView[];
  /** Every row of the session, so the counts never depend on the filters. */
  readonly allRows: readonly PanelTaskView[];
  readonly otherRows: readonly PanelTaskView[];
  /** Where each shown row's query landed; empty when there is no query. */
  readonly matchScores: ReadonlyMap<PanelTaskView, RowMatch>;
  readonly selectedId: string | undefined;
  readonly listTop: number;
  readonly detailId: string | undefined;
  readonly detailLines: readonly string[];
  readonly detailTruncated: boolean;
  readonly detailError: string | undefined;
  /**
   * The open loop's prompt file, or undefined when nothing is open that has one.
   * The panel reads it through the loop's own layer before drawing, so a page
   * never joins a path or opens a file itself (ticket #48).
   */
  readonly promptPreview: PromptPreview | undefined;
  readonly scrollBack: number;
  readonly following: boolean;
  readonly iterationFire: number | undefined;
  readonly iterationTop: number;
  readonly callTop: number;
  readonly notice: string | undefined;
  detailRow(): PanelTaskView | undefined;
  currentIteration(task: PromptLoopTask): Iteration | undefined;
  currentFire(task: CmdLoopTask): FireRecord | undefined;
  growthText(row: PanelTaskView): string;
  frame(title: string, subtitle: string, body: string[], footer: string, width: number): string[];
}
