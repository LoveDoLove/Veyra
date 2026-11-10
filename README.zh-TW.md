# Veyra

> **Veyra — 程式編寫代理的工程智能**

Veyra 是 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）的插件，為程式編寫代理提供**工程智能（Engineering Intelligence）**：它從代理實際做過的工作中學習有用的工程經驗、記住可靠的部分、主動召回相關記憶，並讓代理把它們套用到下一個任務——有證據支撐、依 DSH 工作區隔離、並對照目前的儲存庫。選用的結構化代碼智慧層回答「程式碼現在是什麼樣子」；Veyra 記憶回答「我們當初是怎麼辛苦學到這些的」——外加雙腦（Dual-Brain）架構。

[![npm](https://img.shields.io/npm/v/@lovedolove/veyra)](https://www.npmjs.com/package/@lovedolove/veyra)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/LoveDoLove/Veyra/blob/main/LICENSE)
[![CI](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml/badge.svg)](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml)

> **想深入了解？**[技術白皮書](docs/WHITEPAPER.md) 涵蓋設計原則、雙腦架構、記憶生命週期、搜尋內部機制、安全與信任機制、評量結果與已知限制，並附有逐節對應的[繁體中文版](docs/WHITEPAPER.zh-TW.md)。

---

## 雙腦架構

Veyra 運作兩層互補的機制，各自回答不同的問題：

| 腦 | 存放內容 | 事實來源 |
| --- | --- | --- |
| **Veyra 記憶** | 工程教訓、根因、決策、約束，以及因果鏈（`symptom → rootCause → remedy → verifiedOutcome`）——附證據錨點、驗證狀態與權威層級 | 跨會話累積的認知狀態 |
| **代碼智慧** | AST 級結構性事實：符號、檔案、呼叫圖、類別階層——永遠由即時儲存庫派生 | 儲存庫本身，透過 `codebase-memory-mcp` |

**這不是同一回事。** 一條寫著「登入函式已重構改用 JWT」的 Veyra 記憶是工程教訓；今天 `login()` 的呼叫圖是結構性事實。當被參考的檔案變更時，代碼智慧可將該記憶標記為*可能過期*——它從不靜默覆寫 Veyra 記憶。

記憶本身由一個明確的 **Memory Server**（記憶伺服器）持有。每個 Cordis 插件生命週期恰好一個實例，沒有 daemon、timer 或背景排程；它擁有 Workspace 解析器、治理路由器、每個 DSH 工作區一個私有 **記憶房（Memory Room）**，以及一個共享的 **中央記憶（Central）** 存放區。

| 層 | 存放內容 | 位置 |
| --- | --- | --- |
| **記憶房** | 在單一 DSH 工作區內工作時學到的一切 | `$DSH_HOME/veyra/rooms/<roomId>/` |
| **中央記憶** | 被明確提升出記憶房、可跨工作區重用的知識 | `$DSH_HOME/veyra/central/` |

**記憶房的身分是 DSH `WorkspaceId`，不是路徑。** 同一個儲存庫開啟的兩個工作區就是兩個記憶房，記憶彼此隔離；身分無法解析的工作區會直接失敗（fail closed），而不是猜測。中央是唯一的跨工作區存放區，而**提升是進入它的唯一途徑**——沒有任何學習路徑或自動程序會寫入其中。

---

## Veyra 能做什麼

- **持久的工程記憶。** 每筆記錄都帶有證據錨點、驗證狀態（`unverified → reviewed → verified`）、權威層級（`candidate → derived → canonical`）與因果面向。你的儲存庫保持權威地位；Veyra 絕不寫入其中。
- **自動學習。** 每個回合結束時，觀察到的活動會經過一個治理化的學習閘門（learning gate），由它決定這筆觀察是否足以成為 `derived` 記憶。只有真正改變了檔案的動作才算修改證據——`read`、`grep`、`glob` 只被記為活動；而且一道失敗的測試輸出永遠不會被標記為 `verified`。
- **自動召回。** 在之後的回合中，相關的 `derived` 與 `canonical` 記錄會自行注入代理上下文，並明確標示為 `not repository truth`。觀察與候選記錄絕不會被自動召回。
- **混合搜尋。** 單一查詢、多個訊號：FTS5 BM25 ＋符號／路徑加權、token 級語意重疊、意圖親和度（why / how / what-changed）與關係圖凝聚力——並附透明的分數拆解。`goal` 參數可引導排序朝向你正在進行的工作（是方向，而非權威）。
- **代碼智慧。** 當 `codebase-memory-mcp` 已安裝時，七個代理工具提供結構化呼叫圖追蹤、AST 級符號搜尋、檔案／元件架構摘要與以代碼為依據的搜尋。未安裝時，Veyra 記憶照常運作、不受中斷。
- **記憶新鮮度與信任。** 代碼智慧監控變更過的檔案，把證據錨點指向已修改或已刪除代碼的記憶標記為過期，並對過期記錄套用檢索懲罰。讀取時，每筆被召回的記錄都會被分類為 `trusted / review_required / stale / contradicted / insufficient_evidence`，並附理由與建議動作——只是投影；絕不寫入，也不改變記錄的權威或驗證。
- **變更智能。** 儲存庫變更會自動進入代理上下文——變更摘要置於召回區塊之首，並標註其信任影響——而 `veyra_change_impact` 可針對一組明確的變更檔案做分析：受影響的記憶、受影響的證據錨點、選用覆核候選、與各類別摘要計數。候選絕不會被自動提升為 canonical。
- **健康與維護。** `veyra_health` 與 `/veyra health` 以唯讀方式回報記憶健康發現；隨附的 `memory-maintenance` 技能僅在明確要求時套用生命週期動作（keep / supersede / invalidate / forget / tombstone / revalidate / defer），並附安全上限與前後對照報告。
- **人工介面。** `/veyra` 斜線指令、唯讀的知識觀測台（Knowledge Observatory），以及 DSH Web 中 `/veyra` 的可互動網路圖（Network Graph）。
- **一個執行時 npm 相依。** `@lovedolove/dsh-codebase-memory-mcp`——獨立的 Codebase Memory 橋接套件——驅動外部原生 daemon。其餘全部為純 ESM、無執行時相依；套件約 263 kB（打包後）。

---

## 目錄

- [安裝](#安裝)
- [快速入門](#快速入門)
- [記憶如何運作](#記憶如何運作)
- [代碼智慧](#代碼智慧)
- [功能](#功能)
- [指令](#指令)
- [工具](#工具)
- [技能](#技能)
- [記憶規則](#記憶規則)
- [設定](#設定)
- [架構](#架構)
- [疑難排解](#疑難排解)
- [開發](#開發)
- [相容性](#相容性)
- [授權](#授權)
- [白皮書](docs/WHITEPAPER.md) / [白皮書（zh-TW）](docs/WHITEPAPER.zh-TW.md)

---

## 安裝

```sh
dsh plugin --profile web add @lovedolove/veyra
```

重新啟動 DSH（或重載該 profile）——Veyra 會自動啟用。不需要 API 金鑰、不需要外部服務、不需要任何設定即可開始使用記憶。

---

## 快速入門

1. **在 DSH 中做真實工作。** Veyra 會自動觀察會話事件。
2. **回合結束時**，Veyra 把該回合發生的事濃縮成一條*觀察*（observation），並執行治理化的學習閘門。帶有持久工程線索、且有證據支撐的回合會成為*衍生*（derived）記憶；沒有留下持久內容的回合則維持觀察狀態，或被丟棄。
3. **查看已儲存內容：**

   ```
   /veyra recent
   ```

4. **把內容取回。** 在同一工作區的稍後會話中，自動召回會將最相關的記錄注入該回合——每筆都標有 `not repository truth`。也可以明確搜尋：

   ```
   /veyra recall sqlite wal
   ```

5. **檢視、整理、提升：**

   ```
   /veyra inspect vey_…           深層證據、來源、因果面向
   /veyra forget vey_…            軟遺忘（離開召回、仍可檢視）
   /veyra promote vey_… canonical 永遠只能顯式、永遠只依你的指示
   ```

6. **以圖觀看。** 在 DSH Web 位址列開啟 `/veyra`——有邊界的 workspace 總覽；`/veyra?id=<record>` 將 1-hop 本地圖置中。

7. **遇到不熟悉的倉庫？** 載入隨附的 `legacy-onboarding` 技能——它會在你做第一筆變更之前，先以證據建立專案記憶基線（Project Memory Baseline）。

---

## 記憶如何運作

1. Veyra 觀察會話活動，不觸碰你的檔案。
2. 回合結束時：Veyra 將該回合濃縮為一條*觀察*（observation）——檔案、符號、測試結果、主張訊號，與結構化因果面向——再由治理化的學習閘門決定它是否夠格進入記憶。閘門讀的是文字，不是格式：同一道指令無論以散文、`- ` 項目符號、`1.` 編號清單，或 `- [ ]` 任務項目抵達，都會被判定為相同，勾選方塊永遠不是繞過閘門的手段。持久且有實據的教訓成為*衍生*記憶，並連結到相鄰記憶（延伸、更新，或被矛盾）。近似重複不會被複製；重複的觀察與已驗證的結果會強化既有記錄，而非新增記錄。只有真正能改變檔案的動作才算修改證據——`read`、`grep`、`glob` 只被記為活動，只在文字中被提到的路徑永遠不會成為修改證據。
3. 自動召回在每個回合開始時，把最相關的 top-N 記錄注入代理的 system-prompt 上下文，並附明確的 `not repository truth` 標示。
4. 隨著同一教訓在跨會話與測試結果中反覆被確認，驗證狀態會推進（`unverified → reviewed → verified`）。**沒有明確的人為指示，任何記錄都不會成為 `canonical`。**
5. **記憶住在記憶房裡，不在你的倉庫裡。** 記憶房以 DSH 工作區身分為鍵，所以你的程式碼旁不會寫入任何東西，而同一儲存庫上的兩個工作區永遠看不到彼此的記憶。提升進中央記憶是另一個獨立的顯式動作。

---

## 代碼智慧

代碼智慧是結構層，將 Veyra 連接到外部的
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 原生 daemon。橋接代碼——倉庫發現、圖譜 client、code-intelligence engine、watcher，以及 `cbm_*` 工具定義——放在獨立的
[`@lovedolove/dsh-codebase-memory-mcp`](https://www.npmjs.com/package/@lovedolove/dsh-codebase-memory-mcp)
套件中，這是 Veyra 唯一宣告的執行時相依。Veyra 本身不附原生二進位、也不內含橋接內部：它只重新公開六個 `cbm_*` 工具加上 `veyra_code_status` / `veyra_change_impact`，並在自家樹中僅保留 `src/code/linking.mjs`（證據錨 ↔ 代碼新鮮度）與 `src/code/retrieval.mjs`（統一管線）。橋接、其安裝流程與原生 daemon 的細節，由該套件的 README 說明，本文件不重複。

原生 daemon 為**選用**：沒有它時 Veyra 記憶層完全可用；代碼智慧降級（見下方「二進位不存在時」）。

### 安裝原生引擎

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
```

上游安裝程式會把二進位放到 Linux/macOS 的 `~/.local/bin`、Windows 的 `%LOCALAPPDATA%\Programs\codebase-memory-mcp\`。支援的平台與驗證細節見[上游 README](https://github.com/DeusData/codebase-memory-mcp)。

也可以設定 `CBM_EXE=/path/to/codebase-memory-mcp` 指向既有的二進位。

### 二進位不存在時

代碼智慧進入**降級模式**：六個 `cbm_*` 工具與 `veyra_code_status` 會回傳附安裝指引的結構化錯誤。所有 Veyra 記憶工具、觀測台、斜線指令與混合搜尋照常運作，不受任何中斷。

### 代碼智慧提供什麼

| 工具 | 功能 |
| --- | --- |
| `cbm_projects` | 列出已索引專案 |
| `cbm_search` | 依名稱／標籤找符號、函式、類別、檔案 |
| `cbm_snippet` | 取得符號的精確定義與行上下文 |
| `cbm_trace` | 自符號追蹤入向／出向呼叫圖 |
| `cbm_arch` | 目錄層級的元件相依總覽 |
| `cbm_search_code` | 對已索引倉庫檔案做常規式搜尋 |
| `veyra_code_status` | 索引狀態與記憶新鮮度報告 |

### /veyra code 指令

| 指令 | 功能 |
| --- | --- |
| `/veyra code status` | 索引狀態與逐筆記憶新鮮度（`FRESH / POTENTIALLY_STALE / INVALID`） |
| `/veyra code index` | 觸發倉庫重新索引 |
| `/veyra code trace <symbol>` | 追蹤符號的呼叫圖 |
| `/veyra code impact` | 檢查哪些記憶參考了近期變更的代碼 |

### 代碼事實 vs. Veyra 記憶

這個區別很重要：

- **代碼智慧**自即時 AST 回報結構性事實：誰呼叫 `login()`、`AuthService` 對外暴露什麼。這些就「儲存庫目前的狀態」而言是權威的。
- **Veyra 記憶**記錄工程知識：為什麼改動 `login()`、失敗模式是什麼、對未來呼叫者的約束是什麼。這些*跨*重構持續存在——而被參考檔案變更時，代碼智慧會將其標記為可能過期，提醒你去驗證。

兩個腦互不取代。

---

## 功能

| 功能 | 說明 |
| --- | --- |
| 環境記憶循環 | 觀察會話事件、把回合濃縮為候選、學習持久教訓、強化重複出現者、把漂移知識標記為過期。 |
| 混合搜尋 | FTS5 BM25 ＋符號／路徑加權、token 級語意重疊、意圖親和度、關係圖凝聚力——附透明的分數拆解。 |
| 統一 RAG | `kind: 'knowledge'` 記錄與工程記憶並列存放專案文件；兩者一起被搜尋。 |
| 因果知識 | 結構化的 `symptom → rootCause → remedy → verifiedOutcome` 面向、矛盾偵測與並列衝突檢視。 |
| 代碼新鮮度 | 證據錨點追蹤檔案與符號；檔案被變更或刪除時，記憶被標記為 `POTENTIALLY_STALE` 或 `INVALID`，並套用檢索懲罰。 |
| 變更智能 | 倉庫監視器的變更會自動進入環境上下文（變更摘要＋信任影響）；`veyra_change_impact` 把變更檔案對應到受影響的記憶、受影響的錨點，以及選用覆核候選。 |
| 信任上下文 | 每筆被召回的記錄都被分類為 `trusted / review_required / stale / contradicted / insufficient_evidence`，並附理由與動作——讀取時的投影，絕不寫入、絕不改變權威／驗證。 |
| 記憶健康 | `veyra_health` / `/veyra health` 的發現（唯讀），加上僅在明確要求時套用生命週期動作的 `memory-maintenance` 技能。 |
| 知識觀測台 | 唯讀文字儀表板：總覽、搜尋訊號、記錄檢視、因果、關係、矛盾，與併整建議。 |
| 網路圖 | DSH web 伺服器提供的主機原生 SVG 頁面 `/veyra`（總覽＋1-hop 本地圖）；JSON 於 `/veyra/graph`、`/veyra/record`、`/veyra/search`。 |
| 設定 | Veyra 以內建預設值自動運作，沒有專屬的設定介面。進階 YAML 覆寫：`recallLimit` 預設 `5`（`0` 只停用自動召回上下文；手動召回、`/veyra`、觀測台與已存記憶不受影響），`includeReusable` 預設 `true`（專案隔離維持不變）。變更自下一回合／重新掛載生效，無需重啟。 |
| 工作區隔離 | 記憶被分割為**記憶房（rooms）**，每個 DSH 工作區（`WorkspaceId`）一個，所以同一儲存庫上開啟的兩個工作區永不共用記憶。沒有以路徑為鍵的退路：工作區註冊表不可用時，記憶即為不可用，呼叫直接失敗（fail closed）。`scope: 'reusable'` 為選用。 |
| 機密洗滌 | 任何內容在儲存前，機密先被洗滌。 |

---

## 指令

| 指令 | 功能 |
| --- | --- |
| `/veyra` | 本 workspace 的狀態與記憶計數 |
| `/veyra observatory` | 知識觀測台總覽 |
| `/veyra observatory search <query>` | 檢視混合搜尋訊號與分數拆解 |
| `/veyra observatory record <id>` | 深度檢視（What、Why、Where、When、證據、驗證） |
| `/veyra observatory causality` | 因果知識圖 |
| `/veyra observatory relationships [id]` | 知識連結的有向圖投影 |
| `/veyra observatory local <id>` | 某筆記錄周圍的 1-hop 本地圖 |
| `/veyra observatory contradictions` | 並列檢視目前衝突的主張 |
| `/veyra observatory consolidation` | 併整候選——唯讀，絕不修改記錄 |
| `/veyra recall [query]` | 對工作區（＋中央）記憶做混合搜尋 |
| `/veyra recent` | 近期記錄，含候選 |
| `/veyra inspect <id>` | 讀取一筆記錄，附深層來源與因果面向 |
| `/veyra forget <id>` | 軟遺忘 |
| `/veyra invalidate <id> [reason]` | 標記為無效；理由保留於生命週期歷史 |
| `/veyra supersede <id> <replacementId> [why]` | 以取代者讓一筆記錄退役 |
| `/veyra tombstone <id> [override] [reason]` | 退役至歷史（仍可檢視） |
| `/veyra protect <id> [reason]` / `/veyra unprotect <id>` | 保護一筆記憶不被遺忘（可稽核） |
| `/veyra promote <id> [derived\|canonical]` | 改變層級——**canonical 只能在使用者明確要求時** |
| `/veyra health [threshold]` | 記憶健康發現——唯讀，絕不修改記錄 |
| `/veyra code status` | 代碼智慧索引狀態與記憶新鮮度 |
| `/veyra code index` | 觸發倉庫重新索引 |
| `/veyra code trace <symbol>` | 追蹤符號的呼叫圖 |
| `/veyra code impact` | 檢查受代碼變更影響的記憶 |
| 網路圖 | DSH Web 中的 `/veyra`；`/veyra?id=<record>` 置中 1-hop 檢視 |

---

## 工具

**記憶工具**（永遠可用）：
`veyra_remember`、`veyra_recall`、`veyra_inspect`、`veyra_forget`、`veyra_promote`、`veyra_feedback`、`veyra_recurrence`、`veyra_health`

**變更智能**（永遠可用；無二進位時降級為路徑比對）：
`veyra_change_impact`

**代碼智慧工具**（需要 `codebase-memory-mcp` 二進位；不存在時優雅降級）：
`cbm_projects`、`cbm_search`、`cbm_snippet`、`cbm_trace`、`cbm_arch`、`cbm_search_code`、`veyra_code_status`

載入隨附的 `veyra` 技能，取得何時呼叫各工具、以及它們如何互相配合的完整指引。

---

## 技能

五個技能隨套件發布並自動註冊（不需另裝）：

| 技能 | 適用時機 |
| --- | --- |
| `veyra` | 需要 Veyra 自身的指引：工具用法、候選／衍生／正典、因果面向、混合搜尋語意，以及「倉庫事實為準」的規則。 |
| `codebase-memory` | 使用代碼智慧工具（`cbm_*`）時：何時優先用 `cbm_trace` 而非 grep、如何從符號走到呼叫圖、以及代碼智慧與 Veyra 記憶如何互補。 |
| `legacy-onboarding` | 首次進入陌生或舊有倉庫：基線評估、漸進式調查深度、證據優先擷取，並建立專案記憶基線（Project Memory Baseline）。 |
| `memory-review` | 想稽核本會話中值得保存的工程記憶：何者已記錄、何者缺失、何者看似過期或衝突。 |
| `memory-maintenance` | 明確要求清理或維護記憶時：執行健康發現與生命週期動作（keep / supersede / invalidate / forget / tombstone / revalidate / defer），並附前後對照——健康發現本身絕非授權。 |

---

## 記憶規則

| 項目 | 權威層級 | 會自動召回？ |
| --- | --- | --- |
| 自動捕獲的觀察 | `candidate` | 否 |
| 經學習閘門通過的教訓 | `derived` | 是 |
| 顯式提升的真理 | `canonical` | 是 |

canonical 絕不被自動賦予。儲存庫檔案保持權威——Veyra 絕不寫入你的倉庫。相似不等於同一：重疊的記憶是建立連結，而非合併。機密會被洗滌。記憶以 DSH 工作區記憶房隔離，跨入中央記憶只會經由顯式提升發生。

---

## 設定

DSH 設定不再提供專屬的 **Veyra** 區塊——Veyra 以內建預設值自動運作，不需要任何設定。設定結構仍接受 `recallLimit` 與 `includeReusable`，所以 profile 中既有的值會繼續生效，但這兩個值與其他設定一樣在 profile 的 `cordis.patch.yml` 中編輯。

`recallLimit: 0` 只停用自動召回上下文——工具、`/veyra`、觀測台與已存記憶全都照常可用。

其餘都在 profile 的 `cordis.patch.yml` 中設定：

```yaml
- id: veyra
  name: '@lovedolove/veyra'
  config:
    recallLimit: 5       # 0 = 無自動召回上下文
    includeReusable: true # 召回時納入中央記憶
    observe: true        # 捕獲會話活動
    learn: true          # 提升持久觀察
    codebaseWatch: true  # 監視倉庫檔案變更，標記過期記憶
    home: "~/.dsh/veyra" # 儲存根目錄
```

`observe` / `learn` / `home` / `codebaseWatch` 僅能經 yaml 設定。`VEYRA_HOME` 環境變數可覆寫儲存根目錄。

---

## 架構

```
  DSH host — Cordis plugin (src/plugin.mjs)
  session events ──► observe ──► observation ──► learning gate ──► derived memory
                                                                         │
                                                       promotion (explicit only)
                                                                         ▼
                                                                Central Memories

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Memory Server  ~/.dsh/veyra/  (node:sqlite + FTS5)                      │
  │  rooms/<roomId>/memory.db   ·   central/memory.db                        │
  └──────────────────────────────────────────────────────────────────────────┘
        projections (read-only)
  ┌───────────────┬────────────────┬─────────────────┬────────────────────────┐
  ▼               ▼                ▼                 ▼
  Hybrid Search   Local Graph      Agent context     Human surfaces
  recall/tools    (1-hop, bounded) systemPrompt      /veyra commands
  observatory     src/graph.mjs    (fail-closed)     Observatory / Network Graph

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Code Intelligence  (native daemon optional — see below)                │
  │                                                                          │
  │  stdio JSON-RPC 2.0 ──► cbm_* tools ──► freshness checks ──► retrieval  │
  │  bridge: @lovedolove/dsh-codebase-memory-mcp (declared dependency)      │
  │    client.mjs  engine.mjs  discovery.mjs  watcher.mjs  (in bridge pkg)  │
  │  Veyra: src/code/linking.mjs  src/code/retrieval.mjs                   │
  │                                                                          │
  │  Degraded when native binary absent: memory layer unaffected            │
  └──────────────────────────────────────────────────────────────────────────┘
```

本地圖是**派生投影，而非第二個儲存**。代碼智慧的橋接放在獨立的 `@lovedolove/dsh-codebase-memory-mcp` 套件（Veyra 的宣告執行時相依）中，透過 stdio 與外部原生 daemon 通訊；daemon 是唯一選用的部分。任何代碼智慧路徑都不會直接修改 Veyra 記憶。

完整說明：[docs/architecture-graph.md](https://github.com/LoveDoLove/Veyra/blob/main/docs/architecture-graph.md)

設計理念與所有機制導遊：[技術白皮書](docs/WHITEPAPER.md)（英文）與[繁體中文版](docs/WHITEPAPER.zh-TW.md)。

---

## 疑難排解

**啟動時沒有 `[veyra]` 行。** 插件安裝到了與啟動時不同的 profile。`dsh plugin --profile web add …` 安裝到 `web`；啟動 `dsh tui` 就不會帶上它。同時檢查**設定 → Plugins**。

**Node 版本過舊。** Veyra 需要 Node ≥ 22.5 且 < 25（`engines.node`）。它使用 `node:sqlite`，首次出現於 Node 22.5。升級 Node 後重新安裝。

**「Plugin … is incompatible with dsh …」** 套件的相容範圍是 `>=0.1.2-rc.1 <0.3.0-0`。更新 DSH，或按 DSH 印出的精確版本豁免接受風險。

**自動召回上下文為空。** 檢查：(1) profile 設定中的 `recallLimit` 不是 `0`；(2) 你期待的記錄是否仍是 `candidate`（候選絕不自動召回）；(3) 你處於同一工作區——執行 `/veyra` 確認解析出的記憶房 id。

**代碼智慧顯示「降級」。** `codebase-memory-mcp` 二進位不在 PATH 上，且 `CBM_EXE` 未設定。用上面的 curl 指令安裝，或設定 `CBM_EXE=/path/to/binary`。所有 Veyra 記憶工具照常運作。

**`/veyra code status` 回報記憶過期。** 被參考的檔案在記憶記錄之後變更了。對照目前倉庫驗證該記憶（`/veyra inspect <id>`），用 `veyra_remember` 更新它，若不再適用就遺忘它。

**網路圖頁面看起來是空的。** 要嘛 workspace 還沒有任何記錄（`/veyra recent`），要嘛頁面解析到的是另一個 workspace——`/veyra` 會印出它使用的 workspace 路徑。

**資料在哪 / 如何重置。** `$DSH_HOME/veyra/`（預設 `~/.dsh/veyra/`），若設定則為 `$VEYRA_HOME`。刪掉某個工作區的記憶房（`rooms/<roomId>/`）即可讓該工作區重新開始——你的儲存庫中沒有儲存任何東西，而 0.2.0 之前的 `projects/` 與 `reusable/` 目錄會被原樣保留、不被讀取。

**某處寫錯了記憶。** `/veyra forget <id>` 軟遺忘（仍可檢視、退出召回）。除非你執行 `/veyra promote <id> canonical`，否則任何記錄都不會成為 `canonical`。

---

## 開發

```sh
npm test               # node --test test/*.test.mjs
npm run pack:check     # npm pack --dry-run — 即將發布的內容
```

CI 在每次 push 與 pull request 時，對 Node 22 與 24 兩者皆執行（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。

發布由 [`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml) 處理：推送 `v*.*.*` 標籤或手動 `workflow_dispatch`（可帶 `version` 輸入）時觸發。它會驗證標籤等於 `package.json` 且該版本尚未存在於 npm，執行 `npm install` 與 `npm test`，檢查執行時相依，然後執行 **`npm stage publish`**——將 tarball 與其 provenance 聲明暫存，把 2FA 驗證延後到維護者核准。同一輪會建立對應的 GitHub Release（`vX.Y.Z`）。

因為「暫存」不等於「發布」，在維護者核准之前，套件會回傳 **HTTP 404**——這是預期行為，不是發布失敗。核准方式、`latest` dist-tag 為何落後、待核准／失敗的暫存如何處理，以及核准後的驗證指令，都記錄在 [`docs/research/m00193-npm-staged-publishing-documentation.md`](docs/research/m00193-npm-staged-publishing-documentation.md)。

---

## 相容性

| | |
| --- | --- |
| 目前版本 | `0.2.0` |
| Node | `>=22.5.0 <25.0.0` |
| DSH | `>=0.1.2-rc.1 <0.3.0-0` |
| 驗證於 | DSH `0.1.7-rc.2`（插件啟動、工具、`/veyra` ＋ `/veyra/graph`）；DSH `0.2.0-rc.1`（真實相容閘＋組合成 host-service 執行期）；DSH `0.2.0-rc.2`（組合成 host-service 執行期＋對照已宣告範圍的真實 `ToolRuntime` 工具輸出驗證）；DSH `0.2.2-rc.1`（工具執行器與 settings/prompt 效果處理的測試／執行期組裝相容修正；見 CHANGELOG）；CI 於 Node 22 與 24 |
| Profiles | 依 profile 安裝（`web`、`tui`、…）；網路圖需要 web 表面 |
| 儲存 | `node:sqlite` ＋ FTS5；每個工作區記憶房一個 DB，位於 `$DSH_HOME/veyra/rooms/<roomId>/`，另有一個共享的 `central/memory.db`。0.2.0 之前的 per-project DB 原樣留在磁碟上、不被讀取 |
| 代碼智慧 | 橋接以執行時相依 `@lovedolove/dsh-codebase-memory-mcp` 宣告；外部 `codebase-memory-mcp` 原生 daemon 為選用——daemon 缺席時代碼智慧降級，記憶層不受影響（二進位：MIT、DeusData；橋接：MIT、LoveDoLove） |
| 授權 | MIT |

Veyra 處於 1.0 之前的 `0.2.x` 線——已發布的內容見 [CHANGELOG](https://github.com/LoveDoLove/Veyra/blob/main/CHANGELOG.md)。API 與指令表面仍可能在次版之間變動。

---

## 授權

MIT — 見 [LICENSE](https://github.com/LoveDoLove/Veyra/blob/main/LICENSE)。

第三方授權說明 — 見 [THIRD_PARTY.md](https://github.com/LoveDoLove/Veyra/blob/main/THIRD_PARTY.md)。
