# Verification

What "done" has to look like here, and which layer answers which question. A session that changes
the mod reads this before claiming anything works.

The mod's screen (`mod/herdr-reclaim/main.js`) talks to the host through three modules
(`gpui-kit`, `gpui-base`, `herdr`). Tests replace them, so the render tree is data and an event
handler is a plain function: pressing a button in a test is calling it.

## Ladder (cheapest first, all of it runs before "done")

| Layer | Command | Proves | Needs a window |
| --- | --- | --- | --- |
| core | `bun test mod/herdr-reclaim` | ledger, rules, grid hits, quotas | no |
| view | same run, `test/view.test.js` | which words are on screen, state after a click, column widths at narrow panes | no |
| load chain | same run, `test/pipeline.test.js` | real ledger → load → screen; ordering a building writes the ledger | no |
| render | `herdr-app check mod/herdr-reclaim` | render does not throw, no unknown element method | no |
| pixels | `tools/ui-report.sh` | layout, overlap, truncation | window (survives a locked screen by marking itself unverified) |

The first four must be green. The last one produces `report.html` for a person to look at.

## Rules

- Anything that can be asserted, assert it in bun. Do not open a window, take a screenshot or call
  computer use to "check how it looks" when the question is what the screen says or what a click
  does. Add a `view` or `pipeline` test with the interaction instead.
- Pixels are not a gate. Do not diff screenshots to decide pass/fail: the clock text and animation
  differ every run. The pictures exist for a human to spot layout damage.
- `computer-use` / synthetic `CGEvent` clicks are for the rare case of proving how real pointer
  events behave on this machine (`mod/herdr-reclaim/README.md`, "真的要在視窗裡點"). They are not
  the QA executor and not a required path; a locked screen or a missing authorization prompt must
  never be able to block verification.
- `herdr-app check` does not lay out the screen and does not finish the async chain (proposal
  §15.4): it stops after the first `await` in `init`. Never treat `check passed` as the whole
  verification.
- Verification belongs to a fresh context (`/qa` or a new session), not to the session that made
  the change. QA does not fix the product and does not move the acceptance criteria.
- Record what ran on the issue: commands, `herdr-app --version`, and the result. "Should work" is
  not evidence.
- A check that failed is not a blocker to work around. Report it with the output.

## What the layers cannot see

- Real font metrics and layout: only the three `tools/ui-report.sh` pictures.
- Whether `herdr-app shot` can capture a frame while the screen is locked: unverified. The script
  marks that run "視覺未驗" instead of failing, so the rest of the report still lands.
- Wall-clock effects such as toast auto-dismiss: tests assert the state transition, not the duration.
  Construction advances with recorded work, so its exact remaining units are testable.
