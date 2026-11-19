# 競品分析：herdr-kaiju（Kaiju City 怪兽城市）

> 研究對象：`https://github.com/Jiqize/herdr-kaiju`，main 分支，`git clone --depth 50` 到 `/tmp/kaiju-research/herdr-kaiju`（唯讀研究，未安裝、未執行任何腳本、未切換本機 layout）。
> 本機基準：herdr-app 0.1.16（`~/.config/herdr-app/herdr.d.ts`、`AGENTS.md`）。

## 1. 基本資訊

| 項目 | 內容 | 證據 |
|---|---|---|
| repo | `Jiqize/herdr-kaiju`，default branch `main`，topics `herdr`、`herdr-layout` | GitHub API `/repos/Jiqize/herdr-kaiju` |
| 作者 | Jiqize（GitHub 帳號 2025-02-07 建立、40 個 public repo、0 followers）；18 個 commit 全部同一人 | `git shortlog -sne HEAD`、`/users/Jiqize` |
| 授權 | 程式碼 MIT（`LICENSE:1-3`，Copyright 2026 Jiqize）；字型 Fusion Pixel 為 SIL OFL 1.1（`mods/kaiju/fonts/OFL.txt`、README 致謝段） | 檔案 |
| stars / forks / watchers / issues | 1 / 2 / 1 / 1（那 1 筆是 PR #1，不是 issue） | GitHub API `issues?state=all` |
| 首次 commit | 2026-11-03 `be360a6` chore: art pipeline baseline | `git log --reverse` |
| 最近 commit | 2026-11-03 `ba44d36` docs: keep RECIPE in the six herdr.dev sections（`pushed_at` 2026-11-03T07:58:38Z） | `git log -1`、GitHub API |
| commit 總數／時間跨度 | 18 個，全部落在 2026-11-03 當天（03:00–16:00 台北時間）；單日專案 | `git log --format='%h\|%ad\|%s'` |
| 對應 herdr 版本 | README 自述「Built and checked on 0.1.11, macOS」；本機為 0.1.16，repo 未被更新驗證 | README:59、`herdr-app --version` |
| 語言 | 前端 JS（gpui-kit / herdr API）、美術管線 Python（Pillow + numpy）、JSON/SVG/PNG | 檔案 |
| 主要檔案規模 | mods JS 共 1046 行（city 224、roster 362、state 177、top 116、news 84、main 42、pane 39、manifest 2）；`layouts/kaiju.json` 172 行；art Python 1110 行（render 545、build_assets 445、pixelize 120） | `wc -l` |
| 資料體積 | repo 34 MB：`art/ai` 11 MB（8 張 AI 動作表）、`mods/kaiju/assets` 2.1 MB、字型 7 MB、`preview.png` 237 KB、363 張 PNG | `du -sh`、`find` |

沒有 release、沒有 tag、只有 `main` 一個分支（GitHub API `tags`/`releases`/`branches`）。

## 2. 一句話定位與主題

**把 herdr 的每個 space 當成一棟樓、每個 agent 當成一隻原創萌系怪獸的等距像素沙盤**：agent 開始工作時怪獸從海裡上岸拆樓（樓依工時逐級損壞），做完了在廢墟上咆哮，被卡住時揮手並在樓頂亮紅色警報燈；左下的名冊用「機密檔案夾」卡片列出每隻怪獸的任務、狀況與戰績，右下角在背景 agent 完成或卡住時彈出「怪獸快訊」。

主題是「怪獸拆樓」而非「建造」：**怪獸是 agent 的化身，樓是 space，破壞程度是投入時間的可視化**，整個詞彙表（拆樓中／拆完了／等你／睡觉中）都繞著這個主題轉。

## 3. 功能清單

### 文件宣稱（README/RECIPE）

- 8 棟樓、8 隻原創怪獸，agent 依出現順序循環取得怪獸（README:20-21、RECIPE「What you see」）。
- 樓隨 agent 工作時間逐級損壞，看過之後自動修好（README:22、RECIPE「How it behaves → Damage」）。
- 名冊兩種模式：機密檔案卡（任務／計時／損壞／戰績）或頭像小方塊（README:23）。
- 頂欄膠囊與 tab 顯示怪獸頭像，窗格標頭顯示程式與目錄（README:24）。
- 後台 agent 完成或卡住時彈出怪獸快訊（README:25）。
- 淺／深色自動切換，夜間城市亮燈（README:26、RECIPE「Themes」）。
- 安裝只複製自己的檔案、合併 `cmd-b`（先問、備份）（README「Install」）。
- 換怪獸只要放動作表、改 `art/roster.json`、跑 `build_assets.py`，不用改程式（README「Swap the monsters」）。

