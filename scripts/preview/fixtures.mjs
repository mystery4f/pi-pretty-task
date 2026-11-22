/**
 * The fake session the previews show: a handful of background tasks, loops and
 * one chain, pinned to a fixed clock so the images never drift.
 *
 * Nothing here touches the real store — `TasksPanel` reads a session through
 * `PanelSource`, and this is one.
 */

import { deriveTaskName } from "../../dist/tasks/process/process-tasks.js";

/** Every timestamp is an offset from this instant, so a rebuild is byte-stable. */
export const CLOCK = Date.UTC(2026, 10, 21, 9, 12, 0);
export const HOME = "/home/mystery/work/storefront";
export const now = () => CLOCK;

/** The dev server whose output keeps growing, so its row shows `+size ↑`. */
export const WEB_ID = "bg-7h3q2";
let webBytes = 59_800;

/** Pretend the dev server wrote more bytes since the last refresh. */
export function growWeb(by = 4_200) {
  webBytes += by;
}

function proc(id, name, command, overrides = {}) {
  const created = CLOCK - 300_000;
  return {
    id,
    kind: "process",
    name,
    status: "running",
    createdAt: created,
    updatedAt: created,
    command,
    cwd: HOME,
    outputPath: `${HOME}/.pi/tasks/session/${id}.log`,
    outputBytes: 12_000,
    ...overrides,
  };
}

function fireOf(fire, overrides = {}) {
  const at = CLOCK - (20 - fire) * 300_000;
  return {
    fire,
    at,
    startedAt: at,
    endedAt: at + 900,
    outcome: "success",
    exitCode: 0,
    durationMs: 900,
    outputBytes: 240,
    ...overrides,
  };
}

function iterationOf(fire, calls = [], overrides = {}) {
  return {
    fire,
    startedAt: CLOCK - 900_000 - (5 - fire) * 3_600_000,
    status: "completed",
    calls,
    droppedCalls: 0,
    ...overrides,
  };
}

function call(index, tool, subject, overrides = {}) {
  return {
    id: `call-${index}`,
    tool,
    subject,
    startedAt: CLOCK - 600_000 + index * 1000,
    status: "completed",
    ...overrides,
  };
}

const devLog = [
  "> storefront@0.4.0 dev",
  "> vite --port 5173",
  "",
  "  VITE v6.2.1  ready in 412 ms",
  "",
  "  ➜  Local:   http://localhost:5173/",
  "  ➜  Network: http://192.168.1.24:5173/",
  "  ➜  press h + enter to show help",
  "",
  "5:11:04 PM [vite] hmr update /src/routes/cart.tsx (x3)",
  "5:11:19 PM [vite] hmr update /src/components/PriceTag.tsx",
  "5:11:41 PM [vite] page reload src/routes/checkout.tsx",
].join("\n");

const testLog = [
  " RUN  v5.1.0 /home/mystery/work/storefront",
  "",
  " ✓ test/unit/cart.test.ts (18 tests) 214ms",
  " ✓ test/unit/pricing.test.ts (7 tests) 96ms",
  " ❯ test/integration/checkout.spec.ts (3 tests | 1 failed) 2.41s",
  "   × posts an order when the cart holds one line item",
  "     → expected 201, received 502",
  "",
  " Test Files  1 failed | 2 passed (3)",
  "      Tests  1 failed | 27 passed (28)",
].join("\n");

const PROCS = [
  proc(WEB_ID, "web", "npm run dev", {
    createdAt: CLOCK - 4 * 60_000 - 12_000,
    updatedAt: CLOCK - 2_000,
    outputBytes: 61_204,
    pid: 24_812,
  }),
  proc("bg-c41my", "api", "node --watch src/server.ts", {
    createdAt: CLOCK - 65_000,
    updatedAt: CLOCK - 5_000,
    outputBytes: 12_420,
    pid: 25_004,
  }),
  proc("bg-3kt9v", "lint", "npm run lint", {
    createdAt: CLOCK - 22_000,
    updatedAt: CLOCK - 9_000,
    outputBytes: 1_430,
    pid: 25_118,
  }),
  proc("bg-8q0fe", "storybook", "npm run storybook", {
    createdAt: CLOCK - 3 * 60_000,
    updatedAt: CLOCK - 14_000,
    outputBytes: 9_812,
    pid: 24_990,
  }),
  proc("bg-9vw3b", "test", "npm run test:integration", {
    status: "failed",
    createdAt: CLOCK - 96_000,
    updatedAt: CLOCK - 32_000,
    endedAt: CLOCK - 32_000,
    outputBytes: 8_402,
    exitCode: 1,
  }),
  proc("bg-2mzp8", "db:migrate", "npm run db:migrate", {
    status: "completed",
    createdAt: CLOCK - 900_000,
    updatedAt: CLOCK - 840_000,
    endedAt: CLOCK - 840_000,
    outputBytes: 2_104,
    exitCode: 0,
  }),
  proc("bg-6tqxl", "e2e", "npx playwright test", {
    status: "killed",
    createdAt: CLOCK - 1_200_000,
    updatedAt: CLOCK - 1_100_000,
    endedAt: CLOCK - 1_100_000,
    outputBytes: 44_180,
    killReason: "timeout",
  }),
  proc("bg-1rb4s", "seed", "npm run db:seed", {
    status: "completed",
    createdAt: CLOCK - 1_500_000,
    updatedAt: CLOCK - 1_260_000,
    endedAt: CLOCK - 1_260_000,
    outputBytes: 1_204,
    exitCode: 0,
  }),
  proc("bg-5nx7d", "publish", "npm publish --tag next", {
    status: "failed",
    createdAt: CLOCK - 2_400_000,
    updatedAt: CLOCK - 2_310_000,
    endedAt: CLOCK - 2_310_000,
    outputBytes: 3_601,
    exitCode: 1,
  }),
];

