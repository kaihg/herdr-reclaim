# 競品分析：herdr-traveler

> 研究日期：2026-11-19。遠端基準：[franky5440-afk/herdr-traveler](https://github.com/franky5440-afk/herdr-traveler)，clone HEAD `c2380297bb42e6ecaa3648dbf1c35cc7ec609868`。本文的 repo 路徑與行號均指此版本；可從[固定版本原始碼](https://github.com/franky5440-afk/herdr-traveler/tree/c2380297bb42e6ecaa3648dbf1c35cc7ec609868)查閱。
>
> 證據分三層：**文件宣稱**、**repo 程式確認**、**本機已安裝版本**。本機路徑以 `H = ~/.config/herdr-app` 簡寫。全程靜態、唯讀研究來源；未安裝、未執行專案腳本或 mod、未切換 layout，未讀取私人對話或 provider 資料庫。推論標示 `[INFERENCE]`。

## 1. 基本資訊

| 項目 | 結果與證據 |
|---|---|
| Repo／作者 | `franky5440-afk/herdr-traveler`；Frank Lin（`NOTICE:1-2`、git log） |
| 授權 | 程式 Apache-2.0；三個 mod 衍生自 herdr 0.1.11 內建 mod。**圖片不隨程式取得 Apache 授權**，見 §6（`LICENSE:1-5`、`NOTICE:4-9`） |
| Stars／forks／open issues | **43／0／2**，研究當日 [GitHub API](https://api.github.com/repos/franky5440-afk/herdr-traveler)；[open issues API](https://api.github.com/repos/franky5440-afk/herdr-traveler/issues?state=open&per_page=100)確認兩筆都是 issue，不是 PR |
| 首次 commit | `1753001`，committer 時間 **2026-11-02 22:09:11 +08:00**；author 時間為同日 21:57:12（`git show --format=fuller --no-patch 1753001`） |
| 最近 commit | `c238029`，**2026-11-16 14:05:37 +08:00**，處理 `window()` 不存在時的 sprite 排程；讀到 15 筆 commit（git log） |
| 對應 herdr | layout 與 clone metadata 為 **0.1.11**；RECIPE 宣稱乾淨安裝亦通過 **0.1.12**（`layouts/traveler.json:3-6`、`RECIPE.md:52`）。本專案提案記錄本機基準 0.1.16；本研究只對照當前 API 宣告，未另執行版本或相容性測試 |
| 語言／規模 | JS 原生 UI、Node.js `.mjs` 資料收集、JSON layout/theme。主要檔案：agents `main.js` 294 行、`lib.js` 216 行；tabs `main.js` 115 行、`lib.js` 156 行；builder script 304 行、statusline 55 行。spaces `main.js` 約 20.2 KB，inbox `main.js`／`lib.js` 約 7.8／5.0 KB（實讀檔案與目錄列示） |
| 開放問題 | [#1](https://github.com/franky5440-afk/herdr-traveler/issues/1)：把「無 upstream」標成「無 remote」；[#2](https://github.com/franky5440-afk/herdr-traveler/issues/2)：Inbox 的 macOS 指令路徑不支援 Windows/Linux；兩筆均 2026-11-17 建立，查詢時無留言 |

### 本機版本交叉比對

以唯讀 `git diff --no-index` 逐檔比較：`layouts/traveler.json`、四個 `traveler-*` 的 `main.js` 與 `mod.json`、agents/tabs 的 `lib.js`、`jobs.json`、`places.json`，**13 個檔案全部沒有差異**。本機 agents 同樣使用 PNG 逐幀、`window()?.active === true`、六欄 sessions 快取；不是 RECIPE 舊素材段落描述的 GIF 版。

- `cloned_from: 0.1.11` 是**來源內建 layout/mod 的版本**，不是 traveler 的發布版本，也不表示本機仍停在 11 月初程式碼；本機比對檔案已包含 11 月 16 日修正（`H/layouts/traveler.json:3-6`；`H/AGENTS.md:195-207`；commit `c238029`）。
- 本機多出 `gpui-kit.d.ts`、`jsconfig.json` 等開發輔助檔；不在上述等同比較範圍。圖像只核對清單，未逐一比較位元組。
- **本機沒有 `H/data/traveler`**，也未在 `H` 找到 `*statusline*.mjs`／`*builder-models*.mjs`，`~/Library/LaunchAgents/*traveler*` 無結果。因此只能確認 UI 程式已安裝，**不能宣稱本機 HP/SP 或 builder model 收集已啟用**；自訂路徑、遠端機器或其他名稱的排程未確認。

## 2. 一句話定位與主題

**把現有終端工作區換成暮色像素 RPG：agent 是隊員卡、space 是建築圖示，城鎮與地圖是背景，不是會累積成果的城鎮模擬。**（`README.md:3-17`、`layouts/traveler.json:71-74,109-112`、`mods/traveler-agents/main.js:214-294`）

「machine 變建築」是文件簡稱：程式實際對每個 **space 的名稱**選建築，machine 只負責分組；worktree 子列甚至不畫建築（`mods/traveler-spaces/main.js:10-16,253-286,379-386`）。

## 3. 功能清單

| 功能 | 文件宣稱 | Repo 程式確認／本機 |
|---|---|---|
| 隊員卡 | 職業、狀態、動畫、Claude session 名、HP/SP、model/effort | 確認。卡片點擊 `agent.focus`；blocked 橙框優先於 focused 金框。Codex/OpenCode 不畫 HP/SP；其他未知 app 可有空條（agents `main.js:214-260`）。本機程式相同，但缺預設快取 |
| 職業配對 | `jobs.json` 固定名稱，其餘八職業輪替不撞臉 | 依正規化 **tab name** 配對，不是 agent 種類或 session ID；同名 tab 共用角色、手動映射也可重複。未指定名稱依出現順序避開已用職業（agents `lib.js:57-98`） |
| 建築與機器 | machine/space 建築、跨機器分組 | 建築由 `places[w.name]` 或名稱字碼和選四種之一；跨機器 header、離線提示、拖曳同機器內排序與 worktree 縮排列均存在（spaces `main.js:10-16,229-286,334-388`） |
| Git 摘要 | 未提交檔案、未推送 commit、無 remote repo | 前兩者取 porcelain v2；跨 pane cwd、依 `(machine, repo top)` 去重。第三項其實是**目前 branch 無 upstream**，不是檢查 remote 設定（spaces `main.js:174-202,313-331`；issue #1） |
| 頭像分頁與面板 | 人物 tab、Files/Changes/Inbox | 確認，但 tab 並非固定 48×48 方塊：高度 48，寬度含肖像、名稱、狀態與關閉鈕（tabs `main.js:65-83`）；每個 space 記住面板選擇（`:26-54`） |
| Inbox | 開檔、複製桌面、移到垃圾桶 | 確認有呼叫與錯誤提示；白名單 9 種副檔名、只列第一層一般檔案、最多 200 筆、縮圖上限 20 MiB（inbox `lib.js:4-20,57-93,145-153`）；不是成果驗收系統 |
| 聲音 | 可自行加入完成／阻塞音效 | 沒附音檔，使用者自行改 herdr 全域設定；切 layout 不會關掉（README「Customize」） |

### 文件與程式的重要落差

1. **素材數已過時**：`RECIPE.md:40` 還寫 24 sprite GIF、2 icons、1 sidebar；實際是 **102 sprite PNG、3 個面板圖示、sidebar 與 map 兩張背景**，GIF 已在 `c85f166` 刪除。`RECIPE.md:35` 新段落則正確說明 PNG 排程。
2. **兩份 lib.js 並不相同**：RECIPE `:34,46` 說是複本、修改要同步；tabs 的版本仍留舊 `spritePath()`（GIF）與四欄快取 parser，agents 已改六欄與 PNG。tabs 只 import 職業配對／肖像函式，因此**不能把未使用的舊 helper 當成執行期仍播 GIF 的證據**（tabs `main.js:4`、`lib.js:97-142`；agents `lib.js:108-198`）。本機也有相同分歧。
3. **Codex 不是只 parse 兩種 record**：README `:77`／RECIPE `:38` 如此宣稱；實際 `readText()` 先讀整份 rollout，`codexFromRollout()` 對每一個 JSON 形式的行先 `JSON.parse`，之後才依 `type` 擷取欄位。是「只保留 model/effort」，不是「沒有把對話行載入／解析」（builder script `:30-36,66-97,236-239`）。
4. **「不在前景完全不重畫」只適用 sprite timer**：agents `main.js:185-212` 不排動畫，但 `:97-102` 的 30 秒資料 timer、folder watcher 和 `load()` 的 `cx.notify()` 仍運作；spaces 也有獨立輪詢。不能推廣成整個 layout 零背景工作。

## 4. 架構

### Layout 節點樹

來源：`layouts/traveler.json:1-211`；本機相同。

```text
root row（traveler-dusk、terminal_opacity 0.6、無原生 titlebar）
├─ sidebar column：268px、背景 sidebar.png、不可拖曳 resize
│  ├─ brand block：46px → traveler-chrome
│  ├─ sidebar-lists column
│  │  ├─ spaces block：weight 1、min 90 → traveler-spaces
│  │  └─ agents block：weight 1、min 90 → traveler-agents
│  └─ sidebar-footer block：69px → traveler-chrome {footer:true}
└─ work column
   ├─ tabs block：58px → traveler-tabs
   ├─ work-body row：padding/gap 8
   │  ├─ main block → active tab；pane header → pane，背景 map.png
   │  └─ panel column：368px、預設 hidden
   │     └─ panel-body stack → files / changes / inbox（預設 files）
   └─ status block：28px → workspace-status
```

### Mod 清單與職責

| Mod | 職責／資料來源 | 證據 |
|---|---|---|
| `traveler-agents` | agents 卡片、職業配對、讀本機／遠端 sessions 快取、動畫排程 | `main.js:83-294`、`lib.js` |
| `traveler-tabs` | 肖像分頁、拖曳／選取／關閉、面板切換與 per-space 記憶 | `main.js:17-115` |
| `traveler-spaces` | 建築列、機器分組、worktree、所有 terminal cwd 的 git 摘要 | `main.js:30-42,62-223,229-331` |
| `traveler-chrome` | 頂端品牌／搜尋／收窄側欄；footer 設定與新增機器 | `main.js:17-51` |
| `inbox` | 指定資料夾列表、縮圖、開啟／複製／垃圾桶 | `main.js:22-119`、`lib.js` |

另依賴內建 `pane`、`files`、`changes`、`workspace-status`；互動會開 `menu`、`new-menu`、`picker`、`machine-add`，並借用 `workspace-chrome`／`pane` 圖示。不是完全自足的一個 mod（layout、tabs `main.js:78-115`、chrome `main.js:35-48`）。

### 使用的 herdr API（具名）

- agents：`agents`、`appHome`、`readTextFile`、`run`、`setAgentOrder`、`spaces`、`theme`、`watchFolder`、`window`。
- spaces：另有 `machines`、`panes`、`openOverlay`、`exec`、`hc`、`shared`、`setShared`、`layout`。
- tabs/chrome：另有 `settings`、`props`、`updates`。
- inbox：另有 `home`。合計 **21 個不同 API**；各 mod 檔頭 import 與 `H/herdr.d.ts:14-29,91,146-149,193,233-238,275-383,420,445-474` 可對照，未假設存在 session／usage API。
- gpui-kit：`View`、`div`、`image`、`svg`；gpui-base：`h_flex`、`v_flex`。`cx.spawn`、`cx.notify`、`cx.timer.every/after` 與 `localStorage` 屬 UI/runtime，不是上述 herdr module API。
- 主要 app 命令：`agent.focus`、`space.new/select/move`、`tab.rename/move/select/close`、`layout.select/show/hide/resize`、`window.minimize/maximize/close`、`app.settings`、`mod.open`（各 `main.js`）。

### 外部資料與程序

UI 本身不是零程序：spaces 透過 `exec` 跑 `git status`、兩次 `git rev-parse`，透過 `hc` 每 15 秒取 machine 清單；每 250ms 判斷是否需更新，真正 git 掃描有 pending 合併、順序執行與 60 秒 fallback（spaces `main.js:85-163,174-223`）。可選 Node scripts 則是 UI 外的寫入端；詳細權限見 §8。

## 5. Agent／session 處理

### 身分、狀態、model 與額度

| 面向 | 實際處理與證據 |
|---|---|
| Agent 判定 | `agents()` 提供會回報 OSC 7501 status 的終端；UI 不自行掃描 process。`a.app` 精確匹配 `claude-code`、`codex`、`opencode` 才顯示品牌（agents `lib.js:144-153`；`H/herdr.d.ts:169-193`） |
| 狀態 | 直接用 `a.status`；working 工作動畫，blocked 舉手動畫，done/idle/未知值共用 rest；done 與 idle 文字／色彩仍不同（agents `main.js:15,214-260`、`lib.js:126-131`） |
| 身分鍵 | UI/card/cache 用 terminal **address**；角色用 **tab name**；sessionName 只是 Claude `/rename` 顯示文字，沒有 session ID 或 parentSessionId（agents `main.js:145-180,214-266`；statusline `:20-41`） |
| Claude HP | `context_window.remaining_percentage`，驗證 0–100、四捨五入；不是生命值或累計投入（statusline `:31-35`） |
| Claude SP | `100 - rate_limits.five_hour.used_percentage`，代表帳號五小時額度餘量；不是各 session 獨立配額，也沒有週額度／reset 時間（statusline `:32-41`） |
| Claude model/effort | `model.display_name`／`effort.level`，缺值為 null（statusline `:37-40`） |
| Codex/OpenCode | 只有可選 collector 提供 model/effort；HP/SP/sessionName 全為 null。builder 卡隱藏血條、模型獨立一行（builder `:185-192`；agents `main.js:252-260`） |
| 未知／過期 | 無效百分比或 timestamp 變未知 `—`；超過 **300 秒**只把 HP/SP 標 `old`，保留原數字。**sessionName/model 沒有過期標記**（agents `lib.js:174-216`、`main.js:248-260`） |
| 用量／成本 | 快取只有百分比和名稱，未提供 token 累計、API 等值、工時、provider 投資或成果量（statusline `:33-41`；builder `:185-192`） |

### jobs.json：文件、repo、本機

repo 與本機內容相同：`Claude Code→warrior`、`Codex→scholar`、`Frontend→dancer`、`Backend→hunter`、`Docs→cleric`、`Tests→apothecary`、`Review→thief`、`Deploy→merchant`（兩份 `mods/traveler-agents/jobs.json:1-10`）。

匹配忽略名稱大小寫與首尾空白；職業值限八個白名單。未指定的名稱先做字碼和，再按當前 tab/agent 名稱順序找未用職業；八種用完才清空 used。兩個同名 tab 在 Set 去重後共用角色，**不是「八個 agent 內絕不撞臉」**（agents `lib.js:57-98`）。agents 與 tabs 都只在 init 讀 `jobs.json`，沒有監看它；[INFERENCE] 編輯後需讓 mod 重新初始化才會套用（agents `main.js:92,129-142`；tabs `main.js:18-25`）。

遠端卡片也用**目前執行這個 mod 的本機 jobs.json**；只有 sessions 數據用 `{on}` 遠端讀。README 要各機同步 jobs，是為各機自己開 UI 時一致；[INFERENCE] 未指定名稱仍可能因各 UI 所見 tab 清單／順序不同而分配不同職業，光複製 jobs 不保證所有自動角色一致（agents `main.js:10,165-180,263-266`、`lib.js:71-98`）。

### sessions 快取與兩個可選寫入端

- 每個 terminal 一檔：`data/traveler/sessions/<terminal id>.json`。六欄是 `updatedAt`（epoch 秒）、`contextRemainingPct`、`fiveHourRemainingPct`、`sessionName`、`model`、`effort`。兩個 writer 用暫存檔、`0600` 權限、rename 原子替換；不是 append-only 歷史（statusline `:20-48`；builder `:185-192,245-250`）。
- UI 每 30 秒讀本機活動 agent 的檔案，並監看 sessions 資料夾；失效 watch 不忙迴圈，交由 timer 重試；新 address 首次出現立即補讀（agents `main.js:83-182,263-272`）。
- 遠端 `machine/t1` 分拆成 `{on: machine, path: '.config/herdr-app/data/traveler/sessions/t1.json'}`，每 60 秒讀；遠端必須另裝 writer，且路徑硬定預設 app home。讀不到變 null，不推估（agents `lib.js:155-172`、`main.js:100-101,165-182`）。
- Claude 需要 **statusLine command**，不是 traveler 自動安裝的 extension；輸入由 Claude 提供 stdin JSON，依 `HC_TERMINAL_ID` 寫檔。文字移除控制／雙向文字字元，session name 限 80 字、model/effort 限 40 字（statusline `:9-29`）。
- Codex/OpenCode 需要**自訂啟動 wrapper + launchd 每分鐘執行 collector**。wrapper 記錄 `~/.cache/builder-state/<terminal id>` 的 `kind/pane/dir/started`；collector 還要 `hc ls --json` 確認 terminal 存活與 agent 種類（README「Model and effort…」；builder `:41-61,195-224,260-287`）。
- Codex：掃 `$CODEX_HOME/sessions` rollout，cwd 必須字串完全相同、originator 必須 `codex-tui`、session 開始時間不得早於 wrapper；在候選中取**session 開始最新**者的最後 turn_context。這是目錄／時間配對，**不是從 rollout 取得 terminal ID 直接綁定**（builder `:66-97,133-160,233-239`）。
- OpenCode：唯讀 `node:sqlite`，只查 `session_v2(directory,parent_id,model,time_updated)`；相同 dir、無 parent、更新時間不早於 wrapper，取最新可解析 model；`variant=default` 變 null。是比**更新時間**，不是 session 建立時間（builder `:101-130,164-183`）。
- 同種 builder 同一目錄有兩個被追蹤實例時，兩者寫 null；缺 state 檔／不符 live 種類則直接跳過，而非主動清除舊快取（builder `:203-224,231-250`）。

### `/new`、`/resume`、`/move`、subagent、多 machine

| 情境 | 能力與邊界 |
|---|---|
| `/new` | 沒有 session lifecycle handler。同一 terminal 新 session 仍覆寫同檔；UI 不建立新的收藏／紀錄。角色不因 session 改變而改，除非 tab name 改（statusline `:20-48`；agents `lib.js:81-98`） |
| `/resume` | 沒有穩定 session ID。**Codex resume 的原始 meta.timestamp 若早於這次 wrapper started，就被排除**；[INFERENCE] 因而無法靠此規則可靠顯示重啟後恢復的舊 session model，未動態測試（builder `:92-97`） |
| `/move`／cwd 改變 | spaces 會依 pane live cwd 更新 git；builder state 是 launcher 當時 dir，沒有 cwd 變更事件或 visit 帳本。OpenCode 新 dir 與舊 state 不符就不匹配（spaces `main.js:30-42,105-136`；builder `:41-61,117-130`） |
| subagent | 不讀 `terminals()` 或 parent 關係，不做 root 歸戶；herdr 文件中的無 pane child 要由內建 agents mod 另畫。OpenCode collector 明確排除 parent row（agents `main.js:263-266`；builder `:123`；`H/AGENTS.md:157-162`） |
| 多 machine | 有 space 分組、遠端 git 與遠端 sessions 讀取；collector 本身只收 bare local terminal ID，所以要每台各裝。跨機時鐘偏差會影響 `old` 判斷；不具備跨機 session 歷史同步（spaces `main.js:174-202,253-286`；agents `lib.js:164-172,214`；builder `:203-212`） |

## 6. 視覺與美術

- **風格**：暮色深靛藍、古金框、羊皮紙字色與橙色 SP／blocked；8 職業全身像素角色，半身像用於 tabs；連續城鎮側欄、終端後方手繪風大地圖。實際讀過 `preview.png`；顏色來源 `themes/traveler-dusk.json:1-32`，背景／透明度見 layout。預覽只證明展示外觀，不當作真實 session 數據證據。
- **實際素材清單**：`traveler-agents/art` 8 PNG；`sprites` **102 PNG**，即 8×4 rest + 8×2 blocked + 54 working（各職業 6/7/6/8/6/9/7/5 格）。另有建築 4 PNG、面板圖示 3 PNG、sidebar/map 2 PNG；以上執行期主題 PNG 共 **119 張**，不含預覽、layout 縮圖、複製的 SVG。repo 與本機 sprite 目錄均列出 PNG，不是 24 GIF（目錄列示；agents `lib.js:112-123`）。
- **生成方式**：肖像／建築／sidebar 文件說用 Meta AI、純綠背景去背縮放；有完整 prompt。map 用 Z-Image Turbo，seed 555772、9 steps、1728×1296，裁框與壓暗（`ART-NOTICE.md:3-9`；`docs/ART-PROMPTS.md:1-16,80-86`）。
- **動畫來源**：ART-NOTICE 說原 GIF 是程式逐像素畫，顏色跟隨肖像；`lib.js:22` 提到 `tools/sprites/build.mjs`，但 clone **未附 tools 目錄／該生成器**。能確認發布的幀與 delay，無法依此 repo 完整重跑角色製作管線。
- **排程**：144×192 幀畫成 72×96 logical px；`frameAt()` 以全局 elapsed 對週期取模，取每個角色下一個邊界的最小 wait，只保留一個 one-shot timer（至少 16ms）；每次重畫先取消舊 timer。非前景或沒有 window，顯示 frame 0、不排動畫 timer（agents `main.js:12-14,187-212`；`lib.js:108-141`）。rest 也會眨眼，因此前景 idle 不是零動畫。
- **效能理由的證據層級**：commit `c85f166` 與 RECIPE 說 GIF 會每個 display frame 重畫整個 window，最小化仍持續；PNG 替換及 inactive gate 可從程式確認，**CPU/GPU 節省幅度未量測**。tab 的 working spinner 仍 `.spin(900)`，不可宣稱整個 layout 動畫皆受 agents gate 控制（tabs `main.js:82`）。
- **授權限制**：NOTICE 明說圖片不涵蓋在 Apache 下；ART-NOTICE 不授予 AI 圖像權利保證、商用需要確定性時應替換，也指出模型授權不等於輸出授權。對 sprites，文字仍描述已移除的 GIF，未明確補述新的 PNG 授權；**未查到足以把這批 PNG 當成 Apache 素材直接再散布的明確授權**（`NOTICE:9`、`ART-NOTICE.md:3-13`）。

## 7. 累積與持久化

**有持久化設定與最後快照，沒有 session 成果／土地／資源累積。** 不應把「無城鎮累積」寫成「完全不存資料」。

| 保存內容 | 路徑／格式／行為 | 證據 |
|---|---|---|
| 職業／建築映射 | `mods/traveler-agents/jobs.json`、`mods/traveler-spaces/places.json`，JSON object；repo 與本機 places 都是 `{}` | 對應兩組檔案；agents `main.js:129-142`、spaces `:64-69` |
| 數據快照 | `data/traveler/sessions/<id>.json`，六欄、最後寫入覆蓋；沒有事件游標、session ID、歷史、過期檔清理流程 | statusline `:33-48`；builder `:185-250` |
| builder 啟動資訊 | `~/.cache/builder-state/<id>`，key=value；是關聯線索，不是工作成果 | README wrapper 範例；builder `:41-61` |
| 面板選擇 | `localStorage['panels']`，space ID→panel/null；本機實檔 `H/data/traveler-tabs/store.json`，外層 JSON 的值是 JSON 字串 | tabs `main.js:26-54`；本機實讀 |
| 機器收合 | `localStorage['machines.folded']`；本機 `H/data/traveler-spaces/store.json` 存 JSON 字串陣列 | spaces `main.js:85,271-272`；本機實讀 |
| 共用 UI 狀態 | `sidebar.width`、`sidebar.collapsed`、`space.colors`，herdr shared 持久化；layout 點擊尺寸／顯隱由 herdr 存 `layouts/.state/` | chrome `main.js:17-23`、spaces `main.js:407-419`；`H/herdr.d.ts:445-449`、`H/AGENTS.md:86,215-220` |
| Inbox | `data/inbox/files` 中的真實檔案，直到使用者移除；與任何 session 無綁定 | inbox `main.js:12,31-39,111-119` |

`this.cache/remote/git/checked/seen` 等只在 mod instance 記憶體；沒有 active interval、收成快照、資源帳本或回放介面（agents `main.js:83-182`；spaces `main.js:70-87`）。本機確有上述 panel/folded store，但沒有預設 sessions 快取目錄，兩者必須分開描述。

## 8. 安裝、隱私與安全

### 安裝步驟（描述文件，未執行）

1. 將 `layouts/traveler.*`、`themes/traveler-dusk.json`、`mods/*` 複製到 herdr home，再執行 `layout.switch`。同名檔需先避開；更新要備份 `jobs.json`／`places.json`，或使用 README 的 `rsync --exclude` 方案（README「Install」）。
2. 若需 Claude HP/SP/model，另將 statusline script 放進 `data/traveler/statusline.mjs`，在 `~/.claude/settings.json` 設 command 與 60 秒 refresh；**會取代既有 statusLine**（README「HP and SP」）。
3. 若需 Codex/OpenCode model，另做 launcher wrapper、安裝 `builder-models.mjs` 與 LaunchAgent；README 要 macOS、Node **22.13+**（`node:sqlite`），StartInterval 60、RunAtLoad true。collector 固定找 `~/.local/bin/hc`；不是通用 PATH 搜尋（README「Model and effort…」；builder `:280-287`）。
4. 卸載文件除 mods/layout/theme，也刪 `data/inbox` 與 traveler 資料、停用 launchd；需先搬走 Inbox 檔案。文件卸載命令**未移除 Claude settings 的 statusLine 引用，也未移除自訂 wrapper/state 檔**；[INFERENCE] 只照命令刪除後會留下指向已刪 script 的設定（README「Uninstall」對照「HP and SP」）。

### 讀取、指令與網路範圍

| 元件 | 權限與行為 |
|---|---|
| Agent UI | 讀 jobs、各 terminal 六欄快取與圖片；本機 watcher，遠端透過既有 herdr 連線讀檔；不直接讀對話、不執行模型 collector（agents `main.js:5-10,106-182`） |
| Spaces | 在每個 pane cwd 讀 git 工作樹／git metadata；可在遠端跑 `git`，另 `hc machine ls --json`。不是「整套不跑指令」（spaces `main.js:37-42,145-150,174-202`） |
| Inbox | `/bin/mkdir`、`/usr/bin/find`、BSD `/usr/bin/stat`、`/usr/bin/open`、`/bin/cp -n --`、`/usr/bin/trash`；命令用參數陣列，操作前複查一般檔案，副檔名／路徑白名單（inbox `main.js:31,66-70,79-119`；`lib.js:57-143`） |
| Claude writer | stdin JSON、`HC_TERMINAL_ID`、本機 cache；不讀 Claude credentials；輸出不含原始對話（statusline `:5-48`） |
| Builder collector | `~/.cache/builder-state/*`、Codex 整份 rollout、OpenCode DB、`hc ls --json`；只寫六欄 cache。DB query 未查 credentials 欄位，但**程序能開啟含敏感資料的 DB**，且 Codex 全文讀入／逐 JSON 行解析（builder `:30-36,66-97,164-183,203-287`） |

來源中未見 mod 自行 `fetch` 或外連服務；但 remote file/exec 會使用 herdr 既有連線，`open` 後系統預設應用程式的網路行為不在此程式控制內。不能等同「完全沒有網路」或「沒有敏感資料存取」（各 mod imports／命令、README「What it does on your machine」）。

### 主要風險

- `git status` 可觸發不受信任 repo 自有 `.git/config` filter。程式加 `--no-optional-locks`、`core.fsmonitor=false`、`safe.bareRepository=explicit`，但不消除 repo 自有設定風險；README/RECIPE 有警告（spaces `main.js:176-180`；RECIPE「Watch out」）。
- 資料讀取失敗多數靜默變 null／跳過；collector 沒有可觀察錯誤介面，模型欄又沒有 `old`，會降低故障辨識能力（builder `:30-36,164-183,260-303`；agents `main.js:248-260`）。
- 自訂 `HERDR_APP_HOME` 不會自動傳遞到 writer：UI 用 `appHome()`，scripts 用固定家目錄或 `TRAVELER_CACHE_DIR`；遠端 reader 仍硬編碼預設路徑（agents `main.js:8-10`、`lib.js:164-172`；statusline `:43-44`；builder `:283-286`）。
- Inbox 的安全檢查不等於附件內容可信；實際交給外部 app 開啟，並具備複製與移除使用者檔案能力。跨平台限制已由 issue #2 報告；本研究未重跑使用者回報。
- herdr mod 本身是 trusted code，`exec` 使用使用者真實環境，並非權限沙箱（`H/herdr.d.ts:10-14`、`H/AGENTS.md:1140-1142`）。

## 9. 優點與限制

### 優點

1. **狀態語意可讀**：blocked 顏色／框線優先、工作／求助／休息動畫、model 與品牌標籤分離；不把橙色 builder tag 混成需要使用者注意（agents `main.js:57-76,214-260`）。
2. **缺資料不造假**：百分比驗證、未知 `—`、過期 `old`，同目錄多 builder 主動放棄猜 model（agents `lib.js:29-33,205-216`；builder `:217-242`）。
3. **動畫有明確節流**：PNG 原始 delay、單一最早邊界 timer、背景停幀；對原生 GPU UI 可直接借用設計，而非照搬 GIF（agents `main.js:187-212`）。
4. **跨機器整合已具體落地到呼叫點**：remote `{on}` cache 與 git、machine 分組與連線提示都有程式，不只是截圖（agents `main.js:165-182`；spaces `main.js:174-202,253-286`）。
5. **工作區功能不只裝飾**：跨 cwd git 去重、worktree 排列、per-space 面板與 Inbox，仍保留終端操作用途（spaces `main.js:229-250,313-331`；tabs `main.js:29-54`；inbox `main.js`）。
6. **資料邏輯可單獨閱讀**：jobs/cache/frameAt 與外部副作用分在 lib/main/script；六欄快取原子替換、文字淨化與 ID 白名單可當 adapter 邊界參考（agents `lib.js`；statusline `:9-48`）。

### 限制

1. **無 session 級收藏**：terminal address／tab name 不是 session identity；不能可靠處理 resume、移城或 subagent 歸戶，也沒有成果／資源／歷史（§5、§7）。
2. **資料收集零散且有啟用門檻**：Claude statusLine、builder wrapper、launchd 各自設定；本機只裝 UI 仍沒有預設快取。Codex 恢復舊 session 的時間條件、同 cwd 歧義與 OpenCode schema 綁定都限制覆蓋（§1、§5）。
3. **「模型可見」不代表「模型即時」**：只對百分比做過期提示；跳過 writer 時舊 model 可留在 UI，沒有 source/error/freshness 能力欄位（agents `main.js:214-260`；builder `:203-212`）。
4. **多處文件落後**：GIF/PNG、圖示數、雙份 lib、只 parse metadata 的說明與實作不同；素材生成器未公開，難完整重建（§3、§6）。
5. **平台與安全耦合**：Inbox macOS 指令、launchd、固定 hc/遠端 home 路徑；另有 git filter 與對話／資料庫讀取權限（§8；issue #2）。
6. **複製內建 UI 的維護負擔**：三個 0.1.11 clone 不隨內建更新，另兩份 helper 已分歧；AI 圖像權利又不能直接視為 Apache（`H/AGENTS.md:202-207`；`NOTICE`；§3、§6）。

## 10. 與我們提案 v6 的比較

比較基準為本 repo `docs/proposal.md` §1、§3、§6、§7，並參照 §9、§10、§12 的投資／回看要求；以下不是 traveler 已有功能的延伸宣稱。

| 面向 | Traveler（已讀程式） | 我們 v6（提案） |
|---|---|---|
| 主體／空間 | 名稱映射隊員卡、space 建築圖示；背景圖不隨工作生長 | `(cityId, rootSessionId)` 遠征自動佔格，城鎮可回看 |
| 投入 | 沒有 active interval 或開墾計量 | root＋可歸戶 child 的 interval 聯集，每分鐘 +1，100 點開墾 |
| 成果 | Inbox 只是檔案展示／開啟，不驗收、不歸屬 session | 驗收成果取得木／石／鐵；文件／研究取得羊皮卷，加速與蓋房分開 |
| Provider | Claude/Codex/OpenCode app tag，model/effort；沒有投資累計 | 真實 provider 用量／成本投資決定派系，不把 token 變建材 |
| 額度 | Claude 五小時剩餘百分比，缺資料不猜；無 reset 時間 | 可取得才顯示真實人力與更新／重置資訊，未知明示 |
| Adapter | 外部 scripts 寫 terminal 最後快照；UI 讀檔 | extension／各 CLI adapter 提供 session、cwd、parent、visits、usage 游標 |
| 持久化 | 設定、UI 狀態、可覆寫快取、Inbox 檔案 | 收成／claim／baseline／interval 帳本與原子提交、可重播歷史 |
| 多機器 | 已有遠端 UI 資料通路，但每機另裝 writer | v6 MVP 限本機 macOS、單一 appHome |

**重疊**：同為 gpui-kit JS 描述原生 UI、靜態素材搭配狀態演出、agent 卡片與未知資料顯示。**核心差異**：traveler 改善當下工作區可讀性；v6 主要價值是穩定 session 身分、投入與驗收成果的長期收藏，不應只做它的換皮（traveler agents `main.js`；proposal §1–3）。

### 它已做得比目前提案具體的地方／可借用

1. **把真實訊號翻成遊戲語言但不估造數值**：HP/SP 的輸入欄位、缺值、過期已寫出明確規則。v6 可沿用「數值＋來源＋時間」的狀態卡，但補上 reset 時間與 model 的過期狀態（statusline `:31-41`；agents `lib.js:205-216`）。
2. **動畫排程可直接作為原生 UI 方案**：圖檔＋delay table、共用下一幀 timer、inactive 停幀；v6 工匠動畫可採同分工，不在 GPU 原生環境硬塞 Web 技術（agents `lib.js:108-141`、`main.js:187-212`）。
3. **讀取端與寫入端解耦**：mod 不直接解析各 CLI 私有資料，讀一致的小 JSON；v6 保留此界線，但協定應由 session-aware extension 輸出，改用事件／visit 與已確認游標，而非只剩最後快照（兩支 script；proposal §6）。
4. **多機器路由與失敗降級已有具體範例**：`address→{on,path}`、連不上回未知、遠端低頻輪詢，適合作為未來擴充參考；不必因此擴大 v6 本機 MVP（agents `lib.js:164-172`、`main.js:165-182`）。
5. **per-space 面板記憶與工作區 git 歸併**：切 space 恢復面板、以 canonical git common dir 組 worktree 的方向值得借用；v6 城市 identity 仍需 canonical 路徑與自己的 ledger，不把視覺列名稱當 city（tabs `main.js:29-54`；spaces `main.js:188-202,229-250`；proposal §1）。

### 應避免的坑

- 不用 tab name／terminal ID 代替 session ID；不以「最新同 cwd session」猜歸屬。這正是 v6 `/resume`／`/move`／root-parent 規格要解決的問題（§5；proposal §6）。
- 不把 `sessions/` 目錄名稱當成已經有 session 歷史；最後快照會覆蓋中途 visit，無法補算 app 關閉期間事件（statusline `:43-48`；proposal §6.1）。
- 不把 SP／token 當成果產值，不把 Inbox 的檔案存在當作驗收完成；保留 v6 成果候選、claim key、防重複收成邊界（inbox `lib.js:68-93`；proposal §7）。
- 不把「只輸出少量欄位」宣稱成「沒有讀敏感資料」；使用 extension 明確提供能力，比按 CLI 私有資料格式掃全文更可維護（builder `:66-97,164-183`；proposal §6）。
- 不宣稱停掉 sprite 就是停掉所有背景工作；資料 timer、watcher、tab spinner、git 輪詢應分開設計／量測（§3、§6）。
- 不直接複製未授權 AI 美術；借用 palette／分層與資料驅動方法，重製自有素材並附生成器／授權。也不要複製三套內建 mod 才能放城鎮；遵守 v6 一個可嵌入任意 layout 的 mod tab（`NOTICE`、`ART-NOTICE`；proposal §2.2）。

## 11. 證據清單

### 實際讀過的 repo 檔案／歷史

- `README.md`、`RECIPE.md`、`NOTICE`、`ART-NOTICE.md`、`LICENSE:1-28`、`docs/ART-PROMPTS.md`、`preview.png`。
- `layouts/traveler.json`、`themes/traveler-dusk.json`。
- `mods/traveler-agents/{main.js,lib.js,jobs.json}`、`mods/traveler-tabs/{main.js,lib.js,mod.json}`、`mods/traveler-spaces/{main.js,places.json}`、`mods/traveler-chrome/main.js`、`mods/inbox/{main.js,lib.js}`。
- `scripts/traveler-statusline.mjs`、`scripts/traveler-builder-models.mjs`。
- `mods/traveler-agents/sprites/` 全清單、各 `mods/*/art/` 清單、chrome/spaces/inbox 目錄與大小；未逐圖解碼，未取得未隨 repo 發布的 sprite 生成器。
- `git log --format='%h|%aI|%an|%s'`；`git show --format=fuller --no-patch` 的 `1753001`／HEAD；`git show --format=fuller --stat c85f166`。

### 本機唯讀交叉驗證

- `H/layouts/traveler.json`；`H/mods/traveler-agents/{main.js,lib.js,jobs.json}` 完整讀取、`sprites/` 全清單。
- 13 檔 `git diff --no-index`：layout；四個 traveler mod 的 `main.js/mod.json`；agents/tabs `lib.js`；jobs/places JSON，全部無差異。
- `H/data/` 清單、`H/data/traveler-tabs/store.json`、`H/data/traveler-spaces/store.json`。讀 `H/data/traveler` 回報不存在；限定 H 的 optional-script glob、`~/Library/LaunchAgents/*traveler*` 無命中。不曾讀取 Claude/Codex/OpenCode 對話／credentials。
- `H/herdr.d.ts:1-40,155-195,430-480` 及具名 API declaration 搜尋；`H/AGENTS.md:149-169,195-220,1125-1148` 與 storage/OSC/clone 說明搜尋。未以宣告存在推論整套執行成功。
- 比較基準 `docs/proposal.md` §1、§3、§6、§7 等已讀段落；格式參考 `docs/competitors/herdr-kaiju.md`，未拿其專案結論當 traveler 證據。

### 公開 URL

- [Repo](https://github.com/franky5440-afk/herdr-traveler)、[固定 HEAD](https://github.com/franky5440-afk/herdr-traveler/tree/c2380297bb42e6ecaa3648dbf1c35cc7ec609868)。
- [Repo metadata API](https://api.github.com/repos/franky5440-afk/herdr-traveler)、[open issues API](https://api.github.com/repos/franky5440-afk/herdr-traveler/issues?state=open&per_page=100)。
- [Issue #1：upstream／remote](https://github.com/franky5440-afk/herdr-traveler/issues/1)、[Issue #2：Inbox 平台限制](https://github.com/franky5440-afk/herdr-traveler/issues/2)（實際內容由 issues API 讀取）。
- [PNG 遷移 commit](https://github.com/franky5440-afk/herdr-traveler/commit/c85f16660377d1e27360feb12ef0b29631aee482)、[null window 修正](https://github.com/franky5440-afk/herdr-traveler/commit/c2380297bb42e6ecaa3648dbf1c35cc7ec609868)（實際由本機 git 讀取）。

**未能確認**：本機／遠端自訂 writer 或排程是否存在、實際 CLI 版本對 statusLine／OpenCode schema 的相容性、HP/SP/model 真實更新結果、動畫 GPU/CPU 效益、所有圖片的可再散布權利與未發布生成管線。未啟動 mod、未跑 check/build/test，因此沒有執行期驗證結論。