### 程式確認有（逐項對到原始碼）

| 宣稱 | 程式證據 | 結論 |
|---|---|---|
| 8 棟樓、8 隻怪獸 | `manifest.js` 的 `slots` 長度 8、`monsters` 8 筆；`state.js:39-42` `slotOf()` 只回 0–7，其餘回 `null` | 確認 |
| 怪獸依出現順序循環分配 | `state.js:135-151` `assign()`：未見過的 address 取 `M.monsters[n % 8]`，`n` 遞增，存 `shared("kaiju.monsters")` | 確認 |
| 工時 → 損壞分級 | `state.js:8-9` `LIGHT_AFTER=2 分`、`HEAVY_AFTER=8 分`；`:54-63` `target()` 用 tab 的 `working_since` 算 0/1/2，有 `done` 直接 3 | 確認（文件寫「2 分鐘／8 分鐘」） |
| 看過後自動修好 | `state.js:89-105` 非 working 時每 `REPAIR_STEP=650ms` 降一級；`done` 只有在使用者真的看過後才變 `idle`（herdr 行為，`herdr.d.ts:177-179`） | 確認 |
| 四種狀態各有行為 | `state.js:24` `FACE`、`:130` `MODE`、`:131` `BUBBLE`；`city.js:107-123` 走路／衝撞抖動／咆哮＋!!／揮手＋?；`:181-185` blocked 時樓頂警報燈 | 確認 |
| 損壞是逐 agent 聚合 | `state.js:52-54` 註解明說不用 `space.status`（blocked 會蓋掉 done），改逐 agent 判定；`city.js:16-21` 寫回 `shared("kaiju.damage")` 供名冊進度條 | 確認 |
| 名冊兩種模式且會記住 | `roster.js:272-274` `shared("kaiju.roster")`；`:355-356` 切換按鈕；`:347-349` 兩種卡片 | 確認 |
| 檔案卡欄位 | `roster.js:197-239`：編號標籤、`KAIJU FILE`、狀態印章、回形針照片、代号／程序／驻地／任務／狀況／損壞／戰績 | 確認 |
| 任務＝終端標題 | `roster.js:81-90` `task()`：把標題按分隔符切開、去掉程式名與 space 名片段，空的話顯示「未登记」 | 確認 |
| 頂欄 tab 顯示 tab 內第一個 agent 的頭 | `top.js:144-145` `ags.find(x => x.tab === c.id)`、`:105-112` `headIcon()`；沒有 agent 時畫磚頭 | 確認 |
| 窗格標頭顯示程式與目錄 | `pane.js:214-239`，目錄以 `home()` 縮寫成 `~`（`:208-212`） | 確認 |
| 快訊只在背景 agent 完成／卡住時出現 | `news.js:9-31`：`HOT(done/blocked)` 且 `!focused`、第一次見到不算、最多 3 條、`還有 N 條` | 確認 |
| 夜間城市亮燈 | `render.py:109` `LIT=#ffd877`、`:129-131` 窗戶 38% 機率亮暖黃；`state.js:14-18` `isNight()` 以主題 background 亮度 <110 判斷 | 確認 |
| 安裝只動自己的檔案 | `install.sh:7-9` 複製 `layouts/kaiju.json`、`kaiju.svg`、`themes/kaiju*-.json`；`:10` `rsync -a --delete` 只進 `mods/kaiju/` | 確認 |
| `cmd-b` 合併會先問、先備份 | `install.sh:13-36`：已綁定則讀 `/dev/tty` 問 y/N，預設保留；有變更才寫，且先複製 `keys.json.bak-<時間>` | 確認 |
| 不執行程式、不連網 | 全部 `mods/kaiju/*.js` 只 `run()` app 命令（`space.*`、`tab.*`、`pane.*`、`layout.*`、`app.settings`）；沒有 `exec()`／`hc()`（`herdr.d.ts:14-17` 兩者都存在但未 import），沒有 `fetch`／URL | 確認 |

### 文件沒說或與程式有落差

