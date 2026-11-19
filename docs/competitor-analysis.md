# herdr layout 競品分析總覽

> **研究日**：2026-11-19。對象為五個公開的 herdr layout。
> **資料來源**：`docs/competitors/` 下五份逐專案報告，由 subagent 讀原始碼後撰寫；本檔只整合結論。
> **查核方式**：stars、forks、授權、最近 push 日期以 GitHub API 抽查，與報告一致；程式碼層級的結論（行號證據）**未由主對話逐條重驗**，引用時請以各報告的證據清單為準。
> **未實機驗證**：五個專案都沒有在本機執行（traveler 只比對已安裝的檔案）。

## 1. 總覽

| | herdr-traveler | world-of-codecraft | herdr-kaiju | herdr-middle-earth | frieren |
|---|---|---|---|---|---|
| 報告 | [herdr-traveler.md](competitors/herdr-traveler.md) | [world-of-codecraft.md](competitors/world-of-codecraft.md) | [herdr-kaiju.md](competitors/herdr-kaiju.md) | [herdr-middle-earth.md](competitors/herdr-middle-earth.md) | [frieren.md](competitors/frieren.md) |
| stars／forks | 43／0 | 23／5 | 1／2 | 3／0 | 11／1 |
| 授權 | Apache-2.0；**圖片另計，不在授權內** | 程式與美術 MIT、字型 OFL（`LICENSE` 全文）；GitHub 欄位顯示 NOASSERTION | MIT；字型 OFL | MIT；字型 LPPL | GitHub 無授權欄；NOTICE 混合 Apache-2.0、OFL |
| 最近 push | 2026-11-16 | 2026-11-08 | 2026-11-03 | 2026-11-18 | 2026-11-17 |
| 對應 herdr | 0.1.11（宣稱 0.1.12 通過） | 未查到版本 pin | 只驗證 0.1.11，macOS | 0.1.16 | 0.1.11，部分 mod 0.1.16 |
| 主題 | 暮色像素 RPG | 高奇幻村莊（等角像素） | 怪獸拆樓（等角像素） | 魔戒遠征隊 | 葬送的芙莉蓮 |
| 形式 | clone 三個內建 mod + 自製 mod | 單一 mod，接管整個 layout | 單一 mod（約 1,046 行 JS） | clone 四個內建 mod | 19 個 mod，兩個 layout |
| 空間 | 無地圖；space＝建築圖示 | 固定村莊，3000×400 | 固定 8 棟樓 | 無地圖；space＝國度徽章 | 無地圖；space＝8 張場景圖 |
| 角色身分鍵 | tab 名稱（`jobs.json`） | terminal 位址雜湊＋程式種類 | terminal 位址 | terminal 位址 | tab／terminal 位址 |
| 狀態來源 | herdr `agents()` | herdr `agents()` ＋ 選配 hook | herdr `agents()` | herdr `agents()` | herdr `agents()` ＋ 畫面抽樣 |
| model／用量 | statusline 腳本（Claude）、launchd 腳本（Codex／OpenCode） | Claude hook／OpenCode plugin 的活動檔 | **無** | `hc read` 讀終端畫面再用正規表達式 | provider 額度 API／本機資料庫 |
| 額度 | Claude 5 小時剩餘％ | 兩個 Claude 帳號的剩餘額度（cduo 檔，需自備） | 無 | 無 | **最完整**：5h／weekly、credits、reset 時間 |
| 跨 session 累積 | 無 | 戰報：保存 ≤40、畫面顯示 4（`localStorage`） | 4 把 `shared()` 鍵，會被 prune | 角色與領地指派（`shared.json`） | session 清單、交接文件、配對紀錄 |
| 成果／產出 | Inbox 開檔，不驗收 | 無（打怪＝工具成功次數） | 無 | 無 | 最近檔案列表、交接文件；不驗收 |
| 美術 | 8 角色 × 3 狀態、102 張 PNG 影格 | 30 個種族×職業精靈，離線烘焙 | 355 個檔，程序繪製＋AI 動作表 | 105 個程式產生的 SVG | 像素角色與場景圖；角色為既有 IP，素材不視為可再散布 |
| 平台 | 未明載（RECIPE 用 macOS 的 `defaults` 讀語言，並有 `LANG` 後備） | 未查到 | macOS | 作者自述只測 macOS | **Windows**；macOS 在未合併 PR |

