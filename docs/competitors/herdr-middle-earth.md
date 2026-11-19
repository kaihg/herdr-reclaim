# 競品分析：herdr-middle-earth

> 研究日期 2026-11-19。方法：`git clone --depth 50` 到 `/tmp/herdr-middle-earth-research` 讀原始碼（讀完刪除），並與本機 herdr-app 0.1.16 的內建模組逐行 diff（`~/.config/herdr-app/mods/{agents,spaces,workspace-status,toast}/main.js`）。
> 唯讀研究：未安裝、未執行該專案腳本、未切換本機 layout、未修改 `~/.config/herdr-app`。
> 標記：`[INFERENCE]` 為推論；文件宣稱與程式不一致處直接列出。

---

## 1. 基本資訊

| 項目 | 內容 | 證據 |
|---|---|---|
| Repo | `github.com/joaovitorwoliveira/herdr-middle-earth`（main） | GitHub API（read 工具） |
| 作者 | 單一作者 joaovitorwoliveira（28 個 commit 全為同一人） | `git log` |
| 授權 | MIT（`LICENSE:1-3`，Copyright (c) 2026 joaovitorwoliveira）；`mods/fellowship/fonts/` 例外，為 GUST Font License（LPPL 1.3c） | `LICENSE`、`README.md`、`mods/fellowship/fonts/GUST-FONT-LICENSE.txt:1-12` |
| Stars / Forks / Issues | 3 / 0 / 0（2026-11-19） | GitHub API |
| 首次 commit | 2026-11-17 11:36 -0300 `74e1a17 Add Middle-earth layout for Herdr` | `git log --reverse` |
| 最近 commit | 2026-11-18 15:47 -0300 `3d01f2d Let Gandalf come as Epic Sax Gandalf, one time in a hundred` | `git log -1` |
| Commit 數 | 28（repo 存在約 2 天） | `git rev-list --count HEAD` |
| 對應 herdr 版本 | 0.1.16（唯一宣稱版本；`layouts/middle-earth.json:3-6` 與四個 `mod.json` 的 `cloned_from.version` 皆為 0.1.16） | `RECIPE.md:61,87`、各 `mod.json` |
| 語言 | mod 為 JavaScript（gpui-kit，非 HTML/CSS）；工具為 Python 3；安裝為 Bash | `.js`/`.py`/`install.sh` |
| 檔案規模 | `mods/fellowship/main.js` 609 行、`mods/realms/main.js` 578、`mods/fellowship-toast/main.js` 153、`mods/fellowship-status/main.js` 58、`mods/fellowship/agent-stats.js` 59、`casting.js` 17、`layouts/middle-earth.json` 194、`tools/sprites.py` 1075、`install.sh` 92；共 186 檔、13 MB（字型 868 KB、sprites 1.3 MB、docs 840 KB） | `wc -l`、`du -sh` |

## 2. 一句話定位與主題

「一個 layout 統御你的 agents」：agent session 變成《魔戒》遠征隊員，space 變成國度，淺色模式是夏爾、深色模式是魔多（`README.md:5-9,18`）。它是**純外觀與敘事層**——把 herdr 內建的 `agents`／`spaces`／`workspace-status`／`toast` 四個模組 clone 後改寫，加上像素角色動畫、領地徽章、角色化通知與主題；**不追蹤工作成果、不累積城鎮、不讀 provider 用量**。

| 中土元素 | 對應的 herdr 實體 | 鍵／實作 |
|---|---|---|
| 遠征隊員（Gandalf…Sauron） | **agent**（會回報狀態的終端） | shared `fellowship.cast`，鍵為 terminal address（`main.js:87,142-169`）；深色才納入 Sauron（`:158`）；3% 稀有／1% sax（`casting.js:9-16`） |
| 狀態與台詞 | agent 的 `status`（blocked/done/working/idle） | `MOOD`＋`ROAD_STAGES`（`main.js:101-110`，working 依時長升階）、sprite 姿勢（`:132-138`）、toast 台詞（`fellowship-toast/main.js:21-50`） |
| 國度（Shire…Mordor） | **space** | shared `realms.emblems`，鍵為 space id（`realms/main.js:56-78`），只換掉側欄的頭像 |
| 地圖 | **不存在** | 沒有格子、地形、相鄰或座標；「空間」只有 sidebar 的兩份清單（space 清單＝國度、agent 清單＝隊員）。全 repo 無座標／網格相關程式。 |