- RECIPE 把 `zz`（睡覺泡泡）列在素材清單裡，但程式只用 `bang`／`question` 兩種泡泡（`state.js:131`），`zz.png` 沒有任何使用點 → **未使用的素材**。
- `art/render.py` 仍留著 `lizard()`（:258）與 `ape()`（:280）兩個程序化怪獸繪製函式，全 repo 找不到呼叫點（commit `5f4173a` 訊息為「drop unused prototypes」）→ **殘留死碼**。實際怪獸是 AI 動作表經 `pixelize.py` 產生的。
- README 的「快捷键」表列出 `ctrl-1…9`／`cmd-1…9`，但那其實是 herdr 的全域預設鍵（本機 `keys.json:43-60`），kaiju 只合併 `cmd-b` 一個鍵（`mods/kaiju/keys.json:1-3`）。
- README/RECIPE 只保證 0.1.11；本機 0.1.16 未經作者驗證（[INFERENCE] 版面欄位差異未實測，無法確認是否仍正常）。

## 4. 架構

### layout 節點樹（`layouts/kaiju.json`，172 行）

```
root (row, titlebar none, traffic_lights[16,18], theme{light kaiju,dark kaiju-night},
      background canvas, ui_font Fusion Pixel 12px Prop zh-Hans,
      terminal_padding[12,10], divider 2px border, preview layouts/kaiju.svg)
├─ sidebar (column, px 400, resizable false, chrome)
│   ├─ city   (block, px 492, window_drag,  content mod kaiju props{part:city})
│   └─ roster (block,               content mod kaiju props{part:roster})
├─ work (column, resizable false)
│   ├─ tabs     (block, px 44, window_drag, content mod kaiju props{part:top})
│   └─ work-body (row, padding[6,12], gap 10)
│       ├─ main  (block, tab active, pane{radius 4, 2px border, focus 2px input,
│       │         header{content mod kaiju, height 28, reveal always}, lone true})
│       └─ panel (column, hidden, px 368) └─ panel-body (stack, active files)
│              ├─ files   content mod files
│              └─ changes content mod changes
└─ floating: [{id news, content mod kaiju props{part:news}, edge right, align end}]
```

`floating`、`preview`、`window_drag`、`place` 都是 herdr 既有欄位（`AGENTS.md:252-271`、`:403-411`、`:878`），本專案沒有自創 schema。

### mod 清單與職責（單一 mod、五種角色）

`mods/kaiju/mod.json`：`{ "place": "none", "title": "Kaiju City" }` — 不自動停靠，只出現在 layout 指定的位置（`AGENTS.md:888-889`）。

`main.js` 依 `props()` 分派（`main.js:16-27`）：`props().pane` → 窗格標頭（`pane.js`）；`part` = `city`／`roster`／`top`／`news`。只有 `roster` 那一份 await `nextCommand()` 接 `cmd-b`，避免多份搶命令（`main.js:19-27` 註解同一件事）。

| 檔案 | 職責 |
|---|---|
| `main.js`（42） | 分派 + 側欄快捷鍵 |
| `state.js`（177） | 純邏輯：素材路徑、晝夜、space→樓位、損壞等級（含喚醒排程）、怪獸指派與行為 |
| `city.js`（224） | 沙盤：plate／8 樓位×4 損壞級／怪獸走位與動作／深度疊放／箭頭／警報燈／點擊區 |
| `roster.js`（362） | 名冊：space 分組列、檔案卡／頭像兩種模式、戰績統計、收窄成 76px 窄欄 |
| `top.js`（116） | 頂欄：space 膠囊、tab 膠囊（怪獸頭）、Files／Changes 開關、拖曳排序 |
| `pane.js`（39） | 窗格標頭：怪獸頭＋程式名＋目錄＋擋住時「等你」標籤＋hover 分屏鈕 |
| `news.js`（84） | 浮動快訊卡 |
| `manifest.js`（2） | 由 `build_assets.py` 產生的資料（canvas／slots／monsters／entry／fx／fxSize／sprite），與 `assets/manifest.json` 內容完全相同 |

### 使用的 herdr API（具名）

`spaces`、`agents`、`panes`、`setAgentOrder`、`run`、`openOverlay`、`props`、`theme`、`window`、`layout`、`shared`、`setShared`、`nextCommand`、`home`（14 個，`grep -rh 'from "herdr"'`）。gpui-kit 只用 `View`、`div`、`image`、`svg`（＋`gpui-base` 的 `v_flex`／`h_flex`）。

執行的 app 命令：`space.select/new/rename`、`tab.select/rename/move`、`pane.focus`、`layout.hide/resize/show/select`、`app.settings`。**沒有 `exec`、`hc`、`terminal.*`**。

借用其他 mod 的資源：`mods/menu`、`new-menu`（右鍵選單與開新 tab 的 popup）、`files`、`changes` 與它們的內容 mod；圖示取自 `mods/workspace-chrome/{plus,settings,chevron-left,chevron-right,x}.svg`、`mods/pane/{split-right,split-down,zoom,unzoom,close}.svg`、`mods/files/file.svg`、`mods/changes/changes.svg`（本機 `installed.json` 可對到這些檔案）。

