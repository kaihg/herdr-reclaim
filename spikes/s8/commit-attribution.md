# OMP 提交來源：Git hook 之外的既有紀錄

## 結論與驗證範圍

OMP 18.22.0 的 eval `commit` 工具會執行 Git `post-commit`，也會另外把成功提交的 SHA 與執行者寫入該 session 的 `changes.jsonl`。因此「hook 沒有 session 環境變數」不等於「無法知道是哪個 session 提交」。不用退回以未提交修改發資源，也不用讓使用者辨認 session ID。

本次直接查閱正在執行的 OMP 所產生的紀錄，並核對同版本原始碼；沒有新開 subagent、改動使用者設定或重新提交測試資料。這是來源證據查證，不是正式收成流程的端到端驗收。

## 實機證據

從本次 bash 工具的 `PI_SESSION_FILE` 找到相鄰的 session artifacts 目錄，唯讀解析其 `changes.jsonl`。以下四筆均找到 `type: "commit"`、`agent: "Main"`、精確 SHA、時間與路徑；四筆存在性斷言通過。

| 提交 SHA | 先前用途 | 此次發現 |
|---|---|---|
| `10a36617b5395ca0a8ad819ed68e532d70e4a31b` | 一次性 repo 的 hook 環境變數測試 | session 紀錄含 `evidence.txt` |
| `7aea36d13da1f0dc6afd82e7311b3a7524f0f840` | 一次性 repo 的 eval 環境傳遞測試 | session 紀錄含 `evidence.txt` |
| `5455186a0ea1c44b1b2422bd0a8b31edf1b39618` | 本專案技術驗證提交 | session 紀錄含提案與 spike 路徑 |
| `0ac3fc8eb26d2990700a35d53450717ce36edfef` | 本專案協定驗證提交 | session 紀錄含提案與協定驗證路徑 |

前兩筆的 Git hook 沒有 `PI_SESSION_ID`／`PI_TOOL_CALL_ID`，但 OMP 的提交紀錄仍在。紀錄沒有直接存 session ID；來源是它所屬的 session artifacts，而不是從時間、視窗或前後 HEAD 猜測。

查證腳本最初假設 session JSONL 第一行是帶 `id` 的 header，遇到 `KeyError`；實際第一行是 `type: title`。修正查證方式後，使用工具提供的 `PI_SESSION_FILE` 定位紀錄，不把第一行假設寫入 adapter。

## 原始碼證據（固定 v18.22.0）

1. [prelude-definition.ts](https://github.com/can1357/oh-my-pi/blob/v18.22.0/packages/coding-agent/src/commit/selective/prelude-definition.ts)：`createCommitPrelude` 從 `ToolSession.getArtifactsDir()` 與 `getAgentId()` 取得來源，傳給 `commitSelection`。`commit.draft(repo=...)` 可以另選 repo，但仍寫進同一個 session 的紀錄。
2. [apply.ts](https://github.com/can1357/oh-my-pi/blob/v18.22.0/packages/coding-agent/src/commit/selective/apply.ts)：`commitSelection` 取得 `repo.commitCreate()` 回傳 SHA，完成 index 處理後，呼叫 `journal.recordCommit({agent, parent, sha, paths})`；不是事後比對 HEAD。
3. [journal.ts](https://github.com/can1357/oh-my-pi/blob/v18.22.0/packages/coding-agent/src/commit/selective/journal.ts)：`CommitRecord` 包含 `type`、`at`、`agent`、可選 `parent`、`sha`、`paths`。紀錄放在 artifacts 下的 `changes.jsonl`，主 session 與其子代理共用；`recordCommit` 等待寫入佇列。寫入失敗只記 warning，不讓工具失敗。
4. [mutate.rs](https://github.com/can1357/oh-my-pi/blob/v18.22.0/crates/pi-vcs/src/git/mutate.rs)：`commit_create` 建立 commit object、更新 HEAD、執行 `post-commit`，然後回傳剛建立的 object ID。回傳值不是重新讀取可能已被另一個提交改動的 HEAD。

本機全域安裝套件原始碼是 18.16.0，執行檔則是 18.22.0；前者缺少這條 selective commit 路徑，不能拿來判定目前功能不存在。

## 建議接法，尚未實作

- 保留 Git hook：記錄哪個 repo 發生哪筆提交。
- OMP adapter 讀取該 session 的 `changes.jsonl`，只使用明確的 `type: commit` SHA 作為 OMP commit 工具的來源證據；不能把一般 `type: call` 的時間範圍當成證據。
- 用相同 SHA 合併 hook 與 OMP 記錄，讓 repo 身分與 session 來源都能核對；依既有收成去重規則只計一次。不需要使用者手動選 session。
- GitHub 上執行的合併不直接發資源。原本在本機已確認的提交仍照常計算；之後 pull 到 merge commit 不再算一份新成果。`gh pr create`／`gh pr merge` 命令成功本身不是本機成果證據。
- 這份紀錄已足以提供一條可行的讀取路徑；本次沒有驗證專用 extension「提交完成」事件，不宣稱存在那種公開 API。

## 不保證永遠不漏的原因

- **提交與 OMP 寫紀錄不是一次不可分割的操作。** 原始碼顯示 Git 提交及 hook 先完成，之後才寫 OMP 紀錄；中間當機、取消或 index 處理拋錯，可能有提交而沒有 OMP 的來源紀錄。這是原始碼顯示的風險，本次未做故障注入。
- **紀錄寫入失敗會被吞成 warning。** 磁碟滿等情況不能視為成功保存來源；沒有 artifacts 目錄的 session 也不寫這份紀錄。
- **記錄未包含 repo 路徑。** 同一 session 可以提交到另一個 repo，不能一律套用 session 當前工作目錄；若同 SHA 對應多個城，不能任選一個。需要 hook 的 repo 證據並拒絕有歧義的配對，或讓上游提交紀錄明確帶 repo 身分。
- `at` 是 OMP 寫紀錄時刻，不是 Git 提交動作的精確開始時間；不可據此猜測來源或忽略封存／切換邊界。
- `changes.jsonl` 是 OMP 內部格式，非本次已確認穩定的公開事件介面。需固定支援版本並檢查格式，不能保證升級後不變。

資料不足時應顯示「已提交，但無法確認來源」，不自動發資源；Git 成果仍保留。不能用附近的工具呼叫、terminal ID 或回合時間補猜。