const LOOPS = [
  {
    id: "lc-3fw9h",
    kind: "cmd-loop",
    name: "health-check",
    status: "running",
    createdAt: CLOCK - 3_600_000,
    updatedAt: CLOCK - 60_000,
    schedule: "5m",
    command: "curl -sf http://localhost:3000/health",
    fires: 14,
    nextFireAt: CLOCK + 240_000,
    lastFireAt: CLOCK - 60_000,
    lastOutputBytes: 240,
    fireHistory: [
      fireOf(12, { at: CLOCK - 900_000, startedAt: CLOCK - 900_000, outputBytes: 212 }),
      fireOf(13, { at: CLOCK - 600_000, startedAt: CLOCK - 600_000, outputBytes: 240 }),
      fireOf(14, {
        at: CLOCK - 300_000,
        startedAt: CLOCK - 300_000,
        outcome: "failed",
        exitCode: 22,
        durationMs: 1_400,
        outputBytes: 0,
      }),
    ],
  },
  {
    id: "lc-7k2m9",
    kind: "cmd-loop",
    name: "ci-poll",
    status: "running",
    createdAt: CLOCK - 1_080_000,
    updatedAt: CLOCK - 120_000,
    schedule: "2m",
    command: "bash scripts/ci-status.sh --branch main",
    notifyExitCodes: [1],
    signalRaised: true,
    signalRaisedAt: CLOCK - 120_000,
    fires: 9,
    nextFireAt: CLOCK + 60_000,
    lastFireAt: CLOCK - 120_000,
    lastOutputBytes: 612,
    fireHistory: [
      fireOf(7, { at: CLOCK - 480_000, startedAt: CLOCK - 480_000, outputBytes: 612 }),
      {
        fire: 8,
        at: CLOCK - 300_000,
        startedAt: CLOCK - 300_000,
        endedAt: CLOCK - 297_900,
        outcome: "signalled",
        exitCode: 1,
        durationMs: 2_100,
        outputBytes: 588,
      },
      {
        fire: 9,
        at: CLOCK - 120_000,
        startedAt: CLOCK - 120_000,
        outcome: "running",
        outputBytes: 612,
      },
    ],
  },
  {
    id: "lp-9f3kd",
    kind: "prompt-loop",
    name: "hourly-review",
    status: "paused",
    createdAt: CLOCK - 7_200_000,
    updatedAt: CLOCK - 900_000,
    schedule: "0 * * * *",
    prompt: "Review the commits from the last hour, run the unit suite and report anything broken.",
    fires: 5,
    lastFireAt: CLOCK - 900_000,
    iterations: [
      iterationOf(3, [
        call(1, "bash", "git log --oneline -n 20", { durationMs: 120 }),
        call(2, "read", "src/tasks/loop/pump.ts", { durationMs: 40 }),
      ]),
      iterationOf(4, [
        call(1, "bash", "git diff main...HEAD --stat", { durationMs: 180 }),
        call(2, "bash", "npm run test:unit", { durationMs: 41_200 }),
        call(3, "read", "src/tasks/loop/iterations.ts", { durationMs: 60 }),
      ]),
      iterationOf(5, [
        call(1, "bash", "git log --oneline -n 20", { durationMs: 110 }),
        call(2, "bash", "git diff --stat HEAD~5", { durationMs: 140 }),
        call(3, "read", "src/tasks/loop/pump.ts", { durationMs: 30 }),
        call(4, "grep", "fireHistory", { durationMs: 20 }),
        call(5, "read", "test/unit/loop-pump.test.ts", { durationMs: 40 }),
        call(6, "pretty_task_bg_run", "npm run test:unit", { durationMs: 320 }),
        call(7, "pretty_task_bg_wait", "bg-2vq8d, 120s", { durationMs: 41_700 }),
        call(8, "edit", "src/tasks/loop/pump.ts:118-134", { durationMs: 210 }),
        call(9, "pretty_task_bg_run", "npm run test:unit", { durationMs: 300 }),
        call(10, "pretty_task_bg_wait", "bg-7mt2e, 120s", { durationMs: 39_800 }),
        call(11, "bash", "npm run lint", { durationMs: 3_400 }),
        call(12, "bash", 'git commit -m "fix: keep the fire counter across a restart"', {
          durationMs: 420,
        }),
      ]),
    ],
  },
  {
    id: "ch-5d0ra",
    kind: "chain",
    name: "release",
    status: "running",
    createdAt: CLOCK - 240_000,
    updatedAt: CLOCK - 10_000,
    steps: ["bg-8pk2n", "bg-1xw7c", "bg-4rb6t"],
    cursor: 2,
  },
];