### 資料來源與外部程式

零外部程式、零網路。唯一資料來源是 herdr 的記憶體 API（`spaces()`／`agents()`／`panes()`／`layout()`），加上自己寫進 `shared()` 的四把鍵。`props().demo` 是截圖用的假資料通道（`city.js:96-105`、`roster.js:274-280`、`news.js:33-39`）。

## 5. agent／session 處理

**怎麼知道誰是 agent**：交給 herdr。`agents()` 的定義是「程式主動回報狀態（OSC 7501）的終端」（`AGENTS.md:153-156`、`herdr.d.ts:192`），狀態值固定 `working | blocked | done | idle`（`herdr.d.ts:93`）。kaiju 完全不自行判斷 agent 種類。

| 面向 | kaiju 的做法 | 證據 |
|---|---|---|
| 種類（CLI 品牌） | 只顯示：`a.program?.name ?? a.app ?? "Agent"`（檔案卡的「程序」欄），不區分模型或供應商 | `roster.js:78`、`:233` |
| 狀態 | 直接吃 `a.status`；另用 tab 的 `changed_at`（blocked/done 起算）與 `working_since`（working 起算）算計時文字 | `roster.js:65-76`、`herdr.d.ts:117-120` |
| model | 完全沒有。全 repo grep `model` 只命中字型授權文字 | `grep -rniE "model\|effort\|token\|usage\|cost\|quota"` |
| effort | 完全沒有（同上） | 同上 |
| 用量／額度 | 完全沒有；名冊「戰績」只記「拆 N 棟 · 今天 X 分」，來源是自己算的 working→非 working 區間 | `roster.js:107-149`、`:239` |
| 需要 hook／extension／腳本嗎 | 不需要。純讀 herdr API；`install.sh` 只複製檔案與合併按鍵 | `install.sh`、`main.js` |
| 身分鍵 | `AgentInfo.address`（終端位址）；怪獸指派、快訊、卡片都以 address 為鍵 | `state.js:141`、`news.js:17` |
| 跨重啟保存 | `shared()` 會落盤（`herdr.d.ts:445`「persisted」，本機 `~/.config/herdr-app/shared.json`） | — |
| `/new` | 新 space 的樓會從地面彈起（`city.js:32-47` `rising()`，第一次渲染已有的不算）；新 agent 取清單中下一隻怪獸 | 程式碼 |
| `/resume` | 沒有 session 概念，只有終端 address。若 agent 短暫從 `agents()` 消失，`assign()` 會把它從 map 剔除（`state.js:148`），回來時拿到**下一隻**怪獸（`n` 單調遞增、不回退） | `state.js:135-151` |
| `/move`（切換 cwd／city） | 沒有處理；只有終端標題與 space 名會在下一次 render 反映到「任務／驻地」欄 | `roster.js:81-97` |
| subagent | **不顯示**。herdr 的 subagent 是 agent 用 `hc run` 啟動、記在 `terminals()` 的 `parent`、且「沒有 pane」，而 kaiju 只看 `agents()`（＝有 pane 的終端）；內建 `agents` mod 另外用 `terminals()` 畫樹（`mods/agents/main.js:172`） | `AGENTS.md:157-162`、本機 `mods/agents/main.js:54,172` |
| 多 machine | `spaces()` 含遠端 space（`SpaceInfo.machine`，`herdr.d.ts:133-134`），所以遠端 space 也會依序吃掉前 8 個樓位；agent 是否出現取決於 herdr 是否為該 machine 的 space 啟動終端（`AGENTS.md:149-152`） | 程式碼＋文件 |
| 超過 8 個 space | 第 9 個以後沒有樓：`slotOf()` 回 `null`，名冊 tooltip 顯示「（不在沙盤上）」，怪獸不上台（`behaviors()` 給 `slot:null`） | `state.js:39-42,157-166`、`roster.js:287` |

[INFERENCE] 「agent 消失再回來會換怪獸」是從 `assign()` 的 prune + `n` 遞增推得；未實機驗證。這也意味著怪獸身分不隨 session 穩定。

## 6. 視覺與美術

