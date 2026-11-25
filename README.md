# herdr-reclaim

English · [繁體中文](README.zh-TW.md)

A herdr mod where **every agent session shares one town: work accumulates building materials, and you spend them on buildings. The town grows with the amount of work.**

The only goal is to make herdr's UI fun. It is not a productivity tracker and it does not judge your code; the numbers on screen are game numbers, not performance metrics.

> Status: MVP in development. Only OMP (`omp`) sessions are supported for now; Codex and Claude Code adapters are planned for v1.1. The UI is currently Traditional Chinese only (see the i18n issue).

## Concepts

- **One town.** One local user's data shares one town, one storehouse and one build target, regardless of repo, space, session or provider.
- **Resources come from work only.** Valid work (interactive, finished turns, non-cache input + output only) yields wood 3, stone 2, iron 1 per 10,000 tokens. Commits make no difference; they are no longer a bonus ([ADR 0002](docs/adr/0002-income-from-work-only.md)).
- **Site selection is the player's decision.** Pick a building and a spot; construction starts when materials are ready, and completion reveals the land around it.

## Install

Requires herdr, `bun` and the `herdr-app` command.

```sh
sh tools/install.sh
```

The script copies the mod to `~/.config/herdr-app/mods/herdr-reclaim`, copies the OMP extension to `~/.omp/agent/extensions/`, and runs `herdr-app check`. Only OMP sessions started afterwards load the extension.

No git hooks are needed. Older versions asked each repo for a recorder in exchange for a commit bonus; that has stopped, and the recorders were removed once on 2026-11-25.

## Rules

Detailed rules and numbers (map, reveal, base income, build target, recipes and durations, quotas, legacy hook cleanup) are in [`docs/rules.md`](docs/rules.md). They are MVP playtest baselines and may change. That document is currently Traditional Chinese only.

## Where data lives

Everything is under `~/.config/herdr-app/data/herdr-reclaim/`. The ledger is append-only and the town on screen is replayed from `shared/`. To reset, delete `shared/` and `activity/` (back them up first). The current mod and adapters no longer read or write `cities/`, `commits/` or `sources/`.

## Development

- Design proposal and decision log: `docs/proposal.md` (a snapshot from design time; it may not match the current behavior).
- Mod internals: `mod/herdr-reclaim/README.md`.
- Tests: `cd mod/herdr-reclaim && bun test`; mod check: `herdr-app check .`.
- Visual report (tests, `herdr-app check`, three pane widths): `tools/ui-report.sh`, then open the printed `report.html`. It runs an isolated app and core, so your running Herdr is untouched. Screenshots are for human review, not a pass/fail gate; the rules are in [`docs/agents/verification.md`](docs/agents/verification.md).
- A "dev mode" toggle in the top bar reveals engineering details.
- Issues live on GitHub.

## License

Code: [MIT](LICENSE). Images in [`mod/herdr-reclaim/assets/`](mod/herdr-reclaim/assets/) are AI-generated and licensed separately under CC BY 4.0; read its `NOTICE.md` first.
