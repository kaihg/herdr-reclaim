# herdr-reclaim（mod）

herdr 的開墾城鎮 mod。這個資料夾是 mod 本體：**一座共用城市**（#22 之後只剩這一個畫面）。
上方是共用庫存、工作進度與建設佇列最前面那一項，左邊是佇列摘要與可選的建築，
中央是共用城市的地圖，右邊是整棟預覽或佇列明細（未開工的項目可取消）。

所有 repo、space 與 session 的工作都只當成同一座城的工作來源：不產生遠征格，也不讀寫
`cities/` 下的舊帳本（舊資料留在使用者的磁碟上，不遷移）。

| 檔案 | 內容 |
|---|---|
| `main.js` | 畫面：讀 adapter 活動檔、走正式載入路徑、選址與施工計時；監看新活動與額度排程 |
| `../omp-extension/herdr-reclaim.ts` | OMP extension：按 session/writer epoch 寫活動事件、heartbeat、usage source key，讀 journal ack 後 compact |
| `core/adapter.js` | 讀活動檔並合併同一 epoch 的紀錄（活動格式見 §6.1） |
| `core/city-load.js` | 正式載入路徑（#22）：活動檔寫進 journal 並寫 ack（§6.2）→ 收入 → 推進施工 → 公開讀取模型；測試與 runtime 共用這一支 |
| `core/ledger.js` | 共用城市的帳本：append-only journal、CAS、內容檔、checkpoint、ack（§13.1，純 JS） |
| `core/shared-city.js` | 共用城市（#23–#27）：工作收入、建設佇列（多項預定、排到隊首才付料、開工、完工、取消）、公開讀取模型；commit 不另外收成（#28、ADR 0002） |
| `core/city-map.js` | 共用城市的地圖（#25–#27）：固定地形、起始揭開區、完工建築的揭開範圍、建築占地與選址判準；預覽與帳本前提檢查共用同一個 `siteCheck` |
| `core/research.js` | 回合（`roundsOf`）與工作資格的判準（互動 root／child 歸戶）：收入用 |
| `core/provider-stats.js` | 額度回報（S5 形狀）→ 顯示模型；不推算、不補 0 |
| `core/quota-source.js` | 額度來源（官方 CLI 的 redacted JSON）與全域限流 |
| `core/quota-view.js` | 額度模型的「現在」重新判定（TTL／resetsAt） |
| `core/grid.js` | 邏輯座標與 3/4 投影（投影與規則分開） |
| `core/selection.js` | 選取與開發模式的保存（不是帳本；見下） |
| `core/host-io.js` | 儲存介面的 host 適配層：herdr 的原生 CAS 衝突 → `CasConflict`（見下） |
| `core/blobs.js`／`core/pages.js`／`core/bytes.js`／`core/cas.js` | 帳本的內容檔、分頁索引、雜湊與 CAS 工具 |
| `core/map-style.js` | 地圖每一格的樣式（填色、框線、預覽與建築記號）：純資料，依樣式分桶讓畫面只畫幾條路徑 |
| `ui/map.js` | 共用城市的地圖繪製（地形、預定地、工地、建築、選址預覽） |
| `ui/assets.js` | 建築 mock 的輪廓（向量，不影響數值） |
| `scenarios/shared-city.js` | `herdr-app check` 的固定情境；正式 runtime 不拿它入帳 |
| `test/city-load.test.js` | 正式載入路徑的整合測試：多 repo／多 session／`/new`／resume 只增加共用庫存、不建立 `cities/`、重載不雙算 |
| `test/shared-city.test.js` | 共用城市：收入只入帳一次、選址與整棟預覽、佇列上限與 FIFO 付料、缺料預定、取消交還、逐份完工、揭開與哨站、舊 journal 重播 |
| `test/ledger-storage.test.js` | 儲存層：完成依據、故障重試、CAS 競爭、換段、checkpoint 完整性、ack |
| `test/ledger-capacity.test.js` | 長期帳本的容量（20,000 筆收入）：每個檔案 ≤ 256 KiB、checkpoint 查得回每一筆、兩條讀取路徑狀態一致 |
| `test/codex-adapter.test.js` | 真 Codex adapter：hook → 活動檔（cached input 扣除、未知不補零）、ack compact 後控制狀態不遺失、進共用庫存計量器 |
| `test/omp-adapter.test.js` | OMP 活動重播：root／fork 算工作、print 不算、child 併進 root、resume 用量去重；ack 後的新尾巴接回 journal；重播不變 |
| `test/fs-io.js` | bun 測試用的 fs 後端（說同一種 CAS 語言）；mod 不會載入它 |

