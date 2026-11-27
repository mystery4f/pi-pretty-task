/**
 * The tour `docs/preview.gif` plays, and the one place its order lives.
 *
 * The story is one session: a command is typed in an ordinary pi session, it runs,
 * `ctrl+shift+b` moves it off the front, the card it leaves lands in the transcript,
 * and from then on the same task — same id, same command, same exit code — is read
 * through `/tasks`. Every row and every sentence comes from the captured store in
 * `record/session.json` (see `capture-record.mjs`) or from a shipped renderer; a
 * frame may not print an id the store does not hold.
 *
 * Every frame is one a renderer already produces: `renderX()` hands back the whole
 * walk it drove and this list names which frames the animation keeps. No page is
 * captured twice and no frame exists only for the gif.
 *
 * `label` is the frame a renderer produced (`drive()` labels them `<render>:<step>`),
 * `key` is what the frame answers to — the badge drawn in the window shows it, and it
 * must be something the panel or the host really answers to (a token from `keys.ts`,
 * `ctrl+shift+b`, `/tasks`); a typing step keeps the key that opened search, because
 * a typed letter is not a key the panel binds. `surface` names the user-visible
 * surface the frame proves, one of `SURFACES`.
 *
 * `ms` is how long the frame stays, `topic` says what it shows, and `mark` is the
 * phrase both `README.md`'s gif alt text and the `docs/previews.md` row must contain,
 * in this same order — that is what keeps the three descriptions from drifting apart.
 *
 * A new user-visible surface either earns a frame here, with the `mark` sentence to go
 * with it, or gets its reason written in `docs/previews.md`'s "新功能上线之后" section.
 */
export const TOUR = [
  {
    label: "session:prompt",
    ms: 1_800,
    key: "Enter",
    surface: "session:transcript",
    topic: "a command typed in an ordinary session, editor and all",
    mark: "command is typed in an ordinary session",
  },
  {
    label: "session:running",
    ms: 1_600,
    key: "",
    surface: "session:transcript",
    topic: "the command runs in the foreground and its output arrives",
    mark: "it runs in the foreground",
  },
  {
    label: "session:detach",
    ms: 2_600,
    key: "ctrl+shift+b",
    surface: "session:transcript",
    topic: "the key moves it off the front and the receipt names the task id",
    mark: "ctrl+shift+b moves it to the background",
  },
  {
    label: "session:card",
    ms: 2_400,
    key: "",
    surface: "card:detach",
    topic: "the card the takeover leaves in the transcript",
    mark: "the card it leaves behind",
  },
  {
    label: "story:start",
    ms: 2_000,
    // The key, not the command: a press, and the same spelling the status line prints.
    key: "Shift↓",
    surface: "panel:list",
    topic: "the panel opens on every status and the same task is in the list",
    mark: "the panel opens on every status",
  },
  {
    label: "story:open the log",
    ms: 1_800,
    key: "Enter",
    surface: "panel:task-detail",
    topic: "Enter opens that task and its output",
    mark: "one task's output",
  },
  {
    label: "story:follow",
    ms: 1_400,
    key: "r",
    surface: "panel:follow",
    topic: "follow keeps the tail arriving",
    mark: "following the log",
  },
  {
    label: "story:back to the list",
    ms: 1_100,
    key: "←",
    surface: "panel:list",
    topic: "the arrow goes back, the list keeps its place",
    mark: "back to the list",
  },
  {
    label: "story:finished",
    ms: 1_800,
    key: "",
    surface: "panel:list",
    topic: "the task ends and its row says so",
    mark: "the task ends",
  },
  {
    label: "story:filter running",
    ms: 1_100,
    key: "f",
    surface: "panel:filter",
    topic: "f narrows to what is still running",
    mark: "f narrows",
  },
  {
    label: "story:filter failed",
    ms: 1_600,
    key: "f",
    surface: "panel:filter",
    topic: "the next f keeps only the failed ones, with the code that failed them",
    mark: "the failed filter keeps the reason",
  },
  {
    label: "story:search",
    ms: 1_600,
    key: "/",
    surface: "panel:search",
    topic: "/ searches rows by their text",
    mark: "/ search",
  },
  {
    label: "story:keep the query",
    ms: 1_200,
    key: "alt+q",
    surface: "panel:search",
    topic: "leaving search keeps the query, so the list stays filtered",
    mark: "keeps the query",
  },
  {
    label: "cards:finished",
    ms: 2_200,
    key: "",
    surface: "notice:finished",
    topic: "the notice a finished task leaves in the transcript",
    mark: "the notice a finished task leaves",
  },
  {
    label: "status:line",
    ms: 1_800,
    key: "",
    surface: "status:line",
    topic: "one line above the editor while the panel is closed",
    mark: "one line above the editor",
  },
  {
    label: "result:blocked",
    ms: 2_600,
    key: "",
    surface: "result:blocked",
    topic: "a wait: true call answering with its output instead of a task id",
    mark: "a wait: true call answering",
  },
];

/**
 * What the frames prove, by name: a surface with no frame fails the tour's test.
 *
 * The loop and chain pages are missing on purpose: the animation quotes a real
 * session, and this machine's store holds no loop or chain record to quote. The
 * reason is written in `docs/previews.md`; inventing one would break the rule the
 * tour exists to keep.
 */
export const SURFACES = [
  { surface: "session:transcript", what: "an ordinary session, before the panel is ever opened" },
  { surface: "card:detach", what: "the card a takeover leaves in the transcript" },
  { surface: "panel:list", what: "the panel list, opened on every status" },
  { surface: "panel:task-detail", what: "one task's detail page with its output" },
  { surface: "panel:follow", what: "a tail that keeps arriving while you watch" },
  { surface: "panel:filter", what: "the filter cycle, narrowed to failed" },
  { surface: "panel:search", what: "the search, and a query kept after leaving it" },
  { surface: "notice:finished", what: "the notice a finished task leaves" },
  { surface: "status:line", what: "the summary line above the editor" },
  { surface: "result:blocked", what: "a wait: true call's answer" },
];

/**
 * The strip under every window: the three things no frame can show.
 *
 * The key rows (`r follow`, `c path`, `← list`) are already drawn by the panel's own
 * footer, so repeating them here would spend rows on what the reader can see.
 */
export const LEGEND = [
  "ctrl+shift+b moves one waiting command to the background — a foreground command, or a wait: true call",
  "Esc on that blocked call ends the wait; the command keeps running",
  // The door is a key here; `/tasks` is the typing form the status line also prints.
  "Shift↓ opens this panel at any time; /tasks does the same when typing is easier",
];

/**
 * What one loop may cost. Both are checked after a render, so a tour that grew
 * without anyone deciding to fails instead of quietly doubling the file.
 */
export const LIMITS = {
  maxLoopMs: 36_000,
  maxBytes: 1024 * 1024,
};