## 3. 功能清單

### 3.1 文件宣稱（README／RECIPE）

- 角色：Gandalf、Aragorn、Frodo、Sam、Legolas、Gimli；深色模式多一個 Sauron（`README.md:24`）。
- 四種狀態動畫：idle 抽煙斗、working 戰鬥、blocked 舉 `!`、done 帶回魔戒；working 越久台詞越遠（10 分鐘 "Far from home"、30 分鐘 "Into the Wild"、60 分鐘 "Into Mordor"）（`README.md:25-28`）。
- 卡片堆疊 model、粗體 space、session 名、context 使用率 bar（`README.md:29`）。
- space 領地徽章共 7 個：Shire、Rivendell、Gondor、Rohan、Lórien、Moria、Mordor（`README.md:31`）。
- 角色化 toast 與 macOS 通知；Dock badge 顯示等待中的 agent 數；狀態列統計各狀態數量（`README.md:32-34`）。
- 稀有版（3%）與超稀有 Epic Sax Gandalf（1%）（`README.md:43,59`）。
- model 與 context 是「從 agent 螢幕上讀出來的」，需要 Claude Code statusline 配合（`README.md:94-102`）。
- 附：Claude Code 持戒圖示、哈比門 shell 圖示、TeX Gyre Pagella 字型、自製提示音（`README.md:35`）。

### 3.2 程式確認有

| 宣稱 | 程式證據 | 判定 |
|---|---|---|
| 6+1 角色、深色才加入 Sauron | `mods/fellowship/main.js:83-85,158`（`CAST`／`DARK_LORD`，`pool = settings().dark ? [DARK_LORD, ...CAST] : CAST`） | 一致 |
| 四狀態動畫與姿勢檔名 | `main.js:101,125-138`（`MOOD`、`twoFrames`、`heroSprite`） | 一致 |
| 工作時長階梯 10/30/60 分鐘 | `main.js:104-110`（`ROAD_STAGES` 60/30/10 分鐘 → "Into Mordor"/"Into the Wild"/"Far from home"） | 一致 |
| context bar 讀螢幕 | `mods/fellowship/agent-stats.js:4-58`；每 15 秒 `hc(["read", address])`（`main.js:112,186-210`） | 一致 |
| 7 個領地徽章，依 space 指派 | `mods/realms/main.js:56-78`（`REALMS` 七個、`realmsFor` 首次指派） | 一致 |
| Dock badge | `mods/fellowship-status/main.js:27-37`（`setBadge(waiting)`，只計 `blocked`） | 一致 |
| 狀態列分狀態計數 + "The road is quiet" | `fellowship-status/main.js:6-11,48-54`（`QUEST` 表） | 一致 |
| 3% 稀有、1% sax | `casting.js:9-16`；`tests/casting.test.js:37-48` 驗邊界 0.029/0.03 | 一致 |
| 角色台詞 | `fellowship-toast/main.js:21-50`（`HERO_LINES`），無台詞者回退 `"<name> <line>"`（同檔 `:99`） | 一致 |
| 系統橫幅（macOS/Linux，Windows 無） | `fellowship-toast/main.js:63-87`（`terminal-notifier` → 失敗退 `osascript`；Linux `notify-send`） | 一致 |
| 徽章畫在左上角、產生器斷言該角為空 | `tools/sprites.py:893-900`（`badged()` 內 `assert c == "." or rows[y][x] == "."`） | 一致，且徽章是**烘焙進 SVG**，非執行期疊圖 |
| sprite 宣告 36pt、24×24 網格 | `main.js:100`；`sprites/gandalf.svg` 開頭 `viewBox="0 0 24 24" width="36" height="36" shape-rendering="crispEdges"` | 一致 |

