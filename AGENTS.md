# herdr-reclaim

herdr 的開墾城鎮 mod：所有 agent session 共用一座城，工作累積建材、蓋出建築；收入只看工作量，commit 不另外收成（ADR 0002）。設計見 `docs/proposal.md` 與 `docs/adr/`。

## Agent skills

### Issue tracker

議題記錄在 GitHub Issues（`kaihg/herdr-reclaim`），使用 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用五個預設標籤：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

單一 context：根目錄的 `CONTEXT.md` 加上 `docs/adr/`（等用到時再建立）。See `docs/agents/domain.md`.