## 2. 橫向觀察

### 2.1 沒有任何一個專案做「跨 session 的成果累積」

- 五個專案的持久化都屬於身分指派、介面偏好或 session 目錄；沒有「成果驗收 → 資源 → 建築」的帳本。
- 最接近的是 world-of-codecraft 的戰報（40 筆、不保存 session ID、不保存成果）與 frieren 的 session 登記與交接文件（為了接續工作，不是為了回看成果）。
- 沒有任何專案做到 claim key 防重複領取、不可變收成快照或 active interval。
- 因此 v6 的差異化——**可回看的工作史**——目前沒有直接競爭者。這是 2026-11-19 的快照；五個專案距最近一次 push 為 1 到 16 天，其中 middle-earth 昨天仍在更新，不能假定空白會一直在。

### 2.2 身分幾乎都綁 terminal 位址或 tab

- kaiju、middle-earth、frieren 與 world-of-codecraft 都以 terminal 位址（或其雜湊）當角色身分；traveler 用 tab 名稱。
- 後果有報告為證：
  - kaiju 的指派表會 prune 不在名單的鍵，重開就換怪獸。
  - traveler 的快取只保留最後快照，補不回 app 關閉期間的 visit。
  - 沒有任何專案處理 `/resume`、`/move` 或 subagent 歸戶。
- v6 以 `(cityId, rootSessionId)` 為身分，是對的方向；代價是每個 CLI 都要有 adapter。這點只有 traveler 與 world-of-codecraft 部分做到（各自的 hook／腳本），且都不是 session 層級。

### 2.3 資料取得有三種路線，可靠度依序遞減

| 路線 | 採用者 | 風險 |
|---|---|---|
| CLI 的 hook／extension | world-of-codecraft、traveler（statusline）、v6 | 每個 CLI 要各自寫；但輸出是結構化資料 |
| 讀 CLI 的私有檔案或資料庫 | traveler（Codex rollout、OpenCode DB）、frieren（Codex SQLite、Claude 桌面 metadata） | 會讀到完整對話或憑證；格式改版就壞 |
| 螢幕爬取 | middle-earth（`hc read` 每 15 秒）、frieren（1.5 秒畫面抽樣） | 輸出文字一改就壞；漏事件；不能當帳本 |

v6 的 adapter 路線是三者中最穩的。frieren 的報告明確指出畫面抽樣有 30 秒 session 盲點，不適合決定土地或資源。

### 2.4 額度：frieren 最完整，其餘都是單點數字

- frieren 有 `checked／stale／login_needed／retry_at／reset time` 的狀態模型，推薦帳號時排除 stale 資料；來源是各 provider 帳號的真實額度。
- traveler 只有 Claude 5 小時剩餘百分比，缺資料顯示 `—`，且不估算。
- world-of-codecraft 的「金、木」是使用者自備 cduo 檔的剩餘額度，沒有檔案就不畫。
- kaiju、middle-earth 完全沒有用量或額度。
- 共同限制：**額度是帳號層級，同一帳號的多個 pane 共用一份**，沒有任何專案能算出單一 session 的消耗。這與 v6 的決定一致：額度只顯示，不拿來產生資源。

### 2.5 美術與動畫：能離線算的都離線算

- kaiju：生成期算好站位、深度區間與命中框，寫進 manifest，前端只排序與畫圖。
- world-of-codecraft：離線烘焙 voxel／等角圖，前景切片處理遮擋；提供動畫開關。
- traveler：影格 PNG 加 delay table，單一 timer 排下一次換幀，視窗不在前景就停。
- middle-earth：圖是程式裡的字元網格，由產生器輸出 SVG；兩張圖用 opacity 做硬切換。
- 授權風險普遍：traveler 的圖片不在 Apache 授權內；frieren 用 IP 素材且不可視為可再散布；middle-earth 的 MP3 來源與角色原創性未查到；world-of-codecraft 的 AI 素材權利鏈未確認。v6 用抽象名稱加自製 mock 圖，這一點比所有競品乾淨。