領域邏輯完全不碰 host API，所以可以在 bun 下測；只有 `main.js` 匯入 `herdr` 與 `gpui-kit`。
儲存層用一個小小的介面隔離（`io.read` / `io.write(path, text, expected)`），**契約是**：
快照不符（`expected === null` 代表建立新檔）就拒絕成 `CasConflict`，其他錯誤原樣往上丟。
mod 端由 `core/host-io.js` 把 herdr 的原生錯誤轉成 `CasConflict`（真實 host 的衝突是原生
`Error`，訊息是 `` `herdr.writeTextFile`: The file changed outside Herdr. Reload before saving… ``，
三種衝突形狀共用同一句）；測試端由 `test/fs-io.js` 直接說同一種語言；帳本本身不認識 host API。

## 帳本（#3、#4）

- **journal entry 是操作完成的唯一依據**：只有內容檔、沒有 entry 的操作不算完成。
- entry kind 只有共用城市用得到的幾種：`workStart`（啟用邊界）、`income`（基本收入）、
  `plan`／`cancel`（建設佇列的預定與取消；舊 `construct`／`complete` 只重播）與
  `activity`（活動合併）。
  舊版的 `achievement` 只重播、不再產生（#28），新的提交一律被拒。收成的資源向量由 entry
  自己帶，所以調整規則不改寫已落帳的結果。
- 每個 writer 的活動寫成一筆 `activity` entry，內容（事件陣列）放在以雜湊命名的
  `blobs/<hash>.json`，**先寫內容再附加 entry**。
- **CAS**：`writeTextFile(path, text, expected)` 的 expected 不符就重讀、重新檢查前提、再試。
- **checkpoint**：`checkpoints/<seq>/` 的索引頁（`ops`／`claims`／`activities`）加之後的 journal
  重播，等於從頭重播；manifest 的內容雜湊記在 `head.json`，對不上就整份丟棄重建。
- 每段有大小上限（預設 256 KiB）；放不下先 CAS 附加封段行，再寫下一段。
- **ack**（§6.2）：`acks/<sessionId>/<epoch>.json`，在 journal 提交成功之後才寫；帳本重播
  不讀 ack，所以 ack 延遲或重播不改變最終狀態。OMP adapter 只在讀到這個 epoch 的 ack 後
  才 compact 已確認的事件。

資料在 `appHome()/data/herdr-reclaim/`：`activity/<sessionId>/<writerEpoch>.json` 是 adapter
寫入的活動檔；新城使用 `shared-v2/`，舊帳本 `shared/` 與 `cities/` 留在原地，不讀也不改。
`quotas.json`（同一個資料目錄）是額度回報檔：內容是 provider 明確回報的額度，
形狀與 `spikes/s5/observed.json` 相同（`omp usage --json --redact` 的輸出：`generatedAt`、
`reports[].fetchedAt`、`reports[].limits[].amount` 與 `window.resetsAt`）。mod 啟動時與每 5 分鐘
自動跑 `omp usage --json --redact --no-extensions` 寫這個檔案（畫面上的「更新額度」可立刻抓）；
額度是帳號層級，所以這個檔與 `quota-attempt.json`（上次嘗試時間）都是全域單一檔案，
不管開幾個視窗、哪個 workspace，每 5 分鐘最多對 provider 查一次（失敗也算一次嘗試）。
mod 不讀任何 provider 憑證；檔案不存在、壞掉、過期，或某個 provider／帳號沒有回報，
畫面就顯示「未知」，不推算成 0 或 100，也不把沒有額度的帳號與已知帳號合併（§9、§15.2）。

