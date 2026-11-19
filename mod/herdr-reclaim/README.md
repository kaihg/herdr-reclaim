# herdr-reclaim（mod）

herdr 的開墾城鎮 mod。這個資料夾是 mod 本體：一個「遠征指揮桌」畫面（proposal §14.1 的 C 版），
上方是城鎮庫存與主要行會，左邊是現役遠征，中央是 3/4 城市地圖，右邊是選取的遠征或格子的詳情。

| 檔案 | 內容 |
|---|---|
| `main.js` | 畫面：只讀公開的城鎮讀取模型，負責四個區塊與點擊 |
| `core/town.js` | 城鎮讀取模型：活動紀錄 → 城市、格子、遠征、右側詳情（純 JS，沒有 herdr／Node API） |
| `core/grid.js` | 邏輯座標、BFS 選地與 3/4 投影（投影與規則分開） |
| `scenarios/first-expedition.js` | 固定事件情境（§6.1 的最小欄位）；這一票的資料來源 |
| `test/town.test.js` | 固定情境測試：只斷言可觀察的城鎮狀態 |
| `spike-panel.js` | S1／S2 的文字面板（proposal §15.1 的證據），沒有被載入 |

領域邏輯完全不碰 host API，所以可以在 bun 下測；畫面只透過 `./core/*.js` 匯入它們。
之後的票（#3 帳本、#5 真實 adapter）從 `core/town.js` 的 `readTown({ activities, repoFacts })` 接進來。

## 跑測試

```sh
bun test mod/herdr-reclaim
```

## 載入與檢查

```sh
herdr-app check mod/herdr-reclaim      # 載入一次並渲染，通過才算沒壞
```

`check` 會在 mod 資料夾寫 `gpui-kit.d.ts`、`herdr.d.ts`、`jsconfig.json`（herdr 自己產生的檔案，
已列在 `.gitignore`）。`check` **不會**排版，所以它通過不代表畫面在真的視窗裡排得對；
要動畫面時，用隔離的 home 真的開一次（見交接筆記）：

```sh
HERDR_APP_HOME=/tmp/herdr-reclaim-verify/home herdr-app
HERDR_APP_HOME=/tmp/herdr-reclaim-verify/home herdr-app do pane.split '{"direction":"right","mod":"herdr-reclaim"}'
HERDR_APP_HOME=/tmp/herdr-reclaim-verify/home herdr-app shot /tmp/herdr-reclaim-shot.png
```

注意：`HERDR_APP_HOME` 只隔離 layouts／mods／settings；spaces、tabs 與 panes 由該機器的
herdr-core 保管，所以開 pane 會動到共用工作區，驗證完記得 `pane.close` 收掉。