### 2.6 安裝與隱私

| 專案 | 安裝的禮貌程度 | 隱私面 |
|---|---|---|
| kaiju | 最好：只複製自己的檔案、`keys.json` 先問先備份、可完整卸載 | 不連網、不執行外部程式 |
| middle-earth | 備份 → 複製 → `herdr-app check` → 切 layout | 會改使用者全域 `settings.json`／`programs.json`，只備份不還原 |
| traveler | 手動複製；有更新時覆寫 `jobs.json` 的警告 | Codex／OpenCode 腳本讀完整對話檔與含憑證的資料庫 |
| world-of-codecraft | `install.sh`，真實檔案不用 symlink | 只讀自己的活動檔與選配的額度檔 |
| frieren | 複製加合併 keys，名稱衝突會阻擋 | **讀登入憑證與行程環境**；剪貼簿；會呼叫官方 importer 與 CLI |

### 2.7 成熟度

- 全部都是 2026-11 初才出現的新專案，commit 數 11 到 28 個；kaiju 的 18 個 commit 全在 2026-11-03 一天內完成。
- 只有 middle-earth 確認有自動測試（`node --test`）；kaiju 只有人工「Done when」清單；其他報告未提及測試。五個專案都沒有查到 CI。
- 版本相容性：traveler、kaiju 停在 0.1.11；middle-earth 全面標 0.1.16；frieren 部分 mod 標 0.1.16；world-of-codecraft 沒有標版本。本機是 0.1.16。

## 3. 對 v6 的影響

### 3.1 已被競品證實的方向

1. **adapter／extension 優於爬畫面**（§6）。frieren 與 middle-earth 的爬取做法各有明列的盲點。
2. **身分不能綁 terminal 位址或 tab**（§5.2、§6）。kaiju 的 prune 行為是反面教材。
3. **額度不產生資源**（§9）。同帳號共用一份，無法歸戶到單一 session。
4. **不要 clone 內建 mod**（§2.2）。traveler、middle-earth 的 clone 都鎖死在特定 herdr 版本，升版需重新比對。
5. **成果驗收與 claim key 是空白地帶**（§7、§8）。

### 3.2 建議借用的具體做法

| 來源 | 做法 | 對應 v6 |
|---|---|---|
| kaiju | 狀態→演出的完整對照表（動作、表情、氣泡、警示燈）；v6 的「預留／探索中／駐紮／可收成／已開墾／已建」也各寫死一組外觀 | §5.1、§14 |
| kaiju | 站位、深度、命中框在生成期算好，執行期只排序與畫圖 | §4（地面格為準）、S4 |
| kaiju | 晝夜以主題 `background` 亮度判斷，不讀 `settings.json` | 若做夜間美術 |
| kaiju | `install.sh`：只動自己的檔案、先問先備份、可卸載 | `tools/install.sh` |
| middle-earth | `install.sh` 三段式（備份、複製、`herdr-app check`）與 RECIPE 的「Watch out」清單 | 安裝與驗收文件 |
| middle-earth | 在 `terminals()`／`spaces()` 非空時才 prune；避免啟動瞬間資料尚未載入就清掉紀錄 | `/resume`、`/move` 與離線重播 |
| middle-earth | 素材用「字元網格＋產生器＋斷言」，美術規則可執行檢查；機率與解析函式抽成模組並用 `node --test` | §14 mock 素材、規則表測試 |
| traveler | 讀取端與寫入端解耦：mod 只讀小 JSON，不直接解析 CLI 私有資料 | §6.1 adapter 格式 |
| traveler | 動畫＝影格圖＋delay table＋單一共用 timer，視窗不在前景即停 | 若日後做動畫 |
| traveler | 缺值顯示 `—`、過期標 `old`，絕不估算 | §9、S5 |
| world-of-codecraft | anti-zapping：候選穩定時間加最短停留時間，只平滑演出，不延遲真實事件 | 狀態外觀切換 |
| world-of-codecraft | 動畫開關要一致 gated；關閉不能停止必要的資料記帳 | 設定 |
| world-of-codecraft | 同一 layout 內用 `layout.show／hide／resize` 切換終端與地圖 | §2.2 地圖 tab |
| frieren | 額度的 capability 狀態模型（checked、stale、login_needed、retry_at） | S5 |
| frieren | reset pass 這類不可逆操作要二次確認 | 撤回、消耗羊皮卷 |
| frieren | 明確 cursor 加版本的增量游標，但不取代帳本 CAS | §13 usage 游標 |