OMP extension 是獨立檔 `omp-extension/herdr-reclaim.ts`，日常互動 session 自動寫活動檔；
mod 以 `find` 列活動檔，成功寫 journal 後按 epoch 寫 ack，並用 `watchFolder` 監看新活動。
`NormalizedUsage.sourceKey` 固定為 `cli + sessionId + source entry id`，共用城市用它跨 epoch
去重；child 的用量併入 root，fork 的繼承歷史由 extension 的 session 起點排除。

## 選取狀態（決策）

選取**不寫進帳本**：它不產生資源、不改變土地或 claim，寫進 append-only 的帳本只會讓帳本
多出純 UI 噪音，也讓「帳本重播＝同一座城」的驗證多一個無關變數。改存在
`appHome()/data/herdr-reclaim/ui.json`（設定檔等級、可重建的畫面狀態）：選取的地圖格與開發模式。
重開 herdr 後還原同一個選取；格子已經不在就從沒有選取開始。

## 共用城市的玩法（#23–#27）

規則表在 `core/rules.js`（有版本號 `RULES_VERSION`，每筆 entry 都存當時的版本，§8.2）；
完整規則與數值見 `docs/rules.md`。

- **基本收入**（`ingestIncome`）：每一個已結束的有效工作回合累積 non-cache input + output，
  每滿 10,000 token 收成木 3、石 2、鐵 1；用量來源鍵寫進城級 claim，兩個 space 或恢復對話
  後的新 epoch 重送同一份工作只入帳一次。
- **commit 不另外收成**（#28、ADR 0002）：收入只看工作量。舊帳本裡的 `achievement` 照常
  重播、庫存不變；新版不再讀 `commits/`、`sources/`，也不跑 `git reflog`、`git diff-tree`。
- **建設佇列**（`placePlan`／`ingestIncome`／`cancelPlan`，ADR 0003、0006）：同時最多 3 項預定；
  指定位置**不動庫存**（缺料也能先排），一次只施工最前面那一項，排到隊首、材料備齊才一次付清
  並開工（付款只在隊首，後面的項目不能插隊）。還沒開工的項目可以取消，占地與名額交還。
  每份入庫後推進舊工地，完工揭地，再讓備齊的隊首開工。開工那一份不計工期，沒進帳就不會完工。
- 畫面（`main.js`）：上方是共用庫存、工作進度與佇列最前面那一項；左側是建築卡（占地、配方、
  完工揭開幾格）與佇列摘要；中間是地圖（預定地、工地、完工建築、選址預覽）；右側是整棟
  預覽與「預定這裡」，沒有預覽時是佇列明細（未開工的項目可取消）。

## 跑測試

```sh
bun test mod/herdr-reclaim
```

三層，越前面越便宜：

| 檔案 | 釘住什麼 | 需要視窗 |
| --- | --- | --- |
| `test/*.test.js`（core） | 帳本、規則、命中、額度 | 否 |
| `test/view.test.js` | 畫面上是哪些字、按下按鈕與地圖格之後的狀態、pane 變窄時左右欄寬 | 否 |
| `test/pipeline.test.js` | 真的帳本 → 載入 → 畫面；選建築 → 點合法格 → 預定這裡真的寫進帳本 | 否 |

`test/view-harness.js` 用 `mock.module` 換掉 `gpui-kit`、`gpui-base`、`herdr`，把 render 樹
當資料走（子節點、文字、事件處理器）。事件處理器是普通的函式，呼叫它就等於按下，不用合成
指標事件；檔案 API 換成 node fs，CAS 語意與真的 host 相同（`casConflictOf` 那條接縫）。

哪一層證明什麼、什麼不算完成、為什麼不拿截圖當 gate：`docs/agents/verification.md`。

## 開發迴圈：存檔就重載

herdr 只從自己 home 裡的真實檔案熱重載 mod（symlink 不會），所以開發時同步檔案就好，
不用重開 app：

```sh
tools/dev-sync.sh            # check → rsync 到 ~/.config/herdr-app/mods/herdr-reclaim → 印 status 的錯誤
tools/dev-sync.sh --watch    # 存檔就同步（0.5 秒輪詢，不用多裝 watcher）
tools/install-dev-hook.sh    # 選用：每次 commit 之後自動同步
```