- **風格**：等距 3/4 斜視像素藝術（`render.py:1-21` 逐像素等距投影＋深度緩衝）；自繪 8 樓位、天空雲、街道、海、樹、小車；怪獸是 Q 版 chibi（大頭約身高一半、深色 1px 描邊、平面 3–4 階上色）。
- **素材數量**：`mods/kaiju/assets` 355 個檔案 = day 177 + night 177 + `manifest.json` 1；單一模式內含 1 張 plate、8 樓位 ×（4 損壞級＋空地）、8 隻怪獸 × 16（5 動作＋5 頭像 head＋5 大頭 avatar＋1 咆哮臉）、8 個特效。另有 `art/ai/` 8 張 AI 動作表（每張約 1.2–1.4 MB）。
- **製作方式（可重複管線）**：
  1. `art/render.py`（545 行）程序繪製城市：樓位座標硬編碼在 `SLOTS`（:323-333），逐像素投影、深度緩衝、自動描邊與高光（`finish()` :478-505），夜晚用 `night()` 壓暗 38% 並讓 38% 窗戶亮暖黃（:129-131）。
  2. `art/pixelize.py`（120 行）把 AI 動作表去白底（只去從邊緣連通的白色，保留角色身上的白）、依列空隙切 5 姿勢、統一縮放到 60px 高、統一調色盤、加 1px 描邊。
  3. `art/build_assets.py`（445 行）產出全部素材與 manifest，並負責兩件「生成期」難題：(a) 為每棟樓自動挑 2–4 個站位，要求露頭、不擋住自家樓、與其他站位拉開距離，並算出「要在哪些樓之後、哪些樓之前」的深度值（`pick_stands` :43-112，條件不滿足直接 assert 失敗）；(b) 用 70% 高度內、輪廓內部的最深像素求五官中心，再裁 48px 頭像／32px 大頭／32px 咆哮臉（`face_center` :199、`head_crop` :211）。
- **解析度策略**：1 美術像素 = 1 邏輯像素，2× 最近鄰放大匯出（`save2x` :19-22）；頭像以 1× 存 48px 顯示成 24px（整倍數不模糊），大頭以 3× 存 96px 顯示成 48px，快訊臉 2× 存 32px 顯示 32px（`build_monsters` :226-261 註解）。
- **動畫做法**：走路用 `.transition("left"/"top", {duration: 900})` 配合走路幀（`city.js:111-117`、`:53-94`）； shaking／dust／siren／箭頭用原生 `.loop()`（`:112-113,174,179,184,196-198`）；新樓升起與快訊臉落回用 `.spring()`（`:172`、`news.js:60`）。全部用**一次性** `cx.timer.after` 喚醒重繪，不用 `every`；沒有 agent 在工作時不重繪（`RECIPE`「Watch out」段、`roster.js:306-310`）。
- **空間感**：樓與怪獸按 manifest 的 `depth` 從後往前畫，樓用 `overflow_hidden` 裁在底邊以上，走路中的怪獸暫時置頂避免鑽進樓後（`city.js:148-175` 註解）。
- **授權限制**：程式 MIT；字型 OFL 1.1（7 MB，必須一起散布授權檔）；怪獸是 AI 生成並在 prompt 中要求原創、不得抄襲既有角色（`art/ai/cand-moth/moth-sheet.prompt.txt`），但 AI 生成素材的著作權狀態本身仍有不確定性（[INFERENCE]）。

## 7. 累積與持久化

有，但只保存**遊戲化小狀態**，沒有工作成果的累積。

| shared 鍵 | 內容 | 寫入點 |
|---|---|---|
| `kaiju.monsters` | `{map: {address: monsterId}, n}` | `state.js:135-151`，只在名單變動時寫 |
| `kaiju.damage` | `{spaceId: 0..3}` | `city.js:16-21`，只在值變化時寫 |
| `kaiju.stats` | `{day, by: {address: {razed, ms, start, status}}}`；`razed` 每完成一輪 working→done/idle +1，`ms` 為當日工時、跨日歸零 | `roster.js:107-149` |
| `kaiju.roster` | `"file"` 或 `"mini"`（名冊模式） | `roster.js:272-274,356` |

存放位置是本機 `~/.config/herdr-app/shared.json`（herdr 的共用狀態檔，`herdr.d.ts:445-449`「persisted／every mod re-renders」）。**沒有**寫入任何自有檔案、沒有資料庫、沒有跨 session 的歷史紀錄：`Damage` 只在記憶體 Map 中維護當前等級（`state.js:66-126`），離開 `spaces()` 的 space 立刻被刪除（`:115`）；agent 從名單消失也立刻從 `stats` 與 `monsters` 刪除（`roster.js:146`、`state.js:148`）。也就是說：**沒有任何「回看過去」的能力**，只有「現在長什麼樣」。

## 8. 安裝、隱私與安全

安裝（README「Install」、`install.sh`）：