### 3.3 文件與程式不一致

- `RECIPE.md:52` 說系統橫幅用「the character's **128px** PNG」，但 `tools/banners.py:6` 的 `SCALE = 8`（24×8）產出的是 **192×192** PNG（`file` 確認）。
- `RECIPE.md:15`／`README.md:31,106` 說領地徽章是「20px」、網格 16×16，`realms/main.js:58` 也確實以 `EMBLEM_SIZE = 20` 繪製；但 `tools/sprites.py:1074` 寫徽章時沒有傳 `display_size`，落到預設 `None`（同檔 `:1062`），所以徽章 SVG 宣告的是 16×16，被拉到 20 顯示。同一檔案 `:8-9` 的註解只針對 agent sprite（24→36）處理了這件事。[INFERENCE] 徽章因此會經過一次重新取樣。
- `README.md:27-28` 說 blocked「raises a `!`」、done「bring back the Ring」；程式確認徽章為 `BADGES` 表（`tools/sprites.py:259`），但這兩個姿勢是**靜態圖**，不是動畫。

## 4. 架構

### 4.1 layout 節點樹（`layouts/middle-earth.json`，`cloned_from: main 0.1.16`）

```
root (row, bg canvas, terminal_padding [14,12], divider 1px border,
      titlebar "none", traffic_lights [12,16], toast fellowship-toast,
      theme {light: shire, dark: mordor}, ui_font "TeX Gyre Pagella",
      preview layouts/middle-earth.png)
├─ sidebar (column, 268px, min 44 / max 480, resizable false, bg chrome)
│  ├─ brand        (block, mod workspace-chrome, 46px, window_drag)
│  ├─ sidebar-lists (column)
│  │  ├─ spaces    (block, mod realms,    weight 1, min 90)
│  │  └─ agents    (block, mod fellowship, weight 1, min 90)
│  └─ sidebar-footer (block, workspace-chrome {footer:true}, 69px)
└─ work (column, resizable false)
   ├─ tabs       (block, mod tabs, 42px, window_drag)
   ├─ work-body  (row, padding 8, gap 8)
   │  ├─ main    (block, tab active + pane header mod "pane" reveal always h30 top,
   │  │           radius 10, border 1px border/focus accent, lone)
   │  └─ panel   (column, 368px, min 280 / max 900, hidden)
   │     └─ panel-body (stack, active "files") → files, changes
   └─ status     (block, mod fellowship-status, 28px)
```

所有 root key（`preview`、`toast`、`traffic_lights`、`window_drag`、`ui_font`、`cloned_from`）都在本機 `~/.config/herdr-app/AGENTS.md:203,253-258,268,276,320,347,354` 有記載，為真實欄位。

### 4.2 mod 清單與職責

| mod | 來源 | 職責 | 與內建差異（`diff` 行數） |
|---|---|---|---|
| `fellowship` | clone `agents` 0.1.16 | agent 列表、角色指派、稀有版、model/ctx 讀取、卡片版面 | 163 行差異（主要新增，見 §5） |
| `realms` | clone `spaces` 0.1.16 | space 列表（沿用內建 git/machine 邏輯）+ 領地徽章 | 30 行差異（僅 `realmsFor` 與頭像處） |
| `fellowship-status` | clone `workspace-status` | 狀態列文字 + Dock badge | 35 行 |
| `fellowship-toast` | clone `toast` | 角色化文案 + 系統橫幅 | 114 行 |
| 直接沿用未改 | 內建 | `workspace-chrome`、`tabs`、`pane`、`files`、`changes` | 0（由 herdr home 提供） |

### 4.3 使用的 herdr API（具名）