先跑 `check` 才同步：改壞的那一版不會蓋掉正在跑的舊版。要最快就加 `--no-check`。
`--watch` 與 hook 只同步 worktree 現況，不看某一次 commit 的內容；hook 是 opt-in（會動
`.git/hooks`，可能和其他 hook 管理工具搶檔），移除用 `tools/install-dev-hook.sh --remove`。

## 載入與檢查

```sh
herdr-app check mod/herdr-reclaim      # 載入一次並渲染，通過才算沒壞
```

`check` 會在 mod 資料夾寫 `gpui-kit.d.ts`、`herdr.d.ts`、`jsconfig.json`（herdr 自己產生的檔案，
已列在 `.gitignore`）。`check` **不會**排版、也**跑不完非同步鏈**（proposal §15.4）：它會在
`init` 的第一個 await 之後就結束，所以帳本那條路要在真的視窗裡跑一次（見下）。

`check` 期間 `checking()` 為 true，mod 只渲染固定情境，不去動使用者的檔案。

## 視覺報告（人只看這一份）

```sh
tools/ui-report.sh            # 測試＋check＋三個寬度的截圖 → report.html
```

報告裡有 `bun test`、`herdr-app check` 的輸出與預設／加寬／縮窄三張圖。它在**自己的 app home
與自己的 herdr-core**（`XDG_CONFIG_HOME`）裡開一個 space、拉出 mod pane，收尾關 space、關視窗、
停掉那顆 core；不動正在用的 Herdr，也不在別人的 space 開 pane。

截圖失敗（螢幕鎖定、app 起不來）只會讓那一列標成「視覺未驗」，報告照樣產出；`bun test` 或
`check` 失敗才回非 0。像素不是 gate：時間文字、動畫每一輪都不同，圖只給人看排版與截斷。
報告目錄的 `home/data/herdr-reclaim/` 就是那一次的資料：第一次開會出現 `shared-v2/head.json`、
`shared-v2/journal/0.json`、`shared-v2/blobs/*.json`、`shared-v2/acks/*` 與 `ui.json`，**不會**出現舊版的
`cities/`；關掉再開同一份 journal（位元組不變）重建出同一座城。

### 真的要在視窗裡點（少見）

一般驗收不需要：選建築、點合法位置、預定這裡已經由 `test/pipeline.test.js` 在 bun 裡跑完，
而且斷言的是帳本，不是畫面。只有要確認「真實指標事件在這台機器上的行為」時才需要下面這套：

```sh
HERDR_APP_HOME="$H" herdr-app do window.maximize '{}'   # 讓驗證視窗到最前面（再按一次會還原）
HERDR_APP_HOME="$H" herdr-app shot /tmp/v.png           # 截圖像素與視窗點數 1:1
# 用 macOS Vision OCR（VNRecognizeTextRequest，zh-Hant）讀出按鈕文字的位置
# 用 CGEvent 在螢幕座標（視窗原點 + 截圖座標）按下放開
```

- 合成點擊只送到最前面的視窗：動手前先確認驗證視窗在最前面（`window.maximize` 會把它帶到最前面；
  CGWindowList 的第一筆就是最前面那一扇）。
- 沒有 OCR 時用校準代替：選好建築後點地圖任一格，右側詳情會寫出「建築種類 (x, y)」，兩次點擊就能
  解出 3/4 投影的位移量，之後任何一格都能算出像素位置。
- Codex 的 computer use 可以代做這些點擊：`cua.getApp('dev.herdr.app').click([x, y])` 的座標就是截圖像素。
  三件事會讓它看起來「沒反應」：同一個 bundle id 有兩個 Herdr 在跑時只認得到其中一個（隔離
  `HERDR_APP_HOME` 的那扇常拿不到）、Herdr 久沒重開時服務會回 `-10005 cgWindowNotFound`、以及
  它自己讀截圖的文字可能落後一步。重開 Herdr 之後就恢復；成敗一律回到帳本核對，不要只信它讀到的畫面。
- 委託的做法：在自己的 Herdr 裡用 `hc run --bg --name cu26 codex exec … "<任務>"` 開一個 codex pane，
  任務寫清楚座標與「不是這個畫面就停下來回報」。它會動真實滑鼠，記得驗證完 `pane.close` 收乾淨。
