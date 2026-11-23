# herdr-reclaim

English · [繁體中文](README.zh-TW.md)

A herdr mod where **every agent session is an expedition: it clears land while it works, harvests resources from every commit, and spends them on buildings. Your whole town is your work history.**

The only goal is to make herdr's UI fun. It is not a productivity tracker and it does not judge your code; the numbers on screen are game numbers, not performance metrics.

> Status: MVP in development. Only OMP (`omp`) sessions are supported for now; Codex and Claude Code adapters are planned for v1.1. The UI is currently Traditional Chinese only (see the i18n issue).

## Concepts

- **One town = one git repo.** Several spaces and worktrees of the same repo share one town.
- **One plot of land = one interactive root session.** `/new` claims another plot, `/resume` returns to the original one, and subagents count under their root.
- **Resources come from commits only.** Work without a commit never produces wood, stone or iron; only "research" slowly turns tokens into parchment.
- **Working time slowly clears the land**; once cleared, you can build on it.

## Install

Requires herdr, `bun` and the `herdr-app` command.

```sh
sh tools/install.sh
```

The script copies the mod to `~/.config/herdr-app/mods/herdr-reclaim`, copies the OMP extension to `~/.omp/agent/extensions/`, and runs `herdr-app check`. Only OMP sessions started afterwards load the extension.

**Harvesting needs git hooks.** The first time the UI sees a town without them, it asks whether to enable automatic harvesting (three small files in that repo's `.git/hooks`). Without hooks a town only tracks working time. You can stop it at any time from the top bar, which restores any hook that was there before.

## Rules

Detailed rules and numbers (map, land states, how commits are classified and de-duplicated, research, buildings, boost, market, hooks) are in [`docs/rules.md`](docs/rules.md). They are MVP playtest baselines and may change. That document is currently Traditional Chinese only.

## Where data lives

Everything is under `~/.config/herdr-app/data/herdr-reclaim/`. The ledger is append-only and the town on screen is replayed from it. To reset, delete `cities/` and `activity/` (back them up first).

## Development

- Design proposal and decision log: `docs/proposal.md` (a snapshot from design time; it may not match the current behavior).
- Mod internals: `mod/herdr-reclaim/README.md`.
- Tests: `cd mod/herdr-reclaim && bun test`; mod check: `herdr-app check .`.
- A "dev mode" toggle in the top bar reveals engineering details.
- Issues live on GitHub.

## License

Code: [MIT](LICENSE). Images in [`mod/herdr-reclaim/assets/`](mod/herdr-reclaim/assets/) are AI-generated and licensed separately under CC BY 4.0; read its `NOTICE.md` first.
