# 競品分析：Frieren（Frieren Pixel／Frieren Journey）

> 研究對象：[CHO-kr/frieren](https://github.com/CHO-kr/frieren)，`main`，commit [`80a3ff4ae07cd156a059c41f761e4b1104aeb47c`](https://github.com/CHO-kr/frieren/commit/80a3ff4ae07cd156a059c41f761e4b1104aeb47c)。查閱日期：2026-11-19。
> 方法：唯讀查閱 `/tmp/frieren-research` 原始碼、文件、預覽圖片、Git 歷史與 GitHub API；未安裝、未執行專案腳本／mod／測試，未切換 layout，未改動本機 herdr 設定。下列相對路徑與行號均指此 commit，可在 [固定版本檔案樹](https://github.com/CHO-kr/frieren/tree/80a3ff4ae07cd156a059c41f761e4b1104aeb47c) 查閱。推論標記為 `[INFERENCE]`。

## 1. 基本資訊

| 項目 | 查得結果與證據 |
|---|---|
| Repo／作者 | `CHO-kr/frieren`；擁有者 CHO-kr。Git 歷史署名有 CHO-kr、lukecho92-netizen，未確認是否同一人。[GitHub API](https://api.github.com/repos/CHO-kr/frieren)、`git log --format='%H\|%aI\|%an\|%s'` |
| Stars／forks／issues | **11 stars、1 fork；open_issues_count=1，但該筆是未合併 PR #1，並非一般 issue**。API 回傳的全部 issue 項目只有它。[Repo API](https://api.github.com/repos/CHO-kr/frieren)、[issues API](https://api.github.com/repos/CHO-kr/frieren/issues?state=all&per_page=100) |
| 首次 commit | `7a2fd38`，2026-11-02 22:48:10 +09:00；本次 Git log 共 16 筆，未見 shallow 邊界檔。證據：上述 Git log |
| 最近 commit | `80a3ff4`，2026-11-17 14:35:23 +09:00，增加 Codex 壓縮 transcript 的 space 分類支援。證據：Git log；API `pushed_at=2026-11-17T05:35:25Z` |
| 授權 | **不能把整個 repo 概括成 Apache-2.0**：GitHub `license=null`，`NOTICE:3-23` 指定 traveler／herdr 衍生 mods 的 Apache-2.0 歸屬，Galmuri 為 OFL 1.1；圖片明確不在 Apache 授權內。新增工具程式的獨立、全 repo 統一授權未查到。`README.md:535-566`、`NOTICE` |
| 對應 herdr 版本 | Journey layout／衍生 mod 標示來源 **0.1.11**；`pixel-new-menu/mod.json:2-6` 標示 clone 自 **0.1.16**。這是來源版本，不等於完整相容性保證；README 未給一致的最低／已驗證版本。查對本機 0.1.16 `herdr.d.ts` 可找到使用的 API，但未實測 Windows 執行。 |
| 平台／語言 | main 明示 **Windows 10/11、PowerShell 5.1、Python 3.10+**，UI 英文。JS（gpui-kit）、Python、PowerShell、JSON，另有生成用 NumPy 資料、TTF、PNG／JPG／SVG。`README.md:280-295` |
| 主要檔案規模 | 19 個 mods；layout 約 7.2 KB（Pixel）、4.9 KB（Journey）；`pixel-party/main.js` 317 行、`lib.js` 348 行；`pixel-pane/plan.js` 1,248 行；`herdr-sessions/list.py` 592 行、`spaces.py` 285 行；`usage-gauge/usage.py` 245 行、`reset.py` 80 行；`session-menu/bridge.py` 385 行。證據：檔案讀取行號與目錄大小，非執行結果。 |

**跨平台狀態不要混淆**：[PR #1「Add macOS support」](https://github.com/CHO-kr/frieren/pull/1) 仍 open、`merged_at=null`。PR 作者宣稱在 Apple Silicon／herdr 0.1.16 測過 Pixel，並提出 POSIX helper、字型分層等修改；**這不是本次 main 已有的能力，也不是本研究實測**。

## 2. 一句話定位與主題

**把 Windows 上 Claude／Codex 多帳號、桌面 app 與 herdr session 整合成同一個工作台，再用《葬送的芙莉蓮》隊伍演出目前工作狀態。** Journey 是肖像、金框與半透明桌布；Pixel 是像素角色、戰鬥舞台與每小時換景。核心實用價值是 session 接續與額度調度，不是土地、產出或城鎮累積。證據：`README.md:3-37`；`layouts/frieren-{journey,pixel}.json`；`pixel-pane/plan.js:1242-1248`。

## 3. 功能清單（文件宣稱／程式確認）

| 文件宣稱 | 程式確認與界線 |
|---|---|
| 桌面 app 與 Herdr sessions 三張清單，可關閉 tab 後再接續 | 有。Claude 桌面 metadata、Codex SQLite、Herdr 行程偵測分三路，再用 `derived.json` 去重／分流。不是所有來源無條件全部納入：Codex 排除 archived、非 user thread；Claude 桌面列需 `cliSessionId`。`README.md:9-22,231-264`；`claude-sessions/list.ps1:63-75`、`codex-sessions/list.py:74-80`、`herdr-sessions/list.py:484-581` |
| 切帳號、複製 session、Claude↔Codex 交接、搜尋 | 有。選單以 `tab/focus/confirm/toCodex/toClaude/hide/assign/resetPass` action 分派；bridge 保存配對與增量交接文件。搜尋把 request 交還原清單處理，沒有另一套 resume 路徑。`session-menu/main.js:1-14,51-140`、`bridge.py:303-379`、`session-search/main.js:130-136` |
| 額度、重置時間、Codex credits／reset pass、推薦最有餘額帳號 | 有，來自登入帳號的 provider 額度，而非 token 自行推算。5 分鐘輪詢；失敗保留 stale、尊重 429 `Retry-After`；推薦排除 stale／登入失敗／超過 30 分鐘的資料。`usage-gauge/usage.py:75-100,129-181,190-245`、`main.js:73-79`、`roomiest.js:7-44` |
| 16 角色、讀取工具活動、三波戰鬥、必殺技、營地、勝利 | 有 16 筆 roster、15 類活動分類、四人舞台與最多兩名召喚盟友；`pixel.activity` 確實由 party 產生、pane 消費，再送入 planner 的 switch。戰鬥傷害／SP／寶箱是演出，沒有成果驗收。`pixel-party/lib.js:5-22,129-196,208-225`、`pixel-party/main.js:81-110`、`pixel-pane/main.js:42-44,208-245`、`plan.js:34-38,832-852,1242-1248` |
| HP／MP 是剩餘額度 | 有：HP=短週期（如 5h）、MP=weekly 或較長週期的 `100-used`；沒有相應窗口就顯示 `—`。**同帳號的不同 agent 共用同一額度，不是每個 session 的獨立消耗**。`pixel-party/main.js:157-171`、`lib.js:325-337` |
| 每小時換景、可點選跳下一景、配色跟著變 | 有，但不是純暫態 UI：用 `writeTextFile(file,next,text)` 改當前 layout JSON 的背景、colors／框線／漸層。自訂非內建背景會停止輪替。`pixel-chrome/main.js:36-68,98-133` |
| 結果縮圖、預覽、附加給 agent、智慧貼上 | 有：掃 focused cwd、Pillow 圖片縮圖、ffmpeg 影片海報；附加檔案透過 Windows clipboard 再 `terminal.paste`。截圖貼上會落地 PNG。`results-panel/recent.py:1-158`、`main.js:49-58,114,158`；`smart-paste/clip.py:13-44` |

**文件需要收斂解讀的地方**：

- 「每個 agent」的角色其實以 **tab／terminal address** 配置，不以 CLI session ID 配置；「每個 subagent 一名盟友」實際是從畫面文字推得數量，沒有真實 child 身分連線（§5）。
- README 的「Nothing writes to Claude's or Codex's own files」（`:477-479`）適合描述直接讀檔的 collector，不能延伸成整套工作台沒有寫入副作用：`bridge.py:198-242` 會請 Codex 官方 importer 建 thread，resume／fork 也會啟動 CLI，reset pass 更會改帳號額度。
- README「Nothing else goes out」（`:470-474`）是作者宣稱，不是流量稽核結論；跨 provider 交接會把原對話交給另一個 agent，Remote Control 使 session 可由 Claude 帳號遠端連線，remote space 的 git 查詢也可在另一台 machine 執行（§8）。
- `RECIPE.md:412-415` 的驗收段仍寫「thirteen mod folders」，README 與目錄則為 **19**；不要據此少裝依賴。

## 4. 架構

### Layout 節點樹

以下是程式中實際配置的摘要，不是 Web DOM（`layouts/frieren-pixel.json:1-213`、`frieren-journey.json:1-179`）：

- **Pixel root：row**，padding／gap 8、Galmuri11、terminal opacity 0.55。
  - sidebar：292px（最小 64、最大 480）。
    - brand：52px，`pixel-chrome`。
    - sidebar-lists：`pixel-spaces`、`pixel-party`、`herdr-sessions`、`claude-sessions`、`codex-sessions`。
    - footer：64px，`pixel-chrome {footer:true}`。
  - work：column。
    - topbar：56px；`usage-gauge` 與 `pixel-tabs` 權重 1:1.3；0px `smart-paste`。
    - stage：80px；`pixel-pane {stage:true}`。
    - work-body：active tab；每 pane 的 30px header 使用 `pixel-pane`；隱藏的 Files／Changes stack 368px、Results 400px。
- **Journey**：sidebar 268px（最小 44）、brand 46px、footer 69px，使用四個 `journey-*`；topbar 58px，usage 固定 818px；pane header 用 `pane-account`，**沒有獨立戰鬥 stage**；terminal opacity 0.4。

### Mod 清單與職責

| 組別 | Mods／職責 | 證據 |
|---|---|---|
| 共用工具 9 | `usage-gauge` 額度；`herdr-sessions` 本機 Herdr session 偵測與 space 分類；`claude-sessions`／`codex-sessions` 桌面歷史；`session-menu` 操作／確認／交接；`session-search` 搜尋；`pane-account` 帳號 model header；`results-panel` 檔案縮圖；`smart-paste` 剪貼簿 | `README.md:360-363,511-529`；上述各 `main.js`、helper |
| Journey 4 | `journey-chrome` 品牌／天數／設定；`journey-spaces` 地點＋git 摘要；`journey-party` 肖像卡／額度；`journey-tabs` 頭像 tabs／視窗按鈕 | `NOTICE:3-13`、`RECIPE.md:33-110`、Journey layout |
| Pixel 6 | `pixel-chrome` 字型／配色／換景；`pixel-spaces` 像素地點；`pixel-party` 卡片與畫面觀測；`pixel-tabs` 頭像 tabs／自動顯示名稱；`pixel-pane` header＋戰鬥；`pixel-new-menu` 各帳號啟動列 | `NOTICE:15-18`、`README.md:184-213,360-363`、Pixel layout |

Pixel 仍依賴 `journey-party/jobs.json`、`journey-spaces/places.json`、`pane-account/who.py`，不能只複製 `pixel-*`。另外使用 herdr 內建 `files`／`changes`／選單等 mods 與圖示（layout、`session-menu/main.js:146`）。

### 使用的 herdr API（實際 import）

`agents`、`panes`、`spaces`、`terminals`、`machines`、`focused`、`knownAgents`、`setAgentOrder`；`theme`、`layout`、`window`、`settings`、`updates`、`props`；`appHome`、`home`、`readTextFile`、`writeTextFile`、`watchFolder`；`shared`、`setShared`、`nextCommand`；`exec`、`hc`、`run`、`notify`、`openOverlay`、`closeOverlay`、`checking`、`keys`。證據：各 `mods/*/main.js` 的 import，尤其 `pixel-party/main.js:13`、`pixel-pane/main.js:15`、`pixel-chrome/main.js:8`、`pixel-spaces/main.js:11`、`pixel-new-menu/main.js:5`、`session-menu/main.js:17`。

本機 `~/.config/herdr-app/herdr.d.ts` 可核對檔案／程序 API（`:14-38`）、agent／pane／terminal（`:169-247`）、overlay／共享狀態／命令／watch（`:390-490`）；`shared` 明定持久化。UI 用 gpui-kit 的 `View/div/image/svg`、原生 `.frames()`，沒有 HTML／CSS／WebGL。

### 資料流與外部程式

1. JS `exec` → Python／PowerShell helper → stdout JSON＋本機 cache → `shared(...)`／列表。
2. `agents()/panes()`＋`hc read` → `pixel.activity[address]` → pane header／battle planner → 原生字型影格。
3. `usage.py` → Anthropic OAuth endpoints／Codex app-server → `usage.json` → HP／MP、topbar、帳號推薦。
4. Session action → `session-menu` → `tab.new/pane.focus/space.new` 或 `bridge.py/reset.py`。這些 action 在消費端都有分派，不只是按鈕示意。

外部依賴含 `python`、`powershell(.exe)`、`hc`、`codex.exe app-server`、Claude／Codex CLI、`git`、`explorer.exe`，選用 Pillow／ffmpeg／zstandard。證據：`session-menu/main.js:51-140`、`usage.py:129-181`、`pixel-party/main.js:81-147`、`results-panel/main.js:49-58`、`README.md:280-295`。

## 5. Agent／session 處理

### 身分、狀態、model、effort

| 面向 | 實作與限制 |
|---|---|
| Agent 類型 | 以 herdr 回報的 `app/program.key`、argv 與 Windows `claude.exe/codex.exe` 判斷。額度／帳號支援限 Claude／Codex；不是通用 OMP adapter。`pixel-party/main.js:45,127-171`、`lib.js:202,300-310` |
| 狀態 | 已回報 agent 用 herdr `working/blocked/done/idle`；未在 `agents()` 的 Claude／Codex pane 讀畫面，權限問題→blocked、spinner／esc to interrupt→working、其餘 idle。後者**不推得 done**。`pixel-party/main.js:23-31,81-110`、`lib.js:197-202` |
| 工具活動 | 每 1.5 秒讀 working agent 與 unreported pane；分類最後 80 行，辨識 Claude／Codex 英文工具輸出，再分類 test/build/git/install/delete/read/search/write/plan/wait/web/media/summon 等。失敗可沿用前值或 think，不是可靠的事件流。`main.js:75-110`、`lib.js:117-196` |
| 帳號 | 先解析 terminal argv 的 `claudeN/codexN(.cmd/.exe)`；手動在 shell 啟動時 `who.py` 走行程樹、讀 PEB 的環境與命令列取得 `CLAUDE_CONFIG_DIR/CODEX_HOME`，約 2 分鐘快取。`lib.js:300-310`、`main.js:127-171`、`pane-account/who.py:83-139` |
| Model | argv `--model/-m` 優先，其次行程旗標、resumed session metadata、Claude 帳號 settings。Codex 額外讀 `models_cache.json/config.toml`，跨帳號可選硬編碼偏好中的可用模型。**不是持續觀測 CLI 內 `/model` 切換的通用介面**。`pixel-party/main.js:157-171`、`codex-sessions/list.py:14-40` |
| Effort | Claude 桌面 metadata 有 `effort`，resume argv 保留 `--effort`；Codex SQLite 讀 `reasoning_effort`，列表 tooltip 顯示。Party／pane chip 沒有獨立 effort 顯示。`claude-sessions/list.ps1:29-42`、`main.js:112-119`；`codex-sessions/list.py:74-97`、`main.js:313` |
| 用量／額度 | 實作重點是**帳號窗口百分比、credits、reset pass**；未查到按 session 累計 input/output/cache token、API 等值成本或 active interval。`usage.py:75-100,129-181`；對 runtime JS／Python／PS1 的 token／cost／activeInterval 搜尋 |
| Hook／extension | 不靠自訂 CLI hook／extension；依賴 herdr 狀態與外部 helper 掃描本機資料／畫面。這省去安裝 extension，代價是依賴 CLI 私有檔案 schema、輸出格式與 Windows 行程 API。`herdr-sessions/list.py:81-191,369-437`、`pixel-party/main.js:81-110` |

### 三張 session 列表如何建立

- **Claude 桌面列表**：讀 `%LOCALAPPDATA%\Claude-Data\claude_*\claude-code-sessions\*\*\local_*.json`；按 size／mtime 快取 title/cwd/model/effort/permission 等欄位；用 `~/.claude/projects/*/*.jsonl` 的檔名對 `cliSessionId`，再以 `Win32_Process` 的 `--resume` 與 `Claude-Data` 判斷仍在 app 開啟。合併 bridge 配對與 derived rows。`claude-sessions/list.ps1:9-75,77-128`。
- **Codex 列表**：以 `mode=ro` 讀目前 Codex home 的 `state_5.sqlite/threads`，只列 `archived=0`、source 為 cli/vscode、thread_source 為 user／null；讀 `<home>/.codex-global-state.json` pins，測試 `thread-writer-locks/<id>.lock` 得到 open；合併其他帳號 derived rows。`codex-sessions/list.py:54-151`。
- **Herdr 列表**：30 秒跑一次 `list.py`；`hc ls/get` 篩帶 `herdr.space` label 的 live terminal，再找後代行程。Claude 用 `<account>/sessions/<pid>.json` 的 interactive `sessionId`；Codex 用 Windows Restart Manager 找 lock holder，若 shared daemon 持鎖則改用 cwd／title／開始時間／前次綁定加權配對。`herdr-sessions/main.js:183-204`、`list.py:81-191,353-437`。
- 登錄鍵是 `claude:<sessionId>`／`codex:<threadId>`；`root` 欄位保存的是**來源分類** `herdr/desktop/outside`，不是 v6 的 root agent。Fork 沿來源分類；desktop／outside 與其副本回流到原 provider 清單，Herdr 新開的才留 Herdr 清單。`list.py:511-581`。
- 選用 `spaces.json` 時讀三份列表 cache 與 transcript：只計使用者／assistant 文字，title 命中 ×10、space weight 加權、既有 space／folder 加分；字數不足時 folder 決定，手動 assignment 優先。每分鐘重算；`.jsonl.zst` 需 zstandard，否則只用 title／folder。這是**文字分類的目的地**，不是 canonical repo city。`spaces.py:90-156,189-221,244-280`、`session-menu/main.js:19-29,57-64`。

### Pixel party 如何對應 agent

`entriesFor()` 先排有 agent 的 tabs，再 shell tabs，最後同一 tab 的第二個以後 agent；第一個用 `tab:<tabId>`，額外 agent 用 `agent:<terminalAddress>`。`settle()` 先套 `jobs.json`／角色同名 tab，再保留舊指派，再從 16 角色中取下一個；超過 16 循環。結果存 `shared("journey.party")`，兩種 layout 共用。`pixel-party/lib.js:239-293`、`main.js:277-289`。

舞台另外依目前 tab 的 pane 排序，最多 4 人，盡量保留 focused pane；重複角色改選尚未使用者。因此它是 **pane 的即時隊伍**，不是穩定 session 的隊伍。`lib.js:208-225`。`[INFERENCE]` 相同 session 在新 tab resume 不保證拿回原角色，因為 key 已變；消失的 entry 也不保留在新 picks。

| 情境 | 支援範圍 |
|---|---|
| `/new` | 下一輪掃描若看到新的 session ID 就可登錄；**沒有直接訂閱 `/new` 事件**。30 秒內開完又關的 session 可漏掉，作者也明說。`list.py:369-383`、`README.md:490-491` |
| `/resume` | 明確支援：Claude 按 transcript path、Codex 按 thread ID；已開啟時 focus 現有 pane，否則新 tab；可選帳號／fork，衝突可先確認。`herdr-sessions/main.js:123-148,244-271`、`claude-sessions/main.js:112-126,211-241`、`codex-sessions/main.js:114-136,218-247` |
| `/move`／cwd 移動 | **未查到 v6 那種 visit 分界、舊 city 駐紮、工時與用量截點**。Space assignment 只是清單分類；文件中的「move／handover」是 Claude↔Codex 對話交接，不是 OMP `/move`。`session-menu/main.js:57-64,123-140`、`bridge.py:303-379` |
| Subagent | 會把畫面中的 Agent／Task／Explore 類成 summon，從 count 產生最多兩名額外角色；沒有 child ID／parentSessionId／用量歸戶。Claude discovery 限 interactive，Codex 列表限 user thread；交接還略過 isSidechain/isMeta。`lib.js:130,179-180`、`plan.js:121-138`、`list.py:380`、`bridge.py:258-259` |
| 多 machine | Space UI 有 machine 分組、遠端 git `exec(...,{on})`，但 session collectors 讀本機 `%LOCALAPPDATA%`、本機行程與 DB；party 的帳號補查跳過含 `/` 的遠端 address。不能由 UI 有 Add machine 推論跨機 session／額度已支援。`pixel-spaces/main.js:188-240,268-305`、`herdr-sessions/list.py:81-91`、`pixel-party/main.js:129-132` |

## 6. 視覺與美術

- **風格**：預覽圖可確認 Pixel 為深藍底、奶油色方框、像素字型、上方橫向戰鬥；Journey 為動畫肖像、金框、半透明大桌布。實際預覽：`layouts/frieren-{pixel,journey}.png`；透明度與尺寸取自 JSON，不從圖片猜測。
- **已核對的核心素材數量**：16 角色（16 個 `spr/*.npz`、16 張 faces、16 支角色 TTF）；另 4 支特效／怪物／道具／必殺 TTF，共 **20 支 FrierenDot5 字型**；7 張 Pixel 背景、7 張 stage strip、14 張場景 backdrop＋2 張基底 backdrop、8 張 pixel-space 地點圖。另有 Journey 壁紙／肖像／8 地點圖與 Galmuri UI 字型；**這不是全 repo 圖片總數**。證據：`mods/pixel-party/{fonts,faces,build/spr,scenes,backdrops}`、`mods/pixel-spaces/art`、`backgrounds` 目錄清單與 `lib.js:5-22`。
- **製作管線**：文件說明角色／怪物 pose sheet 用 OpenAI image generation（經 Codex）生成，切格、對齊、存 npz，再由 `anim.py/stage_art.py/special_art.py` 產生 COLRv0 彩色字型；圖像生成原始 sheets 有些不在 repo，已有 cut sprites 可重建。背景先縮至像素網格與調色盤，stage 切背景 strip。這是文件／build guide 的管線說明，本研究未重建。`README.md:543-562`、`mods/pixel-party/build/README.txt:1-43`。
- **動畫**：一個字元對應一影格，角色圖用 `.font_family(...).frames(list,ms)`；32 高美術像素放大 2×。戰鬥以共同 90ms step 的絕對定位 glyph boxes 同步怪物、攻擊、數字與 log，kind switch 已覆蓋 15 類與 default normal attack。`pixel-party/main.js:48-53`、`lib.js:31-58`、`pixel-pane/plan.js:28-38,832-852`、`pixel-pane/main.js:243-268`。
- **效能做法與成本**：battle plan 離開 render，150ms timer 只處理待計算 job；活動只因種類改變時至少隔 60 秒才 replan，近 5 分鐘活動供輪播。角色動畫交給原生 frames，但觀測仍每 1.5 秒執行 `hc read`，帳號／session／git 各有輪詢；不能宣稱整套「idle 零成本」。`pixel-pane/main.js:24-26,46-83,216-241`、`pixel-party/main.js:73-110`。
- **授權風險**：README 明確說角色屬原權利人、圖片非作者原創且不受 repo 授權涵蓋；Journey 桌布來源 Pinterest、作者不明，角色取 AniList，地點取 wallhaven；AI 生成像素角色也不等於取得 IP 授權。可借實作方法，不宜直接再散布素材。`README.md:535-566`、`NOTICE:20-23`。
- **macOS 特別限制**：未合併 PR #1 說 main 的 COLR 字型在 macOS 顯示／fallback 有問題，需補 `m` glyph 與分色層繪製。此為 PR 作者回報，未在本機驗證；main 不能因使用 gpui-kit 就視為跨平台。

## 7. 累積與持久化

**有跨 session 保存，但保存的是操作歷史索引、配對、偏好與 cache，不是城鎮或成果帳本。**

| 位置／格式 | 保存內容 | 證據 |
|---|---|---|
| `%LOCALAPPDATA%\herdr-sessions\herdr-made.json` | session registry：ID、來源 root、帳號、terminal/tab/space、first/last seen、launch、facts。關 tab 後仍可列出；只有 transcript／thread 已找不到、非 current 且逾一小時才清除該登錄 | `herdr-sessions/list.py:332-338,353-367,484-581` |
| 同目錄 `derived.json`、`herdr-list.json`、`claude-list.json`、`codex-list.json` | 分流／搜尋用最近列表快取 | `list.py:573-581`；各 provider list 最後寫檔段 |
| 同目錄 `links.json`、`handoff/*.md` | Claude↔Codex 配對、各側 synced 游標、交接次數、文字對話及工具摘要；每次交接文件上限 120,000 字元，超量保留首個要求與較新 turns並明示省略 | `bridge.py:22-25,37-42,91-124,303-379` |
| 同目錄 `usage.json` | 最後額度、checked／stale／retry_at、email／login、token 指紋、credits／reset pass；不是逐次用量 ledger | `usage.py:58-72,190-245` |
| 同目錄 `spaces.json`、`space-cache.json`、`space-map.json` | 使用者分類規則、每 transcript 的 offset／size／hits、session→space 分類 | `spaces.py:90-156,213-280` |
| `%LOCALAPPDATA%\herdr-claude-sessions\cache.json` | 桌面 session metadata 依 size／mtime 快取 | `claude-sessions/list.ps1:9-50` |
| herdr `shared.json` | `journey.party`、`pixel.activity`、`pixel.scene/offset`、額度摘要、帳號列表、space assignment、hidden 與 sidebar 狀態等跨 mod 值 | `pixel-party/main.js:108,282`、`pixel-chrome/main.js:30-31,124,132`、`session-menu/main.js:57-73`；本機 `herdr.d.ts:445-449` |
| per-mod localStorage | `journey.start` 首次開啟日、清單 scope／折疊等；Pixel 會讀 `data/journey-chrome/store.json` 對齊最早日 | `pixel-chrome/main.js:4-5,75-96`、`journey-chrome/main.js:33-36`、`RECIPE.md:81-85` |
| clipboard／縮圖／layout JSON | 截圖 `herdr-sessions/clipboard/*.png`；縮圖 `appHome/.thumbs`；換景寫回 layout 檔 | `smart-paste/clip.py:14,31-42`、`results-panel/recent.py:15-16,71-83`、`pixel-chrome/main.js:110-124` |

Day N 是從第一次開啟算日曆天，不是 active time；戰鬥近 5 分鐘 kinds 在 view 的 Map，沒有戰績 ledger。沒有查到土地／建築／資源／成果驗收／不可變收成快照。`pixel-chrome/main.js:71-84,156`、`pixel-pane/main.js:52,216-241`、`plan.js:1242-1248`。

## 8. 安裝、隱私與安全

### 安裝與跨平台

文件流程：準備 Windows、herdr＋hc、Python＋Pillow、Claude／Codex 桌面 app（ffmpeg／zstandard 選用）；clone 後先檢查同名檔案衝突，再複製 layouts/themes/backgrounds 與 **全部 19 mods**；每個 mod 先放 `mod.json`，避免自動停靠；**合併而非覆寫 keys.json**，最後執行作者建議的 mod check 並手動切 layout。本研究未執行。`README.md:280-363`。

main 的 Windows 依賴是實質依賴，不只路徑分隔符：`msvcrt`、`ctypes.WinDLL(kernel32/ntdll/rstrtmgr)`、PEB 64-bit offsets、PowerShell System.Web.Extensions／CIM、`.cmd` wrappers、`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`。部分 JS 直接組 `home()/AppData/Local/...`，不是讀 OS cache 位置。`pane-account/who.py:21-23,83-105`、`codex-sessions/list.py:5`、`claude-sessions/list.ps1:5-9,55-60`、`usage.py:113`、`pixel-party/main.js:19`。**macOS 本機不應直接裝 main 當成可用套件**。

### 讀取哪些資料、送到哪裡

| 來源 | 用途／暴露邊界 |
|---|---|
| `~/.claude/.credentials.json`、wrapper 指向的其他 Claude config 下 `.credentials.json`；主帳號 `~/.claude.json`、其他 config 的 `.claude.json` | 取 `claudeAiOauth.accessToken`、email。Bearer token 送 `https://api.anthropic.com/api/oauth/usage` 與 `/api/oauth/profile`，`anthropic-beta: oauth-2025-04-20`。腳本沒有自行 refresh token；401 要使用者開 CLI 更新。`usage.py:39-45,58-100` |
| `$CODEX_HOME` 或 `~/.codex`、`~/.local/share/codex-accounts/<name>` 下 `auth.json` | 本機 decode ID-token payload 的 email；額度由帶該 `CODEX_HOME` 的 Codex app-server `account/rateLimits/read` 取得。app-server 的真實網路流量未觀測，連 OpenAI 是 README 說明。`usage.py:119-181` |
| `~/.local/bin/claude*.cmd`、Codex account 目錄與對應 `.cmd` | 枚舉額外帳號與 config；不是掃所有可能的 shell wrapper 命名。`usage.py:39-45,119-126` |
| Claude app metadata、`~/.claude*/projects/*/*.jsonl`、`sessions/<pid>.json`；Codex `state_5.sqlite`、`thread_history_1.sqlite`、rollout JSONL／ZST、locks、config／models／global state | session 發現、resume、分類、交接；包含 cwd、title、對話與權限設定。`claude-sessions/list.ps1:9-75`、`herdr-sessions/list.py:369-437`、`spaces.py:101-156`、`bridge.py:129-196,248-295` |
| Windows 行程與記憶體、Herdr terminal 畫面 | `who.py` 讀完整 command line 與最多 1 MiB environment block，再抽帳號／model；`hc read` 的活動 detail 寫入 persisted shared。`[INFERENCE]` 環境可能含其他 API keys，畫面 detail 也可能含機密檔名／指令參數，雖未看到這兩路主動上傳程式碼。`who.py:83-105`、`pixel-party/main.js:81-110`、`lib.js:161-196` |
| focused cwd 的一般檔案、系統剪貼簿 | Results 遞迴掃描有 60,000 entry／2.5 秒上限，home 深度 3、其他 8，略過隱藏／常見依賴目錄；圖片／影片生成本機副本。智慧貼上保存截圖，之後附加給 agent。`results-panel/recent.py:26-28,89-138`、`smart-paste/clip.py:16-44` |

### 具體風險與已有防護

1. **憑證讀取權限很大**：mod 是 trusted code，不是隔離的額度 widget；會讀 plaintext OAuth token、別的行程 environment。程式未把原 token 寫入 cache，但會保存 email 與 SHA-256 前 16 hex 指紋。只說「token 不存」不能等同沒有身分資料落盤。`usage.py:58-84,242-245`、`who.py:83-105`。
2. **對話有第二份副本且可能跨供應商**：space 分類只存計數，但 bridge 另存含原文的 Markdown；選擇交接後啟動另一個 agent並要求它讀文件，敏感內容會進另一側工作流程。這是明確使用者動作，不是背景偷傳，但 README 的 cache 摘要沒有逐項列出交接文件的內容。`bridge.py:91-124,303-379`、`session-menu/main.js:123-140`。
3. **Remote Control 預設啟用**：主 `claude` 新開／Herdr panel resume 會帶旗標，帳號登入不同於桌面 app 時應停用；作者提供的是刪改程式旗標，不是 UI consent 開關。`pixel-new-menu/accounts.js:10-35`、`herdr-sessions/main.js:123-130`、`README.md:454-456`。
4. **高權限會沿用**：Claude `bypassPermissions` resume 轉 `--dangerously-skip-permissions`；交接到 Codex 轉 `-s danger-full-access -a never`，反方向也保留 bypass。不是安裝就一律跳過權限，但接手舊 session 時必須認清繼承設定。`claude-sessions/main.js:112-119`、`session-menu/main.js:124-138`。
5. **Reset pass 真正消耗帳號權益**：`account/rateLimitResetCredit/consume`，有確認視窗、挑最早到期 pass，但不可撤回；本研究未呼叫。`usage-gauge/reset.py:66-78`、`usage-gauge/main.js:83-99`、`session-menu/main.js:104-113`。
6. **本機痕跡與全域快捷鍵**：截圖／縮圖約一週清理（觸發 helper 才清）；卸載段只列 layout/mod/key，沒有列 cache／handoff／clipboard 清除。全域 Ctrl+V 綁到只在這兩個 layout 出現的 smart-paste，換其他 layout 可能失效，README 已承認。`clip.py:31-39`、`recent.py:71-83`、`README.md:485-488,502-509`。

另：換景使用 expected-text CAS，降低覆寫並行修改的風險，但確實改 layout；遠端 git 用 `exec(...,{on})`，所以只看 Python 的 HTTP URL 不足以列完整跨機行為。`pixel-chrome/main.js:116-124`、`pixel-spaces/main.js:188-240`。

## 9. 優點與限制

### 優點

1. **實際工作流程整合完整**：發現 session、來源分流、續接、帳號選擇、開啟中確認、交接與搜尋共用 action 路徑，不只有角色展示。證據：§3、§5 的 script→JSON→panel→menu 路徑。
2. **額度有可信度狀態**：真實窗口、checked/stale/login/retry_at、過期窗口 unknown、推薦排除 stale；適合借用，不需以 token 猜訂閱上限。`usage.py:190-245`、`roomiest.js:7-44`。
3. **工作種類→演出很具體**：測試連擊、build 鍛造、git 集結、搜尋追跡，各有 dispatch；不只 working 轉圈。`lib.js:129-158`、`plan.js:832-852`。
4. **有節制的重工作分離**：battle planner 離開 render、分類 transcript 增量讀 offset、官方來源 metadata 依 size/mtime 快取。`pixel-pane/main.js:58-67`、`spaces.py:127-156`、`claude-sessions/list.ps1:23-28`。
5. **歷史接續不依賴還活著的 tab**：registry、pair links、synced 游標使關 tab 後仍可回頭工作，顯著超過純即時名冊。`herdr-sessions/list.py:484-581`、`bridge.py:303-379`。

### 限制

1. **平台與 CLI 私有格式耦合深**：Windows API、PEB offsets、`state_5.sqlite` schema、CLI 畫面 regex 都可能需跟版本維護；macOS 支援仍在 PR，不能直接用於我們的本機目標。§5、§8；PR #1。
2. **身分仍有兩套**：歷史列表用 session ID，角色用 tab/address；`root` 是來源分類，沒有 parent session／visit／interval，因此不能直接承接 v6 的遠征帳本。`lib.js:255-293`、`list.py:511-568`。
3. **觀測可能遺漏或誤配**：30 秒掃描漏短命 session；shared-daemon 同 cwd／相近起始時間可能配錯 terminal；作者自己記錄此限制。`RECIPE.md:379-382`、`list.py:409-437`。
4. **持久化不是成果累積**：有 session／交接文字，但沒有驗收、資源、建築或可重播開墾工時。戰鬥勝利不能解讀為品質。§7；`plan.js:1242-1248`。
5. **隱私範圍超過普通 layout**：憑證、行程環境、對話、畫面、剪貼簿皆可讀；還有跨 provider 交接與 Remote Control。需明確 opt-in／資料清理政策。§8。
6. **移植與散布成本**：三個 Pixel mod 各複製 `lib.js`（檔頭要求同步修改），全套 19 mods 互相依賴；大量角色／桌布素材沒有可直接再散布的授權保證。`pixel-party/lib.js:1-3`、`README.md:360-363,535-566`。

## 10. 與我們提案 v6 的比較

比較基準：本 repo `docs/proposal.md` §1、§3、§6、§7、§9、§12（提案，未實作）；以下「較好」指 Frieren 已有可查的實作，不代表已做跨機實測或證明產品效果。

| 面向 | Frieren main | 我們 v6 |
|---|---|---|
| 共同部分 | gpui-kit 原生 UI、agent 狀態可視化、帳號／provider 與工作脈絡 | 同樣不依賴 HTML/CSS/WebGL，使用 extension／adapter 資料 |
| 遠征身分 | 角色=tab/address；清單=session ID；來源 root=herdr/desktop/outside | `(cityId, rootSessionId)`；subagent 歸 root，跨 city 分 visit |
| 城／目的地 | Herdr space 名稱、關鍵字／folder 分類、8 張地點圖 | canonical git common dir 作 city，worktree 同城 |
| 時間 | 1.5 秒畫面抽樣、近 5 分鐘演出記憶、日曆 Day N | active interval 聯集每分鐘 +1，100 點完成開墾 |
| 成果 | 最近檔案列表、交接文件；不驗收、不算產值 | 驗收後木／石／鐵；文件／研究產生羊皮卷，與土地進度獨立 |
| 額度／投入 | 帳號級真實 5h／weekly、credits、reset pass；沒有 session 費用帳 | 額度可選；每 visit 累計 provider 投資決定派系，缺資料明示未知 |
| 持久化／回看 | session registry、來源、配對、增量交接文本 | 遠征、interval、收成快照、claim key、資源與建築歷程，CAS 原子提交 |
| CLI／平台 | Windows Claude／Codex 深整合；main 無完整 macOS | 本機 macOS，OMP 參考 adapter；其他 CLI 各做 adapter |

### 它目前做得比提案完整、可借用的具體做法

1. **額度 capability 狀態模型**：沿用 `checked/stale/login_needed/retry_at/reset time` 與 unknown，獨立於 token／成果，不只留 `number|null`。帳號推薦必須排除 stale；不要把 `usage.accounts` 精簡摘要當完整可信度模型，該摘要本身未傳 stale。`usage.py:190-245`、`roomiest.js:23-44`、`usage-gauge/main.js:25-32`。
2. **跨 CLI 接續的 UI 細節**：已有 session 先 focus；仍在另一處開啟時提示 continue／copy；搜尋送回原 handler；可作 v6 點遠征格後的「回到工作」入口模式。`session-search/main.js:130-136`、`session-menu/main.js:51-83`、§5。
3. **事件與演出解耦**：採用純 planner、明確 activity enum→演出 dispatch、原生影格，而不是每次 render 做模擬；v6 可借給開墾／駐紮／收成動畫，但不需要搬整套戰鬥。`plan.js:832-852`、`pixel-pane/main.js:58-67`。
4. **增量資料游標**：transcript offset／signature 變更重算、交接每側 synced 游標是可讀的小模型；v6 可借「明確 cursor、附版本」的做法，但不是直接用它的檔案覆寫取代帳本 CAS。`spaces.py:127-156,244-260`、`bridge.py:303-379`。
5. **操作確認與安裝邊界**：reset pass 二次確認；拷貝前名稱衝突阻擋、keys 合併、先 mod.json；v6 的撤回／消耗羊皮卷也應清楚呈現不可逆成本。`usage-gauge/main.js:83-99`、`README.md:311-358`。

### 應避免的坑

- **不把畫面抽樣當可靠投入帳本**：漏工具、CLI 改字、30 秒 session 盲點與 daemon 配對都不適合決定土地／資源；v6 繼續走 session/cwd/usage extension 與 active interval 聯集。§5；提案 §6。
- **不把帳號剩餘額度歸給單一遠征**：同帳號多 pane 共享一份 HP/MP，無法從此推得每格 provider 投資或研究 token。`pixel-party/main.js:157-171`、`lib.js:325-337`；提案 §7.3、§9。
- **不把角色身分綁 tab**：角色可以隨 tab 畫面，永久遠征必須用 session ID；否則 resume／移動重開會改身分。`lib.js:255-293`；提案 §5.2。
- **不把 git 改動列表當成果認領**：Results 是按 mtime 的最近檔案工具，不分 session 貢獻、不防重複；v6 仍需 baseline／claim key／人工驗收。`recent.py:89-138`；提案 §7。
- **不複製敏感資料的廣泛存取慣例**：額度抓取、screen scraping、clipboard、對話交接應拆成獨立可關的 capability，研究／交接文件需 retention；這是設計建議，不是 Frieren 已有的權限隔離。§8。
- **不把字型技巧與 IP 素材直接搬到 macOS**：先確認實際渲染能力，使用可散布的原創中世紀素材；未合併 PR 的修法只能作移植參考，不能當 main 已驗證。§6；PR #1。

## 11. 證據清單

### 實際查閱的專案來源

固定版本基底：[80a3ff4 檔案樹](https://github.com/CHO-kr/frieren/tree/80a3ff4ae07cd156a059c41f761e4b1104aeb47c)。下列為直接閱讀或本次並行研究逐段追查的檔案；大型檔案閱讀的是文中引用段落，沒有宣稱全部逐行讀完。

- 文件／版面：`README.md:1-568`、`RECIPE.md:1-110,374-415`（另由並行研究查 session／平台相關段落）、`NOTICE`、`layouts/frieren-journey.json`、`layouts/frieren-pixel.json`；兩個 `layouts/*.png` 已直接檢視。
- Pixel：`mods/pixel-party/{main.js,lib.js,build/README.txt}`；`mods/pixel-pane/{main.js,plan.js}`（planner 宣告、ally、dispatch、mode 選擇等段落）；`mods/pixel-chrome/main.js`；`mods/pixel-spaces/main.js:188-240` 與 machine／git 搜尋段；`mods/pixel-new-menu/{accounts.js,mod.json}`。
- 額度／帳號：`mods/usage-gauge/{usage.py,reset.py,main.js,roomiest.js,mod.json}`；`mods/pane-account/{who.py,main.js,mod.json}`。
- Session：`mods/herdr-sessions/{list.py,spaces.py,main.js,spaces.example.json,mod.json}`；`mods/claude-sessions/{list.ps1,main.js,mod.json}`；`mods/codex-sessions/{list.py,main.js,mod.json}`；`mods/session-menu/{bridge.py,main.js}`；`mods/session-search/main.js`。
- 其他 runtime：`mods/results-panel/{recent.py,main.js}`、`mods/smart-paste/{clip.py,main.js}`、`mods/journey-chrome/main.js` 的 localStorage 段與 imports；全 mods 的 herdr import／effort／token／cost literal 搜尋。
- 素材清點（僅檔名／大小，不等同逐張圖片讀取）：`backgrounds`、`mods/pixel-party/{fonts,faces,build/spr,scenes,backdrops}`、`mods/pixel-spaces/art`。
- Git：`git log --format='%H|%aI|%an|%s'`；檢查未有 `.git/shallow`。未執行專案腳本或任何測試。

### 遠端一手資料

- [Repo metadata API](https://api.github.com/repos/CHO-kr/frieren)：stars／forks／預設分支／日期／license。
- [全部 issues API](https://api.github.com/repos/CHO-kr/frieren/issues?state=all&per_page=100)：唯一項目是 [PR #1 Add macOS support](https://github.com/CHO-kr/frieren/pull/1)，open、未合併；PR body 的平台回報明確與 main 分開。

### 本機比較基準（唯讀）

- `docs/proposal.md` §1、§3、§5–§12；`docs/competitors/herdr-kaiju.md` 僅作章節／呈現方式參考，不作本研究技術結論來源。
- `~/.config/herdr-app/herdr.d.ts`：exec／檔案／agent／terminal／shared／overlay／watch 宣告。
- `~/.config/herdr-app/AGENTS.md:86-90,153,980,1004,1141` 與 `gpui-kit.d.ts` 的 localStorage 契約搜尋結果。
- **未讀取本機 Claude／Codex 憑證、對話、cache 或環境記憶體**；敏感路徑結論來自競品原始碼。

### 無法確認事項

未實測 Windows 上安裝與現行 provider endpoint/schema 可用性、原生字型效能、各帳號登入／額度數值、reset pass、Remote Control、clipboard attachment 或實際網路封包；未驗證 PR #1 的 macOS 修正。未查到全 repo 統一授權、第三方圖片再散布授權證明、作者一致宣告的最低／已驗證 herdr 版本。這些未知不以 README 的宣稱或本機 API 名稱存在補成「已驗證」。