### 3.3 應避免的坑

- **把狀態當帳本**：kaiju 的損壞等級是記憶體 Map，離開即刪。v6 的收成快照與 interval 必須不可變、可重播。
- **在 render 路徑做重事**：kaiju 每次 render 都呼叫更新函式。v6 的 git 掃描與 CAS 只能在明確的收成動作裡。
- **固定格數**：kaiju 固定 8 個樓位、world-of-codecraft 綁 3000×400 座標。v6 聲明無限平面，邏輯座標與投影必須真的分離。
- **把 localStorage 當資料庫**：per-copy 且換 layout 會漂移（middle-earth、world-of-codecraft 的戰報）。v6 的投入計量落地在 ledger。
- **覆寫使用者全域設定而沒有還原路徑**：middle-earth。
- **字串硬編碼**：kaiju 的中文字串散在五個檔案，社群英文 PR 因此無法合併。v6 一開始就抽字串表。
- **宣稱停掉動畫就是停掉所有背景工作**：traveler 的資料 timer、watcher、git 輪詢仍在跑。v6 的效能預算要分開量測。
- **把 git 改動列表或最近檔案當成果**：frieren 的 Results 按 mtime 排序，不分 session 貢獻、不防重複。v6 仍需 baseline、claim key 與人工驗收。

### 3.4 提案需要修正的地方

1. `docs/proposal.md` §2.1 寫 world-of-codecraft「只有 4 筆事件紀錄」。實際是**畫面顯示 4 筆、保存最多 40 筆**，且不保存 session ID 與成果。已更正。
2. 本提案沒有明確比較「嵌入式單一 mod」與「接管整個 layout」的取捨。五個競品除 kaiju 外都是整個 layout 或多個 mod；v6 的優勢是可放進任一 layout，但代價是不能控制整體視覺。這個取捨已在 §2.2 提到，建議在 §2.1 補一行。

## 4. 風險與不確定

- **差異化窗口**：這些專案在 17 天內從無到有，各自還在更新。「沒有人做成果累積」只在今天成立。
- **功能與執行未驗證**：報告記錄的是文件宣稱與原始碼閱讀，沒有任何一個在本機實跑；效能（例如 world-of-codecraft 自述動畫約 27% CPU）也是作者數字。
- **授權權利鏈**：各專案的圖片、字型、音效是否可再散布多半未確認。v6 不從任何競品複製素材。
- **三份報告的取得過程**：frieren、traveler、world-of-codecraft 的第一輪研究因 subagent 後端回錯誤而中斷，後來由另一條模型路線重做；內容以最終報告為準。

## 5. 文件索引

| 檔案 | 內容 |
|---|---|
| [competitors/herdr-traveler.md](competitors/herdr-traveler.md) | 含本機已安裝版本的交叉驗證 |
| [competitors/world-of-codecraft.md](competitors/world-of-codecraft.md) | activity hook 欄位、anti-zapping、額度來源、美術管線 |
| [competitors/herdr-kaiju.md](competitors/herdr-kaiju.md) | 狀態→演出對照、生成期空間資料 |
| [competitors/herdr-middle-earth.md](competitors/herdr-middle-earth.md) | 內建 mod clone 差異、螢幕爬取、素材產生器 |
| [competitors/frieren.md](competitors/frieren.md) | 多帳號額度、session 接續、憑證讀取 |