- `fellowship/main.js:3-7`：`View, div, image, svg`（gpui-kit）、`v_flex, h_flex`（gpui-base）、`agents, settings, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, hc, checking`。
- `realms/main.js:6-8`：再加 `machines, exec, watchFolder, ScrollHandle`。
- `fellowship-toast/main.js:7`：`exec, appHome, shared, window, checking, props, closeOverlay, run, theme`。
- `fellowship-status/main.js:3`：`setBadge, keys, spaces, agents, window, run, theme, checking`。
- 以上全部存在於本機 `~/.config/herdr-app/herdr.d.ts`（0.1.16）：`exec:14`、`hc:17`、`appHome:22`、`checking:25`、`run:91`、`machines:146`、`spaces:149`、`agents:193`、`panes:233`、`setAgentOrder:238`、`terminals:247`、`focused:269`、`layout:275`、`window:287`、`setBadge:305`、`theme:323`、`settings:383`、`keys:386`、`openOverlay:420`、`closeOverlay:424`、`props:443`、`shared:446`、`setShared:449`、`watchFolder:474`。**沒有使用任何不存在或未記載的 API，也沒有使用 hook／extension 機制。**

### 4.4 資料來源與外部程式

- `hc read <terminal address>`（`main.js:193`）：讀 agent 終端畫面文字（本機 `AGENTS.md:1106,1151` 記載 `hc read <t>` 為真實指令）。
- `git`（`realms/main.js:261-280`，沿用內建）：`rev-parse --show-toplevel/--git-common-dir`、`symbolic-ref`、`rev-list --left-right --count`。
- `hc machine ls --json`（`realms/main.js:181`）。
- 系統通知：`terminal-notifier` → `osascript`（macOS）、`notify-send`（Linux）。
- `watchFolder(repo)`（`realms/main.js:292`）。
- **無網路行為**：repo 內 `fetch(` 零命中（`mods/`、`tools/`）。

## 5. agent／session 處理

- **辨識 agent 種類**：不由 mod 判斷。herdr 只把「程式有回報狀態」的終端算成 agent（`herdr.d.ts:192-193`），種類來自程式自己回報的 `app`（`herdr.d.ts:180-181`，註解指名 OSC 7501，值如 "claude-code"/"pi"/"codex"）。mod 只取 `program.icon` 決定圖示（`main.js:78-81`）。
- **狀態**：`AgentInfo.status` ∈ blocked/done/working/idle → `MOOD` 文字（`main.js:101`）與 sprite 姿勢（`:132-138`）。sub-agent 額外映射：`error → blocked`、`done → idle`（`:57-60`）。
- **model**：從畫面爬取（`agent-stats.js:17-24,57-58`：pi footer、`Opus/Sonnet/Haiku/Fable`、`gpt-*`，以及 Claude 起始橫幅 `"<Model> with <x> effort"`）。
- **effort**：只有 Claude 起始橫幅那條正規式會碰到 effort 字樣，且**只捕捉 model 名，不顯示 effort**（`:24,58`）。
- **用量／額度／成本**：**完全沒有**。repo 內 `usage|cost|token|quota|budget` 零命中。README 也沒宣稱有。
- **hook／extension／腳本**：**不需要**。沒有 hook、沒有 extension、沒有背景腳本；全部走 herdr 內建模組 API + `hc` + `exec`。`init()` 以 `checking()` 保護，檢查模式下不啟 timer、不發通知（`main.js:185-187`、`fellowship-toast/main.js:110-112`）。
- **`/new`、`/resume`、`/move`**：這三者是 agent CLI（例如 omp）自己的指令，mod 完全看不到（herdr 沒有這三個指令；`AGENTS.md:560-706` 的指令清單中無此三者）。實際身分鍵是 **herdr 的 terminal address**：
  - 角色指派存在 shared `fellowship.cast`（`main.js:87,142-169`）；領地存在 shared `realms.emblems`（`realms/main.js:57,61-78`）。
  - 同一個終端裡 `/new`、`/resume`、`/move`（即使 cwd 改變）都維持同一角色；只有在 herdr 開新 terminal／space 時才是新 address，重新抽卡。
  - 回收時機：`terminals()` 中非 `live` 的 address 會被 prune（`main.js:149-153`、`realms/main.js:66-69`），且程式註解明確警告「剛啟動時 `terminals()` 是空的，那時 prune 會讓所有人重抽」——這是一個必須複製的坑。