/** A chain's steps and a loop's fired task: present so a detail view can resolve them. */
const CHILDREN = [
  proc("bg-8pk2n", "build", "npm run build", {
    status: "completed",
    createdAt: CLOCK - 240_000,
    updatedAt: CLOCK - 180_000,
    endedAt: CLOCK - 180_000,
    outputBytes: 18_204,
    exitCode: 0,
    parentId: "ch-5d0ra",
  }),
  proc("bg-1xw7c", "release:test", "npm run test:unit", {
    status: "completed",
    createdAt: CLOCK - 180_000,
    updatedAt: CLOCK - 120_000,
    endedAt: CLOCK - 120_000,
    outputBytes: 6_402,
    exitCode: 0,
    parentId: "ch-5d0ra",
  }),
  proc("bg-4rb6t", "release:publish", "npm publish", {
    status: "waiting",
    createdAt: CLOCK - 30_000,
    updatedAt: CLOCK - 10_000,
    outputBytes: 0,
    parentId: "ch-5d0ra",
  }),
  proc("bg-2vq8d", "test", "npm run test:unit", {
    status: "running",
    createdAt: CLOCK - 50_000,
    updatedAt: CLOCK - 1_000,
    outputBytes: 4_210,
    parentId: "lp-9f3kd",
    fire: 5,
  }),
];

const tails = new Map([
  [WEB_ID, devLog],
  ["bg-9vw3b", testLog],
  ["bg-c41my", "listening on :3000\nGET /health 200 1ms\nGET /api/cart 200 24ms\n"],
]);

const viewOf = (task) => ({
  task,
  elapsedMs: (task.endedAt ?? CLOCK) - task.createdAt,
  // The dev server reads from the counter, so a later refresh can report growth.
  outputBytes: task.id === WEB_ID ? webBytes : task.outputBytes,
  untilNextFireMs: task.nextFireAt === undefined ? undefined : task.nextFireAt - CLOCK,
});

/** The command pi is still waiting on. Zero until a preview puts one there. */
let inFront = 0;

/** The task the takeover produces: a command that kept running, now in the list. */
export const DETACHED_ID = "bg-n3w9k";

/** Put a command back in front, so the panel draws the takeover hint. */
export function holdInFront(count = 1) {
  inFront = count;
}

/**
 * Let the command in front go, the way `ctrl+shift+b` does: the front line empties
 * and the same command arrives as a running task, most recently changed first.
 */
export function detachFront() {
  inFront = 0;
  if (PROCS.some((task) => task.id === DETACHED_ID)) return;
  // No name was ever given: the store derives one from the command, exactly here.
  const command = "npx vitest --watch";
  PROCS.push(
    proc(DETACHED_ID, deriveTaskName(command), command, {
      createdAt: CLOCK - 8_000,
      updatedAt: CLOCK,
      outputBytes: 1_840,
      origin: "foreground",
    }),
  );
}

/** A `PanelSource` over the fixtures: no files, no processes, nothing to stop. */
export const source = {
  sessionId: "9b31d0c5",
  list: async () => [...PROCS, ...LOOPS, ...CHILDREN].map(viewOf),
  tail: async (id) => {
    const text = tails.get(id);
    return text === undefined
      ? undefined
      : { text, lines: text.split("\n").length, truncated: false };
  },
  stop: async () => undefined,
  /** What pi is still waiting on: not a row, only the hint above the keys. */
  foreground: () => inFront,
};
