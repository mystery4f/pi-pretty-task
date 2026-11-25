---
name: pretty-task-unattended
description: Run long work unattended with a prompt loop that advances one step per fire and closes itself when the work is done. Use when the user says 无人值守、跑一宿、关电脑前让它继续跑、loop 到完成为止、unattended run, or asks how to keep an agent working while nobody watches.
---

# Unattended work with a prompt loop

A prompt loop is a clock that delivers a message into the session; every fire
starts one agent turn. It is the right tool for "keep advancing this job while I
am away" and the wrong tool for "retry a failed request" — pi retries transient
provider errors itself (`retry.maxRetries`, three attempts by default).

The parts that decide whether an unattended night succeeds are not the schedule:
they are **a durable progress file**, **a closing contract inside the prompt**,
and **a hard stop**.

## Open the loop

Call `pretty_task_loop_create` with a prompt, an interval, and a stop.

- `schedule`: `15m` to `30m`. Anything shorter than one turn's work only queues
  wakes that fire back to back once the turn ends.
- `maxFires`: always set it — roughly three fires per remaining item. It is the
  only stop that does not depend on the model's judgement.
- `expiresIn`: a wall-clock backstop, e.g. `12h`.
- `name`: what the loop is for, not the prompt's first line.
- A prompt loop accepts only `prompt`, `name`, `schedule`, `maxFires`,
  `expiresIn`. `cwd`, `env`, `wakeOnFailure` and `notifyExitCodes` are rejected:
  those belong to a command loop.

Read `<cwd>/.pi/progress.md` first. If it does not exist, write it before creating
the loop, so the first fire has something to advance.

## The progress file

One line per step, each with a check that says whether it is done. Two forms:

```markdown
# Unattended progress — nightly cleanup

Loop: loop-3f2a

- [ ] collapse duplicated fixtures — acceptance: `npm run test:unit` exits 0
- [ ] update docs/previews.md — acceptance: the three GIF paths exist
- [x] done 2026-11-25T20:30 · evidence: commit abc1234
```

Rules that matter more than the shape:

- Every item carries its own acceptance check. "Improve the code" cannot be
  finished; "`npm run lint` exits 0" can.
- A completed item is ticked in the same turn that claims it, with the evidence
  appended. Un-ticked means not done.
- Never rewrite earlier lines; append.

## The closing contract

Put this at the end of the loop's prompt, replacing `<loopId>` with the real id:

```text
You are one unattended continuation turn. Move exactly one item forward.

Before you finish this turn, do exactly one of these:
- Items remain in .pi/progress.md: tick the item you finished, append
  `done <ISO time> · evidence: <command or file path>`, then stop. Do not start
  a second item.
- Everything is ticked, or nothing can move forward: call
  pretty_task_loop_update id=<loopId> action=complete, then stop and start no
  new work.

Never claim progress without updating .pi/progress.md in the same turn.
```

Two properties make this work: the tick and the claim are one action, and the
close is a tool call rather than a sentence the model may forget to say.

The prompt is stored on the loop record, so changing it means recreating the loop
(and losing its iteration history). Prompt files on disk are drafted in
`docs/adr/0024-loop-prompt-lands-on-disk.md`; once that lands, the same text lives
in `.pi/tasks/<sessionId>/<loopId>.prompt.md` and can be edited in place.

## Morning after

- `pretty_task_loop_list id=<loopId>` — the loop's iterations, newest first, each
  with the tool calls its turn made. A turn with no tool calls and no tick is a
  fire that did nothing.
- `/tasks` opens the panel; the loop row carries the fire count, the next fire and
  any failure streak (command loops only today).
- A loop still `running` with all items ticked means the contract did not fire:
  close it with `pretty_task_loop_update id=<loopId> action=complete`.

## Anti-patterns

- **No `maxFires`.** A loop that judges itself unfinished runs until someone
  remembers it.
- **A prompt of "continue".** With no progress file, every fire re-derives the
  state from a shrinking context and repeats or drifts.
- **A loop as a retry engine.** Fires are full model calls; a loop whose only job
  is to knock again burns tokens and hides the real provider error.
- **Handing the model a path.** The prompt file's location is derived from the
  loop id (ADR-0024); there is no path parameter, and a copy written elsewhere is
  inert.