- **「工作了多久」**：不是用 herdr 的 `TabInfo.working_since`，而是 mod 自己在 localStorage 蓋時間戳：`changed[address] = {s, at}`，且 done 與 idle 視為同一狀態（`main.js:220-235,257-259`）。
- **subagent**：以 `terminals()` 的 `parent` 建立樹（`main.js:296-305`）；有 pane 因而出現在 `agents()` 的 sub-agent 會被 `nested` 過濾掉、不另開卡片（除非 pinned，`:356-360`）。sub-agent 列**不畫角色 sprite**，只畫 program icon 與狀態（`:307-331`）。
- **多 machine**：address 帶 `machine/` 前綴（`main.js:428`），卡片右側顯示 machine 名；`realms` 沿用內建 spaces 的 machine 分組／`hc machine ls` 每 15 秒刷新／重連流程（`realms/main.js:179-231`）。
- **重啟**：`shared()` 寫入 `appHome()/shared.json`（本機檔案存在，內含 `space.colors` 等鍵），所以角色跨重啟保留；`localStorage` 是「per mod copy」（`AGENTS.md:980,1141`），換 layout 就是新的 copy。

## 6. 視覺與美術

- **風格**：像素風 24×24 網格角色 + 16×16 國度徽章（`tools/sprites.py:7`），全部以 `<rect>` 逐像素產生、`shape-rendering="crispEdges"`、dpi 無關；UI 為原生 gpui-kit 元件（無 HTML/CSS/WebGL）。
- **素材數量與製作**：105 個角色 SVG（7 角色 × 7 姿勢 + 稀有版 + `gandalf-sax`，`sprites.py:893-912`、`ls` 計數）、30 張 192×192 通知 PNG（`tools/banners.py:6-24`，8× nearest）、7 個徽章 SVG、2 個程式圖示 SVG、4 個 OTF 字型、2 個 MP3。README 的展示圖由 `tools/header.py` 產生。
- **動畫做法**：兩張圖以 `opacity` 的 linear loop 疊在一起，刻意超出 0..1（`SWAP_LOW=-6`/`SWAP_HIGH=7`）讓交叉只在一格內完成＝硬切換（`main.js:119-138`）；working 800ms、idle 1800ms。blocked／done 為靜態（徽章已烘焙）。
- **效能做法**：不用精靈圖、不用 Canvas；每個卡片最多 2 個 `image` 節點 + 1 個 loop；圖片惰性載入（`RECIPE.md:97` 明說切換後第一格可能空白）。`realms` 沿用內建的節流：每 250ms 檢查、git 最多同時 6 個、前台時 60 秒 fallback（`realms/main.js:38-42,117`）。
- **授權限制**：
  - 字型 TeX Gyre Pagella 為 **GUST Font License（LPPL 1.3c）**，與 MIT 不同，license 檔已隨附（`mods/fellowship/fonts/GUST-FONT-LICENSE.txt`）。
  - `program-icons/claude.svg` 的 path 資料與本機 herdr 內建 `icons/claude.svg` **完全相同**（僅加金環並改 `<title>`）。herdr 的 icon 集合宣告為 Simple Icons（CC0）／Lucide（ISC/MIT），並註明「Brands are their owners' trademarks」（`~/.config/herdr-app/icons/LICENSES.md:3-8`）。
  - `program-icons/shell.svg` 是本機內建 `shell.svg`（Lucide `terminal` glyph）的重繪。
  - 兩個 MP3 的來源與授權**未查到**（repo 無說明，ID3 只顯示 `Lavf59.27.100` 編碼器）。
  - 角色本身（Gandalf／Sauron 等）為托爾金／電影相關名稱，repo 未處理商標問題。

## 7. 累積與持久化

