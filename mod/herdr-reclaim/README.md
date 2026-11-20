# herdr-reclaim（mod）

herdr 的開墾城鎮 mod。這個資料夾是 mod 本體：一個「遠征指揮桌」畫面（proposal §14.1 的 C 版），
上方是城鎮庫存與主要行會，左邊是現役遠征，中央是 3/4 城市地圖，右邊是選取的遠征或格子的詳情。

| 檔案 | 內容 |
|---|---|
| `main.js` | 畫面：開機時把活動寫進帳本、再從帳本重建城鎮；負責四個區塊與點擊 |
| `core/ledger.js` | 城帳本：append-only journal、CAS、內容檔、checkpoint、ack（§13.1，純 JS） |
| `core/town.js` | 城鎮讀取模型：活動紀錄 → 城市、格子、遠征、右側詳情；帳本模式由 journal 決定格子位置 |
| `core/ingest.js` | 把 §6.1 的活動紀錄與「遠征取得土地」寫進帳本（順序與 `planExpeditions` 相同） |
| `core/grid.js` | 邏輯座標、BFS 選地與 3/4 投影（投影與規則分開） |
| `core/selection.js` | 選取狀態的保存（不是城的帳本；見下） |
| `scenarios/first-expedition.js` | 固定事件情境（§6.1 的最小欄位）；這一票的活動來源 |
| `test/town.test.js` | 固定情境測試：只斷言可觀察的城鎮狀態 |
| `test/restore.test.js` | 帳本重建的城 ＝ 直接重播的城；重開、重播、checkpoint 都一樣 |
| `test/ledger.test.js` | 儲存層：完成依據、故障重試、CAS 競爭、換段、ack |
| `test/fs-io.js` | bun 測試用的 fs 後端（模擬 `writeTextFile` 的 CAS）；mod 不會載入它 |
| `spike-panel.js` | S1／S2 的文字面板（proposal §15.1 的證據），沒有被載入 |

領域邏輯完全不碰 host API，所以可以在 bun 下測；只有 `main.js` 匯入 `herdr` 與 `gpui-kit`。
儲存層用一個小小的介面隔離（`io.read` / `io.write(path, text, expected)`）：mod 用
`readTextFile`／`writeTextFile`，測試用 node fs（`test/fs-io.js`），帳本本身不認識任何 host API。

## 城帳本（#3）

- **journal entry 是操作完成的唯一依據**：只有內容檔、沒有 entry 的操作不算完成。
- 每個 writer 的活動寫成一筆 `activity` entry，內容（事件陣列）放在以雜湊命名的
  `blobs/<hash>.json`，**先寫內容再附加 entry**。
- 「遠征取得土地」是一筆 `expedition` entry；座標由 BFS 算，前提（空格、這支遠征在這座城
  還沒有格）在附加前重新檢查。
- **CAS**：`writeTextFile(path, text, expected)` 的 expected 不符就重讀、重新檢查前提、再試
  （`make(state)` 會被重新呼叫，所以會重新選地）。
- **checkpoint**：`checkpoints/<seq>.json` 加之後的 journal 重播，等於從頭重播。
- 每段有大小上限（預設 256 KiB）；放不下先 CAS 附加封段行，再寫下一段。內容格式保留
  #4 的切塊與分頁空間（entry 只引用最上層雜湊）。
- **ack**（§6.2）：`acks/<sessionId>/<epoch>.json`，在 journal 提交成功之後才寫；帳本重播
  不讀 ack，所以 ack 延遲或重播不改變最終狀態。adapter 端的實際消費在 #5。

資料在 `appHome()/data/herdr-reclaim/cities/<cityId 的雜湊>/`（一座城一個目錄，§13）。

## 選取狀態（決策）

選取**不寫進城的 journal**：它不產生資源、不改變土地或 claim，寫進 append-only 的帳本只會
讓每座城多出純 UI 噪音，也讓「帳本重播＝同一座城」的驗證多一個無關變數。改存在
`appHome()/data/herdr-reclaim/ui.json`（以 cityId 為鍵，設定檔等級、可重建的畫面狀態）。
第一次開一座城會把當下顯示的選取記下來；重開 herdr 後還原同一個選取，城或格子已經不在
時回到預設。

## 跑測試

```sh
bun test mod/herdr-reclaim
```

## 載入與檢查

```sh
herdr-app check mod/herdr-reclaim      # 載入一次並渲染，通過才算沒壞
```

`check` 會在 mod 資料夾寫 `gpui-kit.d.ts`、`herdr.d.ts`、`jsconfig.json`（herdr 自己產生的檔案，
已列在 `.gitignore`）。`check` **不會**排版、也**跑不完非同步鏈**（proposal §15.4）：它會在
`init` 的第一個 await 之後就結束，所以帳本那條路要在真的視窗裡跑一次（見下）。

`check` 期間 `checking()` 為 true，mod 只渲染固定情境，不去動使用者的檔案。

## 在真的 herdr 裡驗證

```sh
H=/tmp/herdr-reclaim-verify/home
mkdir -p "$H/mods"; rsync -a --exclude '*.d.ts' --exclude jsconfig.json mod/herdr-reclaim/ "$H/mods/herdr-reclaim/"
printf '{"frame.welcomed":"finished"}\n' > "$H/shared.json"   # 不然會跳歡迎畫面
HERDR_APP_HOME="$H" nohup herdr-app >/dev/null 2>&1 &
HERDR_APP_HOME="$H" herdr-app do pane.split '{"direction":"right","mod":"herdr-reclaim"}'
HERDR_APP_HOME="$H" herdr-app shot /tmp/herdr-reclaim-shot.png
HERDR_APP_HOME="$H" herdr-app do pane.close '{"pane":"<pane id>"}'
HERDR_APP_HOME="$H" herdr-app do window.close '{}'
```

驗證完看一下 `$H/data/herdr-reclaim/`：第一次開會出現 `cities/<hash>/head.json`、`journal/0.json`、
`blobs/*.json`、`acks/*`，以及 `ui.json`；關掉再開同一份 journal（位元組不變）重建出同一座城。

注意：`HERDR_APP_HOME` 只隔離 layouts／mods／settings；spaces、tabs 與 panes 由該機器的
herdr-core 保管，所以開 pane 會動到共用工作區，驗證完記得 `pane.close` 收乾淨
（不要建新的 space／tab，也不要動既有的 terminal）。
