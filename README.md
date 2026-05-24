# pi-xplan

A small steering-only planning extension for [pi](https://pi.dev/).

It adds one slash command, `/xplan`, for regular planning and bottom-up step-by-step implementation planning.

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
/xplan approve            Approve current plan/current step for implementation
/xplan continue           Continue after manual review/staging
/xplan preview            Print current plan with completed step checkmarks
/xplan complete           Mark xplan session complete
/xplan exit               Exit xplan mode
/xplan status             Show current state
/xplan help               Show help
```

`[task]` is optional. Without it, xplan only switches mode; your next prompt will run with xplan steering.

## Behavior

### Regular plan mode

- Discuss and inspect first.
- Build a clear implementation plan.
- Do not edit until `/xplan approve`.
- After implementation, stop for manual review.

### Step-by-step mode

`/xplan steps` tells the agent to:

1. Build the full feature picture: behavior, data flow, dependencies, integration points, and required code blocks.
2. Split implementation bottom-up so foundations are implemented before dependents.
3. Keep each step review-friendly: not tiny, not huge.
4. Keep the project buildable after each step when practical.
5. Implement only one approved step at a time.
6. Stop after each step so the user can review/stage files manually.
7. Continue with the next pending planned step after `/xplan continue`.
8. Preview the whole plan with `/xplan preview`, using checkmarks for completed steps.
9. On the last implementation step, review the full feature, run/check reasonable validation if available, and fix issues before stopping.

## Important notes

This extension is intentionally simple and steering-only:

- No custom tools.
- No file security enforcement.
- No settings UI.
- No git automation.

The agent is instructed to never stage, unstage, commit, push, pull, merge, rebase, stash, reset, restore, checkout files, cherry-pick, or otherwise mutate git history/state. The user manages git manually.
