# pi-xplan

A small planning workflow extension for [pi](https://pi.dev/) with lightweight mutation guards.

It adds one slash command, `/xplan`, for regular planning and bottom-up step-by-step implementation planning.

Compatibility: `pi-xplan` uses Pi's extension API as a peer dependency and is intended to work across current Pi releases.

## Install / run

Install the published package:

```bash
pi install pi-xplan
```

Run from a local checkout during development:

```bash
pi -e .
```

Or install a local checkout as a pi package:

```bash
pi install .
```

## Commands

```text
/xplan [task]             Start regular plan mode
/xplan steps [task]       Start bottom-up step-by-step planning mode
/xplan approve            Approve implementation or review fixes for the current plan/step
/xplan continue           Accept reviewed work and continue after manual review/staging
/xplan preview            Print current plan with completed step checkmarks
/xplan complete           Mark xplan session complete and clear xplan steering
/xplan exit               Exit xplan mode and stop the current turn if needed
/xplan status             Show current state
/xplan help               Show help
```

`[task]` is optional. Without it, xplan only switches mode; your next prompt will run with xplan steering.

## Behavior

### Regular plan mode

- Discuss and inspect first.
- Build a clear implementation plan.
- Do not edit until `/xplan approve`.
- Use `/xplan approve` again for review fixes.
- After implementation or review fixes, stop for manual review.

### Step-by-step mode

`/xplan steps` is for production-style work where foundations matter. It plans the full feature, then builds bottom-up, for example: DB/model design -> utils/services -> server/API -> frontend. Each next step relies on reviewed/staged code, which helps catch misleading assumptions and weak foundations early, reduce AI slop, and avoid one bad low-level piece polluting the rest of the app.

`/xplan steps` tells the agent to:

1. Build the full feature picture: behavior, data flow, dependencies, integration points, and required code blocks.
2. Split implementation bottom-up so foundations are implemented and reviewed before dependents.
3. Keep each step review-friendly: not tiny, not huge.
4. Keep the project buildable after each step when practical.
5. Implement only one approved step at a time.
6. Stop after each step so the user can review and request fixes.
7. After review/fixes, the user manually stages accepted files with `git add`, then runs `/xplan continue`.
8. Continue with the next pending step after `/xplan continue`, so review can focus only on new changes.
9. Rework the just-implemented awaiting-review step after `/xplan approve` if review feedback requires fixes.
10. Preview the whole plan with `/xplan preview`, using checkmarks for completed steps.
11. On the last implementation step, review the full feature, run/check reasonable validation if available, and fix issues before stopping.

## Debugging

Run pi with `--xplan-debug` to print xplan state-machine logs to stderr.

## Important notes

This extension is intentionally simple:

- No custom tools.
- No settings UI.
- No git automation.
- Built-in `edit`/`write` tools and obvious mutating `bash` commands are blocked unless xplan is in the approved `implementing` phase.
- Failed or interrupted implementation attempts are marked as `implementation failed`; `/xplan continue` retries the same approved scope/step instead of advancing.
- `/xplan complete` and `/xplan exit` add an inactive boundary, ignore stale xplan control prompts in later context, and abort the current agent turn when run mid-stream.
- In step mode, `/xplan approve` reworks the current awaiting-review step; `/xplan continue` means the step was accepted/reviewed/staged and advances to the next pending step.

The agent is also instructed to never stage, unstage, commit, push, pull, merge, rebase, stash, reset, restore, checkout files, cherry-pick, or otherwise mutate git history/state. The user manages git manually.