1. `git clone` 後執行 `./install.sh`；目標目錄為 `HERDR_APP_HOME` 或 `~/.config/herdr-app`。
2. 複製 `layouts/kaiju.json`、`layouts/kaiju.svg` → `layouts/`；`themes/kaiju.json`、`themes/kaiju-night.json` → `themes/`。
3. `rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' mods/kaiju/ → mods/kaiju/`（`--delete` 的範圍僅限自己的資料夾）。
4. 用內嵌 Python 合併 `keys.json`：同名鍵已存在時讀 `/dev/tty` 詢問，預設保留；有變更才寫，且先備份為 `keys.json.bak-YYYYmmddHHMMSS`。
5. 切換：`herdr-app do layout.switch '{"name":"kaiju"}'`；卸載＝切回別的 layout 後刪掉那 5 個路徑。

讀取與執行：

- 讀取的是 herdr 記憶體 API 與「自己的」`mods/kaiju/*`、`themes/*`（`image()`/`svg()` 只載入 `mods/kaiju/...` 與少數借用 mod 的圖示）；不讀專案檔、不讀使用者的原始碼或 session 檔。
- 只呼叫 app 命令（清單見 §4），不 `exec`、不 `hc`、不連網（README 也自述「It runs no programs and makes no network calls」）。
- 只有 `home()` 用來把 cwd 縮寫成 `~`（`pane.js:208-212`）。

風險：

1. `run("layout.resize"/"hide"/"show")` 會改動使用者的 layout 狀態（macOS 上側欄 400↔76），這個改動會持久化（`AGENTS.md:215-220`：點擊與尺寸狀態存在 `layouts/.state/` 並在重啟後保留）。要復原得手動改回或 `layout.reset`。
2. `rsync --delete` 會刪掉 `mods/kaiju/` 內任何非 repo 檔案（自訂 patch 會被清掉）。
3. 需要系統 python3（只為合併 `keys.json`）；非互動環境下沒有 `/dev/tty` 會直接保留原綁定（安全但靜默）。
4. 依賴多個「別人的 mod」的圖示路徑（`workspace-chrome`、`pane`、`files`、`changes`）：若使用者移除或改版那些 mod，圖示會載入失敗（`AGENTS.md:212-213` 說明未再隨附的東西會被移除）。

## 9. 優點與限制

**優點**

1. **狀態→演出做得完整而具體**：4 種狀態各有動作幀、表情、氣泡、樓頂燈號；損壞分 4 級並由真實工時驅動（2 分／8 分），而且刻意避開 `space.status` 的緊急度蓋台問題（`state.js:52-63` 有註解說明設計理由）。這是同類專案裡最細的一條「狀態語意」鏈。
2. **美術是資料驅動、有可重複管線**：AI 動作表 → 統一像素化 → manifest（站位／深度／命中框／樓頂高度）；前端只讀 manifest，換怪獸不用改程式（README「Swap the monsters」）。
3. **效能紀律**：零網路、零外部程式、單一 mod 檔 1 KB 級；動畫用原生 `loop`／`transition`／`spring`，其餘一律一次性 timer，沒人工作時完全不重繪（`roster.js:306-310`）。
4. **安裝禮貌**：只碰自己的檔案、`keys.json` 先問先備份、可完全卸載、`HERDR_APP_HOME` 可覆寫。
5. **空間感處理到位**：站位的深度由生成器保證「該在前的不落後」，樓體裁切與走路置頂處理了遮擋，比純 2D 平鋪耐看（`city.js:148-175`）。
6. **文件品質高**：README 給使用者、RECIPE 依 herdr 六段格式（What you see／How it behaves／Built from／Watch out／Done when）給「另一個 agent 從空資料夾重建」，兩份都與程式對得上（除 §3 列出的三處小落差）。

**限制**

1. **沒有任何累積**：只有「當前狀態的舞台」與每 agent 的拆樓次數／當日工時；agent 或 space 消失資料即刪除（`state.js:115`、`roster.js:146`），沒有跨 session 的城鎮、領土、資源或歷史。
2. **不吃用量**：沒有 token、成本、model、effort、額度；無法回答「這裡花了多少」或「哪個 provider 投入最多」。
3. **身分綁終端 address 而非 session**：`/resume`、`/move`、subagent 都沒有支援；agent 離開再回來會換到下一隻怪獸，`n` 只增不減（[INFERENCE] 未實測；見 §5）。
4. **硬上限 8**：第 9 個 space 以後沒有樓，也沒有任何分頁或卷動策略；站位清單是生成期的固定產物，執行期無法擴張。
5. **無測試、無 CI**：repo 內沒有測試檔，`RECIPE` 的「Done when」是人工檢查清單（`herdr-app check` 等）。
6. **介面字串硬編碼**：全部中文字串寫在 JS 裡，社群 PR #1（kagermoe，2026-11-05 開、未合併、之後作者無回應）要把字串抽成 `strings.js` 才做得出英文版；`pushed_at` 停在 2026-11-03，附帶說明目前沒有維護活動。
7. **平台假設**：macOS＋herdr 0.1.11 驗證；窄欄的 50px 標題列留白與 `layout.hide` 行為都是平台相關（`roster.js:313-314`）。

