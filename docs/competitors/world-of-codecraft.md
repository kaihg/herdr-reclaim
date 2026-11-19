# 競品分析：world-of-codecraft

> 研究日期：2026-11-19。對象：[kevinpardo/world-of-codecraft](https://github.com/kevinpardo/world-of-codecraft)，`main` 的 [6c5b65b](https://github.com/kevinpardo/world-of-codecraft/tree/6c5b65b75eafb78dd906cdccfebabdd262ac9f28)。唯讀研究 `/tmp/world-of-codecraft-research`，未安裝、執行腳本／mod、切換 layout 或修改本機 herdr 設定；研究後移除該 clone。
> 下文 `M/` 代表 repo 的 `mods/world-of-codecraft/`，`H/` 代表本機 `~/.config/herdr-app/`。程式確認指靜態原始碼確認，不代表實機驗證；推論另標 `[INFERENCE]`。

## 1. 基本資訊

| 項目 | 內容／證據 |
|---|---|
| repo／作者 | `kevinpardo/world-of-codecraft`；Kevin Pardo，`LICENSE:1-3`；預設分支 main（[GitHub API](https://api.github.com/repos/kevinpardo/world-of-codecraft)） |
| 授權 | 程式與美術 MIT，字型另採 SIL OFL 1.1；GitHub API 的 license 欄為 `NOASSERTION`，不能因此把原始授權寫成未知（`LICENSE` 全文） |
| stars／forks／issues | 23／5／一般 open issue 0；API `open_issues_count=1` 實為尚未合併的 [PR #1](https://github.com/kevinpardo/world-of-codecraft/pull/1)，不是一般 issue（[issues API](https://api.github.com/repos/kevinpardo/world-of-codecraft/issues?state=all&per_page=100)，研究當日快照） |
| 首次 commit | `c3bd577`，2026-11-07 18:33:22 +01:00；完整本機 `git log --format='%H\|%aI\|%an\|%s'` |
| 最近 commit | `6c5b65b`，2026-11-08 19:39:40 +01:00；共 11 筆，作者欄皆 kevinpardo；API `pushed_at=2026-11-08T18:39:54Z` |
| 對應 herdr 版本 | **未查到固定／最低版本**；README、RECIPE、layout 沒有版本 pin。已核對本機 `herdr.d.ts`／`AGENTS.md` 的具名 API，但沒有執行相容性檢查 |
| 語言 | 執行期 JavaScript＋layout/theme JSON；Claude hook 與美術管線 Python、安裝 Shell。[languages API](https://api.github.com/repos/kevinpardo/world-of-codecraft/languages)：Python 247,404、JS 127,490、Shell 3,729 bytes（GitHub 語言統計，不含全部素材） |
| 主要規模 | layout 234 行；`main.js` 39、`place.js` 565、`activite.js` 329、`ambiance.js` 217、`kit.js` 203、`fronton.js` 144、`tableau.js` 112、`pane.js` 45、`commande.js` 113、`i18n.js` 212；兩個 integration 130／103 行；`tools/ui.py` 801、`bake_world.py` 85、`bake_lands.py` 196 行（對應檔案） |

PR #1 回報非 100% zoom 下村莊裁切、座標與滑鼠操作偏移，以及 Workshop 面板對齊問題；屬提交者的觀察，**本研究未重現、未把 PR 的修正視為 main 已有功能**（[PR #1](https://github.com/kevinpardo/world-of-codecraft/pull/1)）。

## 2. 一句話定位與主題

**把終端 agent 的即時狀態與工具活動演成固定奇幻村莊中的英雄生活，不是會隨成果成長的城鎮經營系統。** Space 是 district、tab 是 quest，CLI 品牌決定職業與工作建築，terminal address 決定種族與名字；讀檔變偵察、編輯／執行指令變戰鬥、測試變打木樁（`M/kit.js:51-100`、`M/place.js:36-42,148-196`、`M/activite.js:29-53`）。

## 3. 功能清單

### 文件宣稱

README 宣稱：英雄職業／種族、四態演出、可選 Claude Code／OpenCode 活動整合、村民與動物、日夜、可拖曳的沉浸模式、英法雙語、Animations 節能開關，以及可選 cduo 金／木／市集額度顯示；無 mod 網路呼叫（`README.md:8-32,52-87`）。RECIPE 再細述 anti-zapping、subagent 光球、金庫與市集旗幟、100ms 動畫計時器（`RECIPE.md:99-131,134-154,194-200`）。

### 程式確認有

| 功能 | 實際行為／證據 |
|---|---|
| 職業、種族、名字 | `program.key` 映射職業；address 雜湊選 5 種族與名字；不是 model 或 session 身分（`M/kit.js:51-90`） |
| 四種 agent 狀態 | working 工作；idle 營火休息；blocked 紅環、驚嘆號與求助泡泡；done 金環與問號（`M/place.js:148-160,202-269`） |
| 活動演出 | `code/commande→combat`、`eclaire/web→eclaire`、`pense/medite/test` 有明確分派；`fini` 回普通狀態演出（`M/activite.js:45-53,119-157`） |
| 戰鬥 | 每次成功 Edit 或 Bash 記一次 `coups`；一般怪 4 下、同任務累計失敗 ≥3 次改成 8 下的 troll；不是成功成果／程式品質計量（Claude hook `:99-114`；`M/activite.js:35-47,141-151,278-307`） |
| 測試／commit／push | 測試結果保留 5 秒、commit 封蠟約 4 秒、push 信鴿約 7 秒；命令分類靠規則，不查 git 是否真有新 commit（`M/activite.js:44,214-242`；兩個 integration 的 TEST／COMMIT／PUSH） |
| 日夜與村民 | 依本機時鐘切日／夜／晨昏；兩名日間村民、夜間守衛、工作英雄 ≥2 才出現的商人，以及雞、貓、鹿、鳥、魚（`M/kit.js:105-124`、`M/ambiance.js:22-34,120-192`） |
| 地圖操作 | 點英雄聚焦；雙擊塔／鍛造場／兵營用 `tab.new` 開 Claude／Codex／shell；拖曳、滾輪與小地圖移動鏡頭，手動移動暫停追蹤（`M/place.js:38-42,246-251,331-338,368-387,474-481,535-563`） |
| 沉浸模式 | 同一 layout 內切換兩個村莊 block 與獨立指揮面板；終端降為 400px 高，不是把整張圖放大（`M/fronton.js:18-29`、`M/terre-data.js:1-2`） |
| 戰報 | 記到達、離開、狀態切換；保存最多 **40 筆**，畫面只顯示 **4 筆**（`M/place.js:103-132,403-417`） |
| 英／法介面 | 共用字串表，系統語言／環境變數／block props 控制（`M/i18n.js:1-34,206-212`） |

### 文件與程式落差

- **Animations 並非完全停止所有動畫**：主要英雄幀、走路、怪物、環境生活、煙霧與 activity polling 確實關閉；但 `place.unit()` 仍呼叫 `act.layers()`，後者讀快取 `subs/commitT/pushT/errT`，沒有總體 `off` 退出。已有 subagent 光球等附加層仍可建立 `.loop()`；左欄 blocked 卡片也未讀該開關（`M/place.js:266,453-464,488-500`、`M/activite.js:161-165,202-242`、`M/tableau.js:90`）。
- **隱藏村莊不是零 timer**：活動、幀、環境 timer 有停，但 `Place.init()` 的 60 秒天空 timer 無 hidden 條件（`RECIPE.md:142` 對照 `M/place.js:99,464,492,499`）。頂欄時鐘實際 60 秒更新，不是 RECIPE 寫的 30 秒（`RECIPE.md:194-195`、`M/fronton.js:35-44`）。
- **不是任意多個 subagent 都有獨立光球**：資料是數量，畫面上限 4（`RECIPE.md:121`、`M/activite.js:203`）。
- **美術可重建的範圍有限**：怪物原畫在 repo，但英雄同步器預設讀作者 `/private/tmp/.../scratchpad/...` 的外部素材與動畫 metadata；clone 本身未提供那組來源（`README.md:91-93`、`tools/sync_heroes.py:1-22`、`tools/sources/` 清單）。
- **兩份村莊共享戰報的假設需保留**：程式註解說重讀另一村莊寫入的紀錄，但用的是 `localStorage`，本機 herdr 文件明定它是 **per mod copy**，不是 `shared()`（`M/place.js:105,459`；`H/AGENTS.md:976-980,1141`）。[INFERENCE] 依目前宿主契約，兩模式不會靠這段讀取自動共用同一份戰報；未實機驗證。

## 4. 架構

### Layout 節點樹

唯一 `layouts/World-of-Codecraft.json:1-234`：root column、無系統 titlebar、traffic lights `[16,23]`、JetBrains Mono 終端、Alegreya Sans UI；未設定終端 `font_size`。

- `fronton`：48px 頂欄，可拖視窗，`role:fronton`。
- `bourg`：row，padding／gap 6。
  - `gauche`：262px（min 200／max 420）。
    - `tableau`：district／quest 清單。
    - `commande`：400px 高，預設隱藏，沉浸模式的指揮面板。
  - `droite`：column。
    - `place-immersion`：weight 1、`role:place, immersion:true`，預設隱藏。
    - `arene`：終端容器；上下左右各 14px `rail` 包住 `main` 的 `tab:active`，pane header 30px。
- `place`：400px 高，Workshop 模式的村莊，內含 262px 寬指揮面板。

沉浸切換實際呼叫 `layout.show/hide/resize`，沿用宿主保存的 layout 點擊狀態（`M/fronton.js:18-29`；`H/AGENTS.md` 的 layout state 規則）。

### Mod 清單與職責

只提供一個 mod `world-of-codecraft`，`mod.json` 為 `place:none`。`main.js:23-38` 依 `props.role` 分派六角色；pane header 也可由 `props.pane` 判定。

| 檔案／角色 | 職責 |
|---|---|
| `fronton` | 額度、工作英雄數、警示、時鐘與模式切換 |
| `tableau` | space／tab 選擇、狀態彙整、開新 quest／district |
| `pane` | 終端英雄頭像、標題／cwd／branch、split／zoom／close |
| `rail`（main＋ui） | 終端裝飾框 |
| `place` | 英雄與場景、路線／鏡頭／深度排序、戰報 |
| `commande` | 小地圖、選取英雄卡、Go／Next 與動畫開關 |
| `kit`／`i18n`／`ui` | 身分與額度／雙語／可重用繪圖元件 |
| `activite`／`ambiance` | hook 場景／獨立村民生活與金庫、市集旗幟 |
| `lieux`／四個 `*-data.js` | 手訂站位、路線、命中框／生成的英雄、怪物、世界、擴充地圖資料 |

證據：`M/main.js:1-38`、`M/kit.js:1-143`、`M/lieux.js:1-58`、`M/place.js:14-26`。跨 block 小地圖橋接以 `wocc.view` 傳 `{cam,vw,dots}`，座標量化至 8px、值變且相隔 >300ms 才寫；點擊寫 `wocc.goto`，村莊消費後改鏡頭（`M/place.js:350-365`、`M/commande.js:75-94`）。

### 使用的 herdr API（具名）與資料流

- 資料／狀態：`agents`、`spaces`、`panes`、`focused`、`layout`、`window`、`props`、`shared`、`setShared`、`setAgentOrder`。
- IO／命令：`home`、`readTextFile`、`exec`、`run`、`nextCommand`。
- App commands：`agent.focus/next`、`space.select/new`、`tab.select/new`、`pane.focus/split/zoom/close`、`layout.show/hide/resize`；快捷鍵另有 `layout.toggle`。具體 import／呼叫在 `M/{main,fronton,tableau,pane,commande,place,kit,i18n,activite}.js`；API 可在 `H/herdr.d.ts:14-29,64-89,169-193,235-269,437-458` 查到。
- gpui-kit：`View/div/image/svg/PathBuilder/Background`，加 `gpui-base` flex；`kit.gradient()` 走原生 `window.paint_path`，不是 HTML／CSS／WebGL（`M/kit.js:5-28`）。

三條資料流互相獨立：herdr 即時資料→agent／UI；CLI hook/plugin→本機 terminal JSON→活動演出；外部 cduo→quota JSON→額度外觀。沒有讀 transcript、git diff 或成果檔的 runtime 管線（上述讀檔點；§5、§8）。

## 5. agent／session 處理

### 身分、狀態與歸戶

| 面向 | 實作與限制 |
|---|---|
| CLI 種類 | `program.key`：claude 前綴→mage；codex→artificer；shell→warrior；gemini→priest；opencode／pi／amp／cursor→ranger；其餘 rogue（`M/kit.js:72-80`） |
| working／idle／blocked／done | **由 `agents().status` 決定，不由 activity hook 判斷**。宿主依 agent 的 OSC 7501 回報；done 是背景完成、看過變 idle。活動檔只在 working 且 `t` 未超過 15 分鐘時選工作場景（`H/herdr.d.ts:169-193`、`H/AGENTS.md:153-156`；`M/activite.js:34,51-53`） |
| 種族與名字 | `hash(address)`；同一 terminal 穩定，不代表 session 穩定（`M/kit.js:82-90`） |
| model／effort／token／成本 | 活動 JSON 沒有這些欄位；mod 未見讀取或計算。選中英雄的血條只按 blocked 給 8px、其餘 28px，不是額度／健康數據（兩個 integration 全檔；`M/place.js:267-269`） |
| 基礎模式所需整合 | 無自有 hook 也能顯示 herdr 四態；細節場景只附 Claude Code hook、OpenCode plugin，沒有 Codex／OMP 專用活動 adapter（`README.md:52-73`、`integrations/`） |
| terminal 位址 | 寫入端取 `HC_TERMINAL_ID` 作檔名；讀取端直接取 `AgentInfo.address` 作檔名，沒有 session→terminal 對照表或解碼層（Claude `:20-32`、OpenCode `:21-24`、`M/activite.js:90-95`） |
| `/new` | 未按 session ID 新建英雄／資料分區；Claude 一般 SessionStart 只重設部分欄位、設 `fini`。同 terminal 仍同身分（Claude `:117-122`、`M/kit.js:83-89`） |
| `/resume` | 未保存可恢復的 root session 身分；換 terminal 會重新依 address 決定外觀，同 terminal 則沿用該檔，並非 session 還原（同上；OpenCode `:21-40`） |
| `/move`／worktree | 無 cwd visit、repo canonicalization 或成果歸戶；cwd／branch 僅是 pane header 顯示資訊（`M/pane.js:18-38`；兩個 integration 全檔） |
| subagent | Claude 依 `agent_id` 略過子代理自己的工具，SubagentStart／Stop 只增減 `subs`；OpenCode 從 `parentID` 收集 child IDs，略過其 chat／tool／event，以 root 的 task 工具前後計數。只形成 root 英雄身邊最多 4 顆光球，沒有 child usage／interval 歸戶（Claude `:85-90`；OpenCode `:25,47-94`；`M/activite.js:203-212`） |
| 多 machine | 未見遠端 activity 傳輸。讀取使用本機 `home()`、無 `readTextFile(...,{on})`；herdr 的遠端位址帶 machine 前綴。[INFERENCE] 遠端 agent 的基本四態可由宿主呈現，但不能假設遠端寫入的檔會自動被本機讀到（`M/activite.js:90-95`、`H/AGENTS.md:143-164,1114`） |
| shell | 不算 `agents()` 的 shell 由 `panes()` 補為守衛，村莊最多畫 4 個；不是 root session 計量（`M/kit.js:99-101`、`M/place.js:463`） |

**事件歸戶粒度是 terminal，不是 session。** OpenCode 的 `sessionID/parentID` 只拿來篩掉已知 children，沒有把 root ID 寫入 JSON，也沒限定只能接受某一 root；Claude 輸入的 session 資訊同樣沒有保存。因此不能拿 `tache` 當 session ID：它只是 prompt 計數器（兩個 integration 全檔）。

### Activity JSON 實際欄位

兩個整合共用 `~/.local/state/world-of-codecraft/<HC_TERMINAL_ID>.json`，欄位按事件逐步出現，**不是每次都有完整 schema**（Claude `:71-130`；OpenCode `:28-94`）。

| 欄位 | 真正來源／語意 |
|---|---|
| `act` | `pense/eclaire/code/commande/test/web/medite/fini`；工具類型或生命週期事件 |
| `outil` | 最近一次 before／PreToolUse 工具名稱，不含完整參數 |
| `t`／`depuis` | 本機毫秒時間；前者每次更新，後者只在 act 改變時更新 |
| `tache` | Claude UserPromptSubmit／OpenCode chat.message 每次 +1，用來決定怪物抽樣 |
| `coups` | 該 prompt 成功編輯／Bash 次數，每 prompt 歸零；測試等 Bash 也算一次 |
| `err`／`errT` | 連續失敗數／最近失敗毫秒時間；成功工具將 err 歸零 |
| `errTache` | 該 prompt 累計失敗數，prompt 歸零；≥3 選 troll |
| `subs` | 目前子代理計數，不是子 session ID 清單 |
| `essai` | 最近測試 `{ok,t}`；取事件成功／失敗，不解析測試報告 |
| `commitT`／`pushT` | 最近匹配成功命令事件的時間戳，不存 commit hash、branch 或 remote |

未寫入：`sessionId`、`rootSessionId`、`parentSessionId`、cwd、machine、model、effort、token、cost、active interval、原始 prompt／檔案內容。`outil`、`tache`、`subs` 以外的舊特效欄位未必在新 prompt／SessionStart 清空，因此是最近狀態快照，不能當事件帳本（Claude `:91-126`；OpenCode `:47-94`）。

### Claude hook：事件與失敗判斷

- 無 `HC_TERMINAL_ID` 或 stdin 非合法 JSON 就退出；讀完 JSON 後立即輸出 async 回應，再處理檔案。所有 terminal 共用 `.lock` 的 `fcntl.flock`，讀舊值、改欄位、寫 `.tmp` 後 `os.replace`（`:20-32,71-82,126-130`）。作者的「不拖慢」為協定意圖，未測 hook latency。
- UserPromptSubmit→`pense`，重設 `coups/err/errTache`；PreToolUse 依工具分類設定 act；Read/Grep/Glob/LS/NotebookRead/LSP/ToolSearch→偵察，Edit/Write/MultiEdit/NotebookEdit→編輯，WebSearch/WebFetch 或部分名稱含 search/fetch 等的 MCP 工具→web；未知工具保留場景（`:47-61,91-98`）。
- PostToolUse 視為成功，Edit／Bash 加 `coups`；PostToolUseFailure 累加失敗並記時間。**不讀 Bash exit code 或 tool_response**，所以「Tests passed」只是 hook 事件分類，不是獨立測試驗收（`:99-114`）。
- PreCompact→`medite`；SessionStart 的 compact→`pense`，其他來源→`fini` 並重設 `subs/err/coups`；Stop→`subs=0, fini`；SessionEnd 直接刪檔，這段在 lock 外（`:64-68,115-125`）。
- AskUserQuestion 等未列入分類的工具不會自行寫 `blocked`；blocked 仍由 herdr 狀態決定（`:61`、`M/activite.js:51-53`）。

### OpenCode plugin：相同格式、不同事件語意

- `chat.message` 增 prompt 計數；`tool.execute.before` 用 `output.args.command` 分類 Bash，並以 `callID` 暫存去字串後的命令；`tool.execute.after` 取回命令、刪暫存，根據 `metadata.error` 或數字 `metadata.exit !== 0` 判斷失敗（`:47-84`）。
- `task` before／after 增減 `subs`；event 中看到 `info.parentID` 才加入 children Set；`session.compacted→medite`、`session.idle→fini` 並清 subs、`session.deleted` 刪檔（`:62-94`）。[INFERENCE] child 過濾依賴 parent 資訊事件先被收到；沒有重建既有 child 關係的查詢。
- 寫入是同步 `readFileSync/writeFileSync/renameSync`，沒有 Claude 的跨程序 lock，錯誤全吞掉；原子換檔避免讀到半份 JSON，但不是跨程序交易或事件不遺失保證（`:28-41`）。

兩者均先移除部分 heredoc 與引號字串，再以行首／`; & | (` 後的正規表示式識別 test、git commit、git push，避免訊息中的「git push」被算作操作；支援 npm/bun/pnpm/yarn test、pytest、cargo/go test 等。**這是有限命令辨識器，不是完整 shell parser，也不是 git 事實查核**（Claude `:37-45`；OpenCode `:14-18,54-58`）。

### Anti-zapping：把頻繁工具切換與畫面切換分離

`Activites.watch()` 在村莊可見、動畫開啟且有 working／未清場景時每秒 poll；缺檔／壞 JSON 回普通四態，`wanted()` 忽略超過 15 分鐘的活動（`M/activite.js:29-34,51-53,75-114`）。

- 初次看到有效場景立即採用。
- 一般切換須同時滿足：新候選連續 8 秒、目前場景已 15 秒。
- 只要從／往森林偵察移動，改為 20 秒／40 秒。
- 進 meditation、進 test、回普通狀態、離開 meditation 立即切換；**離開 test 並不是無條件立即切換**。
- 計時用 poll 觀察到候選的時間，不直接用 JSON 的 `depuis`；因此它是視覺穩定器，不是精準工具執行歷程（`M/activite.js:119-137`）。

## 6. 視覺與美術

### 風格與素材規模

固定等距奇幻村莊、木雕金邊、鐵件、羊皮紙、亮色職業英雄；白天暖色，夜間藍色校色＋窗／爐火。村莊 3000×400 邏輯 px，沉浸模式上下各多 400，總高 1200，不靠縮放取得更多空間（`M/kit.js:15-22`、`M/monde-data.js:2-3`、`M/terre-data.js:2`）。

以下為**manifest／來源清單的數量**，不是重新執行產生器或完整檔案體積統計：

| 類別 | 數量與來源 |
|---|---|
| 英雄 | 5 種族×6 職業＝30；每個都有 stand、idle 4 幀、四向 walk 各 8、work 6、rest 4；日夜兩套。依 manifest 與同步規則計算，核心 stand／動畫輸出為 30×94＝2,820 PNG，不含肖像（`M/heros-data.js:3-34`、`tools/sync_heroes.py:38-89`） |
| 怪物／動物／村民 | 19 類、50 個姿勢；日夜×左右各一，共 200 個派生 sprite 檔的規格（`M/creatures-data.js:3`、`tools/sync_creatures.py:115-173`） |
| 世界 | 中央日夜各 3 tiles；南北擴充共 12 tiles；30 組前景遮擋切圖；另有小地圖與狀態環／標記（`M/monde-data.js:2-36`、`M/terre-data.js:2`） |
| AI 原畫 | `tools/sources/` 有 6 張角色 sheet（3 creature、1 raven、2 ambiance）＋1 張風格參考；不是英雄原始動畫的完整來源 |
| 字型 | 8 個 TTF、4 個 OFL 檔：Cinzel／Cinzel Decorative、Alegreya Sans、Jacquard 24、Jersey 15（`M/fonts/` 清單） |

### 製作與烘焙管線

1. **場景程序生成**：`tools/village-art/engine.py`、`gi.py`、`tex.py`、`kit3d.py`、`buildings.py` 以 voxel、材質、光照與遮蔽生成建築／道具；`compose2/compose3` 合成地面與陰影。`build_assets.sh:1-24` 先生成建築、extras、合併 metadata。Python 依賴 numpy／scipy／Pillow（同腳本與各檔 import）。
2. **世界離線烘焙**：`bake_world.py:18-85` 將靜態物件的日夜合成圖切成 1000 邏輯 px 寬的 tile，2× 最近鄰輸出；從同一張已上色世界裁前景像素與深度，不在 runtime 重算光照；再生成小地圖與 `monde-data.js`。
3. **擴充地景**：`bake_lands.py:31-51,83-176` 擴高合成畫布、加北森林／南田野，檢查白天村莊建築像素不被改動，支援快取合成。RECIPE 宣稱約 9 分鐘、重建像素一致；本研究未執行計時或像素比對（`RECIPE.md:143-152`）。
4. **角色素材**：README 稱英雄／怪物／村民為 AI 生成後手工處理；怪物同步器註記「GPT Image 2.6，08/11/2026」，這是作者的來源註記，未獨立驗證模型版本。`sync_creatures.py:1-9,53-112` 做底色去背、連通區切分、縮放、alpha 門檻化，再輸出鏡像／夜色。英雄同步器則匯入外部 metadata、已完成動畫，補鏡像及夜色，**本身不生成原始動畫**（`sync_heroes.py:1-22,42-97`）。
5. **UI**：`tools/ui.py` 產生框／邊條／按鈕／旗幟等 PNG；runtime 以四角與裁切邊條組合框，不靠 HTML border 或原生 9-slice（`M/ui.js:1-6,38-64`）。舊 `gen.py/iso.py/res.py` 還會直接輸出到使用者 herdr art 目錄，不能把所有 tools 當成只改 repo 的安全建置工具（`tools/gen.py:7`、`tools/iso.py` 輸出常數）。

### 動畫與效能

- 英雄移動用 native `left/top` transition，近距離直走、遠距離走預定道路；所有目前動畫幀疊在同處，以 opacity 0/1 換幀，避免每幀才換圖片路徑（`M/place.js:69-80,148-242`）。
- 每個村莊實例共用 100ms timer；只為水平視野內動畫單位或移動單位工作，frame signature 沒變不 notify；不是每英雄各一個 timer。`ONLY_SELECTED=false` 是源碼常數，不是另一個使用者設定（`M/place.js:33-34,275-296,482-493`）。
- 前景按腳底 y 深度排序，只有與英雄／村民相交且應在前的 cutout 才補畫；村民每秒只檢查移動段／遮擋變化，連續位移與雙幀換圖交給原生 transition／loop（`M/place.js:495-511`、`M/ambiance.js:43-92,120-159`）。
- Animations 開關預設 on，保存 `wocc.anim`。關閉可大幅減少主要動態工作，但非全動畫零開銷，見 §3；RECIPE 的 M2 Pro 約 27%→10% 單核為**作者數據，未重測**（`RECIPE.md:129-131`）。

### 授權限制

`LICENSE` 明確將 code 與 art 納入 MIT，重用須保留著作權及授權聲明；字型不適用 MIT，必須保留各自 OFL，不能單獨販售字型，修改版若涉及保留名稱需依條款處理（`LICENSE`；`M/fonts/OFL-Jacquard24.txt:47-78`，其他三份 OFL 同類條件）。[INFERENCE] 作者宣稱 MIT／原創不等於已獨立證實 AI 素材的生成服務條款、著作權成立或無第三方權利；未查到完整 prompt／生成紀錄。README 自述無遊戲出版商背書（`README.md:89-97`）。

## 7. 累積與持久化

**有介面偏好與短戰報，沒有成果資源庫、土地進度或 session 歷史帳本。**

| 儲存 | 內容／生命週期／證據 |
|---|---|
| activity JSON | 本機 `~/.local/state/world-of-codecraft/<terminal>.json`，最新快照；Claude SessionEnd／OpenCode session.deleted 刪除。不是 append-only，可覆寫／遺失中間事件（兩個 integration 全檔） |
| `wocc.chronicle` | `localStorage` JSON array，元素 `{at,text,kind,address}`，最多 40、畫面顯示 4；不保存 session ID、工具事件或成果（`M/place.js:98,103-132,403-417`） |
| `wocc.anim`／`wocc.lang` | shared 動畫偏好／語言；shared 是宿主持久化資料，預設家目錄有 `shared.json`（`H/herdr.d.ts:445-449`、`H/AGENTS.md:86-90`；`M/commande.js:108-111`、`M/i18n.js:10-32`） |
| `wocc.view`／`wocc.goto` | shared 鏡頭與單位位置橋接；初始化記住舊 goto 時間避免重播舊點擊，不是工作史（`M/place.js:86,354-365`） |
| layout 狀態 | 模式、顯示與尺寸由 herdr layout state 保存；不是 mod 自己的一座城資料庫（`M/fronton.js:18-29`） |
| mob／scenes／hits | 記憶體 Map；不持久化路線、戰鬥或怪物履歷（`M/place.js:92`、`M/activite.js:57-63`） |

`localStorage` 的實體檔名／跨版本落盤細節在本次讀取文件中**未查到**；不能把 `wocc.chronicle` 說成 `shared.json` 的鍵。本機文件明定每個 mod copy 隔離，兩模式是否連續見 §3。另外 `done→idle` 刻意不新增戰報（`M/place.js:121-122`），所以連 40 筆也不是完整狀態日誌。

## 8. 安裝、隱私與安全

### 安裝流程（僅記錄，未執行）

1. clone 到可長期保留的路徑，執行 `tools/install.sh`，再自行切 `World-of-Codecraft` layout；`DEST` 預設 `~/.config/herdr-app`，可由 `HERDR_APP_HOME` 改，但目錄須已存在（`README.md:34-48`、`tools/install.sh:14-27`）。
2. installer 用實體檔複製 mod、layout JSON／preview PNG、theme；`rsync --delete` 限定自己的 mod 目錄；移除前代 `World-of-Codecraft-Immersion` layout、preview 與其 state。**沒有自動合併 keys 或註冊 Claude settings**（`tools/install.sh:29-50`）。
3. 手動合併 `M/KEYS.json`：ctrl-shift-i 切模式、ctrl-shift-j 顯示／隱藏村莊、ctrl-shift-b 顯示／隱藏左欄（README／KEYS）。
4. 可選 `--integrations`：Claude hook symlink 到 `~/.claude/hooks/`；另按 README 登記 11 種 hook events，命令含 `python3`、5 秒 timeout、錯誤忽略。OpenCode 只在 `~/.config/opencode` 已存在時才 symlink 到其 `plugins/`，否則不安裝（`README.md:52-73`、`tools/install.sh:41-50`）。

### 讀取、執行與網路邊界

- runtime 讀 herdr 即時狀態／pane cwd／branch／tab title、本 mod 素材、activity JSON、cduo `quota-{A,B}.json`；**不讀 Claude transcript、API key、專案原始碼內容或 git diff**（`M/pane.js:18-38`、`M/activite.js:90-95`、`M/kit.js:129-143`）。
- 語言偵測每份載入的 module 以 `asked` 防重複，`exec("sh",...)` 執行 `defaults read -g AppleLanguages`、`sed`、`tr` 與環境變數 fallback；不是長期輪詢 subprocess（`M/i18n.js:10-34`）。
- 點建築可透過 `tab.new` 啟動 `claude`／`codex`／shell，與自動 language subprocess 應分開看待（`M/place.js:38-42,331-338`）。
- mod／hook／plugin 未見網路請求；cduo 的額度抓取器不在 repo，所以其上游登入與網路行為**未查到**，不能把「mod 不連網」推廣為「整個額度來源不連網」（`README.md:81-87`、`M/kit.js:129-143`）。

### 金、木、市集不是生產資源

| 畫面 | 真正資料來源與換算 |
|---|---|
| 金 Gold | account A 的 `rate_limits.seven_day.used_percentage`，四捨五入後顯示 `max(0,100-used)%` |
| 木 Wood | account B 的相同週額度，不是編輯檔案取得的木材 |
| 小字 5h | `rate_limits.five_hour.used_percentage` 的剩餘百分比；沒有此窗就顯示帳戶名 |
| 頂欄 Fair | A/B 已有週 reset 中最早的 `resets_at`，轉成倒數；不是交易市場 |
| 村莊金庫 | **只用 A** 的週剩餘額度，`ceil(left/20)` 夾至 0–5 枚金幣 |
| 市集旗幟 | **只用 A** 的週 reset，尚有 0–24 小時才出現；和頂欄取 A/B 最早值不完全相同 |
| 行走商人 | 白天且 working 英雄數 ≥2；不依資源持有量或 quota 生成 |

證據：`M/kit.js:129-153`、`M/fronton.js:59-66,80-90,136-138`、`M/ambiance.js:26,68-75,193-215`。quota 根欄 `at` 與 `resets_at` 單位均假設為秒、乘 1000；`at` 超過 30 分鐘加問號／tooltip 警告，仍使用舊數字。缺檔／壞 JSON／無 `rate_limits` 回 missing；無有效 seven_day 即不畫金木，只有 five_hour 也不畫。金庫／旗幟沒有套用 stale 警告，動畫 off 時整組環境生活連同它們不畫（`M/fronton.js:61-65`、`M/ambiance.js:72-74`、`M/place.js:499-500`）。**cduo 的產檔程序、帳戶 A/B 的識別與認證規則未隨 repo 提供。**

### 具體風險

- 更新會刪自己 mod 目錄中的非 repo 自訂檔，並移除舊 immersive state；沒做備份（installer `:29-38`）。
- hook/plugin 是指向 clone 的 symlink，搬移／刪除正式安裝來源會斷；本次研究 clone 未安裝整合，因此可移除（installer `:44-49`）。
- `tache/coups/err` 是覆寫快照；Claude 鎖沒有涵蓋 SessionEnd、OpenCode 沒有跨程序鎖。[INFERENCE] 不能依此協定承諾並行寫入／退出時的事件完整性（Claude `:64-72,126-130`；OpenCode `:28-41,94`）。
- 持久戰報會保存 tab 名片段與 terminal address，可能包含專案名稱；hook 不保存原 prompt／完整命令，但仍留下工具種類、時序與失敗數。無獨立資料保留／加密機制可見（`M/place.js:105-125`；兩個 integration）。
- 隱藏例外會讓失敗看起來只是沒有場景／額度；這適合裝飾性降級，**不適合作為 v6 的投入或資源記帳契約**（`M/activite.js:95`、`M/kit.js:138-140`、OpenCode `:41`）。

## 9. 優點與限制

### 優點

1. **工作活動語意具體**：從 read／edit／test 到 commit／push／compaction 都有確定的視覺對應，且沿 producer→consumer 可追查，不只忙碌燈（§5，`M/activite.js:45,161-307`）。
2. **減少場景來回跑動**：候選穩定時間與最短停留時間雙門檻，跨森林更保守；比每個工具事件立即移動更適合高頻 agent（`M/activite.js:119-137`）。
3. **原生 UI 下的圖像分工清楚**：世界離線合成、人物線上動作、前景切圖維持遮擋；manifest 保存尺寸／腳底錨點／幀數／深度（`tools/bake_world.py`、`M/heros-data.js`）。
4. **基本狀態不綁活動整合**：沒有 hook／quota 仍可工作；缺資料不造假金木數字（`M/activite.js:51-53`、`M/fronton.js:61`）。
5. **實際工作介面完整**：space／tab 導覽、pane 操作、選取追蹤與沉浸模式不是單純展示圖；英法字串集中，demo 使用通用任務名（`M/main.js`、`M/commande.js`、`M/demo.js`）。

### 限制

1. **terminal 不是 session**：沒有 root ID／cwd visit／child usage，可重開同 terminal 的 session 也沒有獨立歷程（§5）。
2. **沒有城鎮成長循環**：場景與建築固定、金木是外部帳戶額度、戰鬥次數不是驗收成果；無收成／建造／撤回帳本（`M/monde-data.js`、`M/kit.js:129-143`、`M/activite.js:141-151`）。
3. **整合範圍窄且本機導向**：細活動只附 Claude／OpenCode，額度只認 cduo A/B，無跨 machine 檔案同步（§5、§8）。
4. **節能承諾比實作強**：仍有未 gated 特效、左欄閃爍與隱藏區塊天空 timer；性能數字只有作者敘述（§3、§6）。
5. **美術重建非完全自包含**：英雄來源在作者 scratchpad、舊工具可能寫使用者 config；不宜照 README 把 tools 當單一可靠 build 流程（§6）。
6. **宿主版本與比例相容性未定**：未 pin herdr；開放 PR 回報 zoom 問題；localStorage 隔離契約也與跨模式戰報註解有落差（§1、§3）。

## 10. 與我們提案 v6 的比較

### 重疊與差異

共同點是 gpui-kit 原生 UI＋預烘焙圖片、agent 活動訊號、奇幻／中世紀城鎮視覺；但兩者核心循環不同（本案 `M/place.js`；`docs/proposal.md:15-81`）。

| 面向 | world-of-codecraft | 我們的 v6 |
|---|---|---|
| 主體 | 固定村莊中的即時 terminal 英雄 | `(cityId,rootSessionId)` 自動分配遠征格 |
| 身分 | address 雜湊＋program 類別 | session＋parent 關係、repo common dir；visit 分割 cwd |
| 進展 | 每 prompt 成功工具次數→打怪 | root／child active interval 聯集，每分鐘 +1、100 點開墾 |
| 資源 | 金／木＝cduo A/B 週剩餘額度 | 驗收成果→木／石／鐵；文件／研究→羊皮卷 |
| 遊戲操作 | 聚焦終端、招募＝開 tab、看演出 | 多次收成、扣資源蓋房、花卷加速 |
| provider 意義 | CLI 品牌直接決定職業 | 真實投入最多 provider 決定派系外觀，額度另顯示 |
| 保存 | 最新活動快照＋40 筆短戰報，畫面 4 筆 | 可回看的 session／投入／成果城鎮、不可變收成與 CAS |
| 部署 | 接管一個完整 layout | 獨立 mod tab，可嵌入既有 layout |

本案證據見 §4–8；v6 對照 `docs/proposal.md:15-81,122-174,176-214`。**比較基準需校正**：提案 `:44` 寫「只有 4 筆事件紀錄」，實際是「顯示 4、保存最多 40」；不因此變成完整工作史。本次只補此競品檔，未修改 proposal。

### 它做得比我們好的地方與可借用做法

1. **活動演出的細緻度已有實作**：借用工具→場景的明確表、短效結果提示與事件附加層；v6 不必重做整套戰鬥，但可把「工作中／待驗收／已收成」各自做成穩定可辨識狀態（`M/activite.js:45,214-242`）。
2. **anti-zapping 可以直接轉為 UI policy**：保留候選穩定時間、最短停留時間、重要狀態即時中斷；只對演出做平滑，不能延遲 ledger 的真實事件時間（`M/activite.js:119-137`）。
3. **離線算外觀，線上算狀態**：資產 manifest 提供尺寸／錨點／深度；runtime 只選圖、移動與排序，符合 v6 沒有 3D API 的限制（`tools/bake_world.py:53-83`、`M/heros-data.js`、`docs/proposal.md:56-60`）。
4. **工作視窗與沙盤模式互換**：同 layout 的 show/hide/resize、選取追蹤與小地圖橋接，提供不必另開 renderer 的空間管理範例（`M/fronton.js:18-29`、`M/place.js:354-365,474-481`）。
5. **可選能力與 unknown 的區分**：沒有 quota 就不畫資源牌；v6 也應保留 unknown，不把缺 usage 當零投入；進一步避免本案 stale 數字仍當金庫現況（`M/fronton.js:61-65`；`docs/proposal.md:150-155,197-202`）。

### 應避免的坑

- **不能複製 terminal 快照作 v6 adapter**：需保留 session／parent／visit／seq／heartbeat／usage 游標；`tache` 和 `coups` 不足以處理 `/new`、resume、move、離線重播（本案 §5；提案 §6）。
- **不要把配額、活動、成果混成一種資源**：本案的 gold/wood 是比例儀表，打怪是工具成功計數；都不能取代已驗收成果與 claim key 防重複（本案 §8；提案 §7）。
- **原子換檔不等於原子帳本**：`.tmp` rename 只防讀到半份，不能防多寫者覆蓋、重複收成或跨檔不一致；v6 的 CAS／operation ID 必須留在交易層（兩個 integration；提案 `:204-207`）。
- **不要讓偏好開關只擋主要路徑**：動畫、timer、poll、附加特效與所有 block 都需一致 gated；關閉不能停止必要的資料記帳，也不能仍讓裝飾常駐動畫（本案 §3）。
- **shared 與 localStorage 要區分**：跨 copy 通訊可用 shared，但全 mod 都會重繪；資料長期保存與 CAS 另設明確所有權。不要像戰報註解那樣假設 per-copy storage 會互通（`H/herdr.d.ts:445-449`、`H/AGENTS.md:980`）。
- **美術來源與產物要分層交付**：保留可重建輸入、授權與單一 repo 輸出位置，不依賴作者暫存目錄；地圖邏輯也不能硬綁 3000×400 的美術座標，否則不符合 v6 的可擴張格子（`tools/sync_heroes.py:19`、`M/lieux.js`；提案 §1、§4）。

## 11. 證據清單

### 實際閱讀的 repo 內容

以下為本次主研究與兩個唯讀研究切片的合併讀取範圍；不是僅由檔名推定內容。所有 repo 行號均對應頂端固定 commit。

- `README.md`、`RECIPE.md`、`LICENSE` 全文；`.git` 根清單（無 shallow 檔）、完整 `git log`；`.git/config` remote。
- `layouts/World-of-Codecraft.json`、`themes/World-of-Codecraft.json`；`M/mod.json`、`M/KEYS.json`。
- 執行期完整讀取：`M/main.js`、`kit.js`、`fronton.js`、`tableau.js`、`pane.js`、`commande.js`、`i18n.js`、`ui.js`、`place.js`、`activite.js`、`ambiance.js`、`demo.js`、`lieux.js`；生成資料 `heros-data.js`、`creatures-data.js`、`monde-data.js`、`terre-data.js`、`art/ui/meta.json`。
- integrations 全文：`integrations/claude-code/wocc-activity.py`、`integrations/opencode/wocc-activity.js`。
- tooling：`tools/install.sh`、`bake_world.py`、`bake_lands.py`、`sync_heroes.py`、`sync_creatures.py`、`res.py` 全文；`gen.py:1-300`、`iso.py:1-300`、`ui.py:1-300,600-801`。
- `tools/village-art/`：`DIRECTION.md`、`build_assets.sh`、`tex.py`、`kit3d.py`、`compose3.py`、`compose2.py`、`extras.py`、`sheet.py`；`engine.py:1-300`、`gi.py:1-300`、`compose.py:1-270`、`buildings.py:1-63,470-548`。
- 字型授權：`M/fonts/OFL-{AlegreyaSans,Cinzel,Jacquard24,Jersey15}.txt`；素材與字型目錄清單 `tools/sources/`、`M/art/{ui,monde,heros,creatures}/`、`M/fonts/`。未以執行產生器驗證素材完整性。

### 網路一手資料

- [repo](https://github.com/kevinpardo/world-of-codecraft)／[固定 commit](https://github.com/kevinpardo/world-of-codecraft/tree/6c5b65b75eafb78dd906cdccfebabdd262ac9f28)。
- [GitHub repository API](https://api.github.com/repos/kevinpardo/world-of-codecraft)、[languages API](https://api.github.com/repos/kevinpardo/world-of-codecraft/languages)、[issues API（含 PR）](https://api.github.com/repos/kevinpardo/world-of-codecraft/issues?state=all&per_page=100)。
- [PR #1](https://github.com/kevinpardo/world-of-codecraft/pull/1)：透過上述 API 讀取 body／狀態，未採用未合併 patch。

### 本機比較與 API 依據

- `docs/proposal.md:15-81,122-214` 與章節／比較表搜尋；`docs/competitors/herdr-kaiju.md` 的格式、`herdr-middle-earth.md` 章節結構，未拿其結論當本案證據。
- `H/herdr.d.ts`：API／commands 搜尋，`:93-195,430-470`；`H/AGENTS.md:143-168,966-984,1107-1146`，另搜尋 shared／資料儲存與 layout 規則。未讀私人 quota、activity、憑證或 session 檔。

**仍無法確認**：作者驗證的 herdr 版本、此版本在目前宿主的完整相容性；兩個 CLI 實際 hook/plugin 事件順序與 async 行為；cduo 上游產檔／認證／資料正確性；英雄原始生成與完整重建來源；AI 素材權利鏈；實機 CPU／記憶體／多 machine／zoom 表現，以及 localStorage 的實體落盤檔名。均未以猜測補齊，也未為驗證而執行專案。