| 儲存 | 位置 | 內容 | 證據 |
|---|---|---|---|
| shared | `appHome()/shared.json` | `fellowship.cast`（address→角色）、`fellowship.rare`（address→`{name, sprite}`）、`realms.emblems`（space id→領地）、`sidebar.width`/`sidebar.collapsed` | `main.js:87-89,166-167`、`realms/main.js:57,76`、`main.js:24-26`；本機 `~/.config/herdr-app/shared.json` 實際存在且含 `space.colors`／`sidebar.*` |
| localStorage | 每個 mod copy | `fellowship`：`changed`（狀態時間戳）、`pins`（待重試的 pin）；`realms`：`machines.reconnecting`、`machines.folded` | `main.js:176-180,234,253`、`realms/main.js:109-113,196,221`；語意見 `AGENTS.md:980,1141` |
| 無 | — | 沒有城鎮、資源、歷史、收成、session 存檔；沒有 `appHome()/data/...` 寫入 | 全 repo 無相關寫檔 |

即：**跨重啟保留的是「身分指派」（誰演誰、哪個 space 是哪一國），不是工作累積。**

## 8. 安裝、隱私與安全

**安裝**（`install.sh`）：

1. 前置：`python3` 必須存在（`:17`），`HERDR_APP_HOME` 必須已是 herdr home（`:18`）。
2. 備份：任何要覆蓋的檔案先 `mv` 到 `backups/middle-earth-<timestamp>/`（`:10,21-27`）。
3. 複製 4 個 mod、2 個 theme、layout `.json` + `.png` 進 herdr home（`:12-13,32-43`）。
4. 以 Python deep-merge `settings.snippet.json` → `settings.json`（`sounds.enabled/done/blocked`）與 `programs.json` → `programs.json`（`claude.icon`、`shell.icon`）（`:46-73`，會覆蓋使用者同名鍵）。
5. 若 `herdr-app` 存在：對每個 mod 執行 `herdr-app check`，再 `layout.switch middle-earth`（`:75-81`）。
6. 未安裝 `terminal-notifier` 時印提示（`:83-90`）。

**讀取的檔案**：repo 自身檔案；使用者 home 的 `settings.json`、`programs.json`（讀後重寫）。
**執行的指令**：`herdr-app check`、`herdr-app do layout.switch`；執行期再執行 `hc read`、`git`、`terminal-notifier`／`osascript`／`notify-send`、`hc machine ls`。
**網路**：無（無 `fetch`）。
**風險**：

- `hc read` 每 15 秒讀取每個 agent 終端的畫面文字（`main.js:112,193`）。讀到的內容只用來解析 model／context 百分比，存在記憶體 `this.stats`（`main.js:184`），協定中**不落地、不外傳**；但畫面內容（含任何貼在終端裡的機密）確實會經過 mod 的記憶體與 `console.warn` 訊息（`:199`）。
- `install.sh` 會覆蓋使用者的全域 `settings.json`／`programs.json` 鍵，且這些設定影響**所有** layout（`RECIPE.md:73-76,90`）；有備份但**沒有卸載腳本**，回滾要手動。
- `osascript`／`terminal-notifier` 需要使用者額外授權（`README.md:79-92`、`RECIPE.md:91-94`）。
- 只在 macOS 實測；Linux／Windows 未測（`README.md:63`、`RECIPE.md:87`）。

## 9. 優點與限制

**優點**

1. **與上游版本嚴格對齊且改動可控**：四個 mod 都是 `cloned_from` 內建同名 mod 0.1.16，diff 只有 30～163 行；升級時衝突面小。
2. **可重現的素材管線**：圖只存在於 `tools/sprites.py` 的字元網格，改圖→重跑腳本（`CONTRIBUTING.md:17-23`），且有「徽章必須畫在空角落」等斷言。
3. **安裝流程有護欄**：備份→複製→`herdr-app check`→`layout.switch`，並在 `RECIPE.md` 明列「安裝不只 copy layouts/mods，還要 themes、preview png、settings/programs 合併」。
4. **身分指派跨重啟保留**，且明確處理「剛啟動 `terminals()` 為空不可 prune」這個真實坑（`main.js:148-153`）。
5. **純外觀層、零網路、零 hook**：只用 herdr 既有 API（全部在本機 `herdr.d.ts` 可查），對使用者的隱私足跡僅限終端文字讀取。
6. **決策邏輯有測試**：`casting.js` 的機率與 `agent-stats.js` 的解析都有 `node --test` 覆蓋，含 0.029/0.03 邊界與「最後一行優先」。