## 10. 與我們提案 v6 的比較

### 重疊

- 都以 herdr 的 `space`／`agent`／`status` 為唯一資料來源，都用 gpui-kit 靜態圖片＋原生元件，都主張「不要 HTML/CSS」。
- 都把 agent 狀態當成最主要的視覺驅動訊號，都在側欄做「agent 卡片」。
- 都用主題（light/dark）切換一套替換素材的做法。

### 差異

| 面向 | herdr-kaiju | 提案 v6 |
|---|---|---|
| 主體 | 一頁「現在的狀態」的舞台＋名冊 | 以 `(cityId, rootSessionId)` 為單位的遠征與可回看的城鎮 |
| 空間 | 固定 8 樓位的離線排版腳本 | 無限平面、BFS 自動選地、開墾才揭開鄰格（§4） |
| 投入 | `working_since` 只換算損壞等級 | 同樣的區間換算成每分鐘 +1 開墾點（§10） |
| 成果 | 無 | 驗收成果換木材／石材／鐵料／羊皮卷，claim key 防重複（§7、§8） |
| 身分 | herdr agent `address`（終端） | session ID＋`parentSessionId`，subagent 歸戶到 root（§6.1） |
| 資料累積 | 只有 4 把 shared 鍵，值會被 prune | append-only 帳本（收成快照、baseline、interval、usage 游標），CAS 寫入（§7.4） |
| CLI 覆蓋 | 只吃 herdr 回報的 agent（含非 omp 的 CLI，只要是 OSC 7501） | adapter 制，OMP 為參考；明確排除沒有 adapter 的 shell（§1、§6） |
| 回看 | 沒有 | MVP 的核心驗收目標（§12） |

注意一個容易被忽略的事實：**kaiju 在「agent 偵測」上其實是靠 herdr 自己（OSC 7501）**，所以它天然支援任何會回報狀態的 CLI；我們的 adapter 制換取的是 session／cwd／usage／parent 這些 herdr 不提供的資訊，代價是要為每個 CLI 各寫一份。

### 它做得比我們好的地方（可借用）

1. **「狀態→具體演出」的完整度**：每個狀態都對到動作幀、表情、氣泡、樓上燈號與樓體損壞級；v6 的城鎮若一格只是一個進度條，感染力會遠低於此。建議 v6 把「開墾中／駐紮／可收成／已建」也各自給一個確定的地面演出與動作，並在規格裡寫死（像 `FACE`／`MODE`／`BUBBLE` 三張表那樣）。
2. **生成期算好的空間資料**：`manifest` 把「站位座標＋深度區間＋命中框＋各損壞級的樓頂高度」全部離線算完（`build_assets.py:125-162`、站位見 `pick_stands` :43-112），前端只做排序與畫圖。v6 §4 的「地面格為準、屋頂只是裝飾」可直接沿用這個資料分工：把投影／深度／命中框在生成期產出，執行期只組合。
3. **深度與遮擋的正確處理**：`items.sort(depth, order, y)` ＋ 走路中置頂 ＋ 樓體 `overflow_hidden`（`city.js:148-175`）是可以直接照抄的模式。
4. **安裝的禮貌做法**：只複製自己的檔案、`keys.json` 先問先備份、`--delete` 限定自己資料夾、可完整卸載（`install.sh`）。
5. **晝夜不靠設定檔**：`isNight()` 用主題 `background` 的亮度 <110 判斷（`state.js:14-18`），不必讀 `settings.json`，也不會和其他 layout 的設定打架。
6. **效能紀律**：一次性 timer 只在必要時喚醒；有 working agent 才每分鐘刷新計時（`roster.js:306-310`）。v6 的 ledger 寫入與 render 必須有同等的節制（尤其是 CAS 提交）。
7. **文件模板**：`RECIPE.md` 的六段結構（What you see／How it behaves／Built from／Watch out／Done when）＋「可以直接交給另一個 agent 從空資料夾重建」是很好的交付格式，v6 若要做 mod 應照此寫。
8. **名冊的兩段式顯示**：寬時檔案卡、窄時 48px 頭像磚（`roster.js:301-361`、`WIDE=400/RAIL=76`）＋`cmd-b` 切換，是側欄空間不足時的實用解法。

