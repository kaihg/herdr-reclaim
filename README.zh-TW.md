# herdr-reclaim

[English](README.md) · 繁體中文

herdr 的一個 mod：**每個 agent session 都是一支遠征隊，工作時開墾土地，每次 commit 自動收成資源，再用資源蓋房。整座城就是你的工作史。**

目標只有一個：讓 herdr 的畫面變得好玩。它不是生產力追蹤工具，也不評斷程式碼好壞；畫面上的數字是遊戲數字，不是績效。

> 狀態：MVP 開發中。目前只支援 OMP（`omp`）的 session；Codex、Claude Code 的 adapter 排在 v1.1。

## 概念

- **一座城 = 一個 git repo。** 同一個 repo 的多個 space、worktree 共用一座城。
- **一塊土地 = 一個互動的 root session。** `/new` 取得另一格，`/resume` 回到原本那一格，subagent 算在它的 root 底下。
- **資源只來自 commit。** 沒有 commit 的工作不會憑空產出木材、石材、鐵料；只有研究會把 token 慢慢換成羊皮卷。
- **工作時間會慢慢開墾土地**，開墾完成後可以用資源蓋房。

## 安裝

需要 herdr、`bun` 與 `herdr-app` 指令。

```sh
sh tools/install.sh
```

腳本會把 mod 複製到 `~/.config/herdr-app/mods/herdr-reclaim`，把 OMP extension 複製到 `~/.omp/agent/extensions/`，並跑一次 `herdr-app check`。新開的 OMP session 才會載入 extension。

**收成需要 git hook。** 第一次看到一座還沒開啟的城，畫面會詢問是否開啟自動收成（在該 repo 的 `.git/hooks` 加三個小檔案）。沒開的城只有工作時間，沒有收成。隨時可以從頂欄停止，會還原原本的 hook。

## 規則

詳細的規則與數值（地圖、土地狀態、commit 怎麼分類、去重、研究、蓋房、加速、市集、hook）在 [`docs/rules.md`](docs/rules.md)。它們是 MVP 試玩基準，之後可能調整。

## 資料放在哪

所有資料在 `~/.config/herdr-app/data/herdr-reclaim/`。帳本只增不改，畫面上的城是從它重播出來的。要重設，刪掉 `cities/` 與 `activity/`（建議先備份）。

## 開發

- 設計提案與決策紀錄：`docs/proposal.md`（當時的提案，不保證與現況一致）。
- mod 本體與模組說明：`mod/herdr-reclaim/README.md`。
- 測試：`cd mod/herdr-reclaim && bun test`；mod 檢查：`herdr-app check .`。
- 畫面右上有「開發模式」開關，打開才會顯示工程資訊。
- 議題在 GitHub Issues。

## 授權

[MIT](LICENSE)