**限制**

1. **model／context 靠螢幕爬取**：使用者必須自己設定 Claude Code statusline，正規表達式與 CLI 輸出格式強耦合；讀不到就只是沒有 bar（`README.md:94-102`）。
2. **沒有任何用量、額度、成本或成果資訊**，也沒有跨 session 累積；「成長」只有機率抽卡與動畫。
3. **工作時長用 mod 自己的 localStorage 時間戳**而非 herdr 的 `working_since`；localStorage 為 per-copy，清掉或換 layout 就重算（`main.js:176,222-235`）。
4. **主題對應淺**：`realms` 對 space 只換頭像（7 個循環再用），其餘 578 行幾乎是內建 `spaces` 原樣；`fellowship` 的角色也不影響任何功能語意。
5. **平台與相依限制**：只在 macOS 實測；系統橫幅依賴 `terminal-notifier`（macOS）／`notify-send`（Linux），Windows 只有 in-app toast。
6. **素材歸屬沒交代清楚**：MIT 只聲明程式，repo 內沒有任何素材來源註記；角色圖只存在於 `sprites.py` 的像素網格（無法從 repo 確認是否全為原創），兩個 MP3 的來源與授權未查到，`claude.svg` 沿用 herdr 的品牌圖示（商標不隨 CC0 授權）。

## 10. 與我們提案 v6 的比較

**重疊**

- 同為「herdr layout + clone 內建模組改造」路線，且都把 **space** 當成地圖／領地單位（它們是 `spaces` → 國度徽章；我們是 repo 的 canonical git common dir → 城）。
- 都用 `shared()` 做跨重啟的身分指派並在實體消失時 prune。
- 都把 provider／CLI 當成視覺風格來源（它們是角色，我們是派系風格）。

**主要差異**

| 面向 | herdr-middle-earth | 提案 v6 |
|---|---|---|
| 身分鍵 | herdr terminal address | `(cityId, rootSessionId)`，由 extension 取得 |
| 資料取得 | 內建狀態回報 + 螢幕爬取 | adapter／extension（session、cwd、usage） |
| subagent | 父終端下的樹狀列，不另立身份 | 併入 root 格子並聯集 active interval |
| 累積 | 無（只有抽卡與徽章指派） | 開墾點、資源、羊皮卷、城鎮存檔與回看 |
| 存檔 | shared.json + localStorage | 每城 ledger + CAS 寫入 |
| 動畫 | 有（狀態動畫、稀有版） | MVP 不做動畫，靜態素材 |

**它做得比我們好的地方**

1. **安裝與檢查腳本**：`install.sh` 的「備份到 `backups/<name>-<time>/` → 複製 → `herdr-app check` → 切 layout」比我們目前只有提案文件完整；我們的 mod 也會需要 themes 素材，屬同一類問題。
2. **文件與程式並行維護**：`RECIPE.md` 有「What you see / How it behaves / Watch out / Done when」，把「安裝者必須額外處理的檔案」寫成清單，這正是我們的驗收條列需要的格式。
3. **窄側欄的資訊階層**：卡片每行各自 truncate、高度依行數自適應（`main.js:473-508`），比固定高度適合資訊量大的收成卡／回看面板。
4. **素材的可編輯性**：圖是「程式裡的字元網格 + 產生器」，比我們的「匯出好的 PNG 素材包」更容易被 agent 修改與 review——若我們的 mock 素材由 agent 產出，這種「原始碼化素材」值得抄。

**可借用的具體做法**

