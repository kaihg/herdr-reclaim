# herdr-reclaim

[English](README.md) · 繁體中文

herdr 的一個 mod：**所有 agent session 共用一座城，工作累積建材，再用建材蓋房。城市隨著工作量成長。**

目標只有一個：讓 herdr 的畫面變得好玩。它不是生產力追蹤工具，也不評斷程式碼好壞；畫面上的數字是遊戲數字，不是績效。

> 狀態：MVP 開發中。目前只支援 OMP（`omp`）的 session；Codex、Claude Code 的 adapter 排在 v1.1。

## 概念

- **一座城。** 同一份本機使用者資料共用一座城、一個倉庫與一項建設目標，不按 repo、space、session 或 provider 分城。
- **資源只看工作量。** 有效工作（互動、已結束的回合，只算 non-cache input + output）每滿 10,000 token 累積木材 3、石材 2、鐵料 1。有沒有 commit 都一樣，commit 不另外加碼（[ADR 0002](docs/adr/0002-income-from-work-only.md)）。
- **選址才是玩家的決定。** 先選建築與位置，材料備齊自動開工，工期到就完工、揭開附近的土地。

## 安裝

需要 herdr、`bun` 與 `herdr-app` 指令。

```sh
sh tools/install.sh
```

腳本會把 mod 複製到 `~/.config/herdr-app/mods/herdr-reclaim`，把 OMP extension 複製到 `~/.omp/agent/extensions/`，並跑一次 `herdr-app check`。新開的 OMP session 才會載入 extension。

不需要 git hook。舊版曾要求每個 repo 裝記錄器換取 commit 加碼，已經停止；還留著記錄器的 repo，左側會列出並提供一次「全部移除」。

## 規則

詳細的規則與數值（地圖、揭開、基本收入、建設目標、配方與工期、額度、舊版 hook 清理）在 [`docs/rules.md`](docs/rules.md)。它們是 MVP 試玩基準，之後可能調整。

## 資料放在哪

所有資料在 `~/.config/herdr-app/data/herdr-reclaim/`。帳本只增不改，畫面上的城是從 `shared/` 重播出來的。要重設，刪掉 `shared/` 與 `activity/`（建議先備份）。新版 mod 與 adapter 不再讀寫 `cities/`、`commits/`、`sources/`；但 repo 裡還留著的記錄器會在每次 commit 繼續往 `commits/` 寫，直到你在清理卡把它移除。

## 開發

- 設計提案與決策紀錄：`docs/proposal.md`（當時的提案，不保證與現況一致）。
- mod 本體與模組說明：`mod/herdr-reclaim/README.md`。
- 測試：`cd mod/herdr-reclaim && bun test`；mod 檢查：`herdr-app check .`。
- 畫面右上有「開發模式」開關，打開才會顯示工程資訊。
- 議題在 GitHub Issues。

## 授權

程式碼：[MIT](LICENSE)。[`mod/herdr-reclaim/assets/`](mod/herdr-reclaim/assets/) 的圖片由 AI 生成，另採 CC BY 4.0，使用前請先讀該資料夾的 `NOTICE.md`。