### 應避免的坑

1. **不要把身分綁在終端 address**：kaiju 的 `assign()` 會 prune 不在名單中的鍵、`n` 只增不減（`state.js:135-151`），導致重開就換怪獸。v6 以 session ID 為主鍵（§5.2、§6.1）正是為此，別為了省事退回 address。
2. **不要只存「當下狀態」**：`Damage` 是記憶體 Map、離開即刪（`state.js:115`），`stats`／`monsters` 也會 prune（`roster.js:146`、`state.js:148`）。v6 的收成快照與 interval 必須是不可變、可重播的紀錄。
3. **不要用彙總狀態分類**：kaiju 自己註明不能用 `space.status`，因為 blocked 會蓋掉 done（`state.js:52-54`）。v6 的分類要逐成果路徑判定，不要先彙總 session 狀態再分（§8.2 的分類優先序即是此意）。
4. **不要在 render 路徑做重事或寫入**：`Damage.update()` 每次 render 都被呼叫（`city.js:129`），只是內部有變更檢查。v6 的 CAS 提交、git baseline 掃描屬昂貴操作，必須放在明確的收成動作裡，而不是 render。
5. **固定格數與生成期站位不可動態擴張**：kaiju 的樓位、站位、深度全是離線常數（`render.py:323-333`、`manifest.js`），第 9 個 space 就沒有樓。v6 聲明無限平面，必須真的做到邏輯座標與投影分離（§4），不能靠「先算好一小塊圖」。
6. **避免語言硬編碼**：kaiju 的中文字串散在五個檔案裡，社群 PR #1 得先重構字串表。v6 一開始就把介面字串抽成 `strings.js` 之類的表。
7. **沒有測試與驗證條件就沒有可信度**：kaiju 只留下人工的「Done when」清單。v6 至少要有固定情境的劇本檢查（記憶體中的專案慣例也明確要求：MVP 用固定情境資料試玩，不要只證明連線可用）。
8. **別忘了舊版本相容性**：kaiju 只在 0.1.11 驗證，本機已是 0.1.16。v6 依賴的 `herdr.d.ts` 欄位（尤其 `TabInfo.working_since`／`changed_at`）要在目標版本上先確認。

## 11. 證據清單

實際讀過的檔案／URL：

- `Jiqize/herdr-kaiju` main（clone 至 `/tmp/kaiju-research/herdr-kaiju`，`git log --format='%h|%ad|%s'`、`git shortlog -sne`、`git status`）：`README.md`、`RECIPE.md`、`LICENSE`、`.gitignore`、`install.sh`、`preview.png`（僅檢視檔名／大小）、`layouts/kaiju.json`、`layouts/kaiju.svg`（前 600 bytes）、`themes/kaiju.json`、`themes/kaiju-night.json`、`mods/kaiju/{mod.json,keys.json,manifest.js,main.js,state.js,city.js,roster.js,top.js,pane.js,news.js}`、`mods/kaiju/icons/*`、`mods/kaiju/assets/manifest.json`、`art/roster.json`、`art/render.py`（全檔關鍵段落）、`art/pixelize.py`、`art/build_assets.py`、`art/ai/cand-moth/moth-sheet.prompt.txt`。
- GitHub API：`/repos/Jiqize/herdr-kaiju`、`/repos/Jiqize/herdr-kaiju/issues?state=all`、`/commits?per_page=50`、`/pulls/1`、`/pulls/1/files`、`/branches`、`/tags`、`/releases`、`/users/Jiqize`。
- 本機基準（唯讀）：`~/.config/herdr-app/herdr.d.ts`（:93、:98-121、:123-142、:155-190、:233-238、:268-271、:403-411、:430-460）、`~/.config/herdr-app/AGENTS.md`（:29-37、:149-162、:212-220、:252-271、:403-411、:458-490、:872-889）、`~/.config/herdr-app/{installed.json,keys.json,shared.json,settings.json}`、`~/.config/herdr-app/mods/agents/main.js`（:1、:54、:172）、`herdr-app --version`。

未查到的部分：作者對 PR #1 的任何回覆或計畫（`pushed_at` 停在 2026-11-03）；本機未安裝 kaiju，未實機執行，因此「0.1.16 上是否仍完全正常」與「agent 消失再回來是否真的換怪獸」兩點未能實測。