1. `install.sh` 的三段式（備份／複製／`herdr-app check`）與 `RECIPE.md` 的「Watch out」清單格式。
2. 以實體 address 為主鍵 + **在 `terminals()`／`spaces()` 非空時才 prune** 的判斷（`main.js:148-153`、`realms/main.js:65-69`）；我們的 `/resume`／`/move` 邏輯同樣需要「啟動瞬間資料尚未載入」的保護。
3. 少量指派狀態用 `shared()`、跨重啟保留，但**不要**把它當 ledger（它們只用來記「誰演誰」；我們的 §13 必須走 CAS 檔案）。
4. 「時長 → 文字階梯」單表化（`ROAD_STAGES`，`main.js:104-110`）：我們的格子狀態文字與回看面板可直接沿用這種宣告式表。
5. 兩張圖 opacity 超界達成硬切換（`main.js:119-138`）：若日後要讓開墾／蓋房有最低成本動態，這是免精靈圖、免 timer 狀態機的做法。
6. 「產生器 + 斷言」的素材流程（`sprites.py` 的 `assert` 檢查徽章角落、`banners.py` 的 8× nearest）——把美術規則寫成可執行檢查。
7. 機率／解析函式抽成獨立模組並用 `node --test` 覆蓋（`casting.js`、`agent-stats.js`）。

**應避免的坑**

1. **螢幕爬取**：model／ctx 用正規表達式掃終端輸出，輸出格式一改就壞（`agent-stats.js`）。我們 §6.1／§6.2 已決定走 adapter／extension，不要退回爬螢幕。
2. **用 mod 自己的 localStorage 記時間與狀態**：換 layout／清 storage 就漂移，且 per-copy（`AGENTS.md:980`）。我們的投入計量必須落地在 ledger。
3. **覆蓋使用者全域設定而沒有卸載路徑**：`settings.json`／`programs.json` 的音效與圖示影響所有 layout（`RECIPE.md:90`），且只備份未提供還原。若 v6 要動全域設定，必須附回滾。
4. **素材顯示尺寸與宣告尺寸不一致**：agent sprite 處理了（24→36 加註解），徽章漏了（宣告 16、畫 20，`sprites.py:1062,1074` vs `realms/main.js:58`）。我們的素材要一次對齊 viewBox 與顯示尺寸。
5. **具名 IP 與他人品牌圖示**：角色名稱、`claude.svg` 皆有商標疑慮；v6 用抽象名（Town／Tile）是對的。
6. **狀態只做視覺、不做語意**：它把 `done` 與 `idle` 混為一談來算「工作時長」（`main.js:225`），因為 herdr 的 `done` 會在看過後變 `idle`。我們若有類似狀態，必須明確定義「看過」不改變計量。

## 11. 證據清單

讀過的檔案／URL（全部為第一手）：

- GitHub API 目錄與 README：`https://github.com/joaovitorwoliveira/herdr-middle-earth`（stars/forks/issues、授權、README 全文）
- Clone（`--depth 50`）後實際讀過：`README.md`、`RECIPE.md`、`CONTRIBUTING.md`、`LICENSE`、`.gitignore`、`install.sh`、`programs.json`、`settings.snippet.json`、`themes/shire.json`、`themes/mordor.json`、`layouts/middle-earth.json`、`mods/fellowship/{main.js,agent-stats.js,casting.js,mod.json}`、`mods/fellowship-status/{main.js,mod.json}`、`mods/fellowship-toast/{main.js,mod.json}`、`mods/realms/{main.js,mod.json}`、`tests/{casting,agent-stats}.test.js`、`tools/{sprites.py,banners.py,header.py}`、`mods/fellowship/fonts/GUST-FONT-LICENSE.txt`、`mods/realms/emblems/mordor.svg`、`mods/fellowship/sprites/gandalf.svg`、`mods/fellowship/program-icons/{claude,shell}.svg`、`.github/ISSUE_TEMPLATE/bug_report.yml`
- `git log`（28 筆，首末 commit）、`git rev-list --count`、`diff -u`（自製 mod vs 本機內建）、`file`／`wc -l`／`du -sh`
- 本機對照（唯讀）：`~/.config/herdr-app/herdr.d.ts`、`AGENTS.md`、`icons/LICENSES.md`、`icons/{claude,shell}.svg`、`mods/{agents,spaces,workspace-status,toast}/main.js`、`shared.json`、`themes/`（herdr-app 0.1.16）
- 比較基準：`/Users/kk/projects/herdr-layout-project/docs/proposal.md`（§1、§3、§5、§6、§13）
