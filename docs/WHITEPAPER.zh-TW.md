# Veyra：程式編寫代理的工程智能

**技術白皮書 — @lovedolove/veyra v0.1.57**

本文件各項陳述之狀態：每一項實作陳述皆可溯源至所標明版本（v0.1.57，commit 75d74ab，乾淨樹）的
倉庫原始碼。驗證陳述引用 §11 與 §15 所指明的測試套件或附日期的運行時記錄。凡某特性已設計
但尚未在使用中獲得證明者，將於 §12 與 §13 標記為 *未證明（unproven）*。本文件的任何內容都不應
被理解為超出所陳述證據範圍的效能或結果保證。

**繁體中文（本文）· 英文版：[docs/WHITEPAPER.md](./WHITEPAPER.md)**

---

## 1. 執行摘要

程式編寫代理（coding agent）反覆地重新推導專案早已知道的事：某個建置旗標為何存在、哪個
修正方案被嘗試過又被否決、正典（canonical）的架構決策是什麼、最近發生了哪些變更。Veyra
為它們提供一個持久、按專案隔離的**工程記憶（engineering memory）**，其特性為：

- **有據可依（Grounded）** — 每條記錄都攜帶指向倉庫的證據錨點（檔案路徑、註記、URI），
  而倉庫外的路徑永遠不可能成為證據（§6）。
- **結構上即可信（Trustable by construction）** — 一條權威階梯
  （`candidate → derived → canonical`；候選 → 衍生 → 正典），其中只有人類
  透過顯式工具呼叫才能晉級至正典；被召回記錄與當前任務的相似度永不賦予權威
  （§3、§6）。
- **對變更感知（Change-aware）** — 新鮮度與信任於讀取時針對倉庫狀態進行評估，
  使過時知識被降級，而非被悄然提供（§6、§7）。
- **僅供諮詢，不可執行（Advisory, not executable）** — 被召回的記憶以上下文
  形式注入，並附帶一貫的免責聲明：它不是倉庫事實、也不是指令；倉庫仍是唯一
  的事實來源（§3、§7）。

Veyra 以 DSH（DeepSeek Harness）插件形式交付：純 ESM、零運行時依賴、於
$DSH_HOME 之下每專案一個 SQLite+FTS5 資料庫、可選的結構性程式碼智能
（透過外部圖二進位檔）；其餘為一個在每次運行時都自我再斷言其結果表的
測試框架，以及運行時、隔離／安全、端到端測試套件。

本文件全程刻意區分四個陳述層次：**設計目標**（§12.1）、**已實作**
（§12.2）、**已驗證**（§12.3）、**未證明**（§12.4）。兩個真實專案已端到端
行使過本系統——SmartTrip（Web 應用，10 層端到端驗證全數通過）與
dsh-token-saver（85 筆記錄的存量導入，發現並根因定位了一項自動召回品質
缺陷）。量化問題*"Veyra 是否改善代理任務結果？"*仍然顯式地開放著：
成對任務影響實驗已凍結且可重現，但尚未執行（§11.3）。

---

## 2. 背景：問題

程式編寫代理的上下文視窗是工作集（working set），不是儲存庫。跨會話時，
它會失去：

1. **架構理據** — 專案*為何*選擇 Postgres 而非圖資料庫；哪個修正模式被否決、
   又因為什麼症狀。
2. **排錯史** — 過去某個已修復 bug 的根因，以及實際起效的救治方案（與不起效
   者）。
3. **約束** — 「必須支援 Node 22」、「不得新增依賴」、「不要碰模組 X」。
4. **新鮮度** — 上述各項在程式碼變更後哪些仍然成立。

現有的緩解手段各有所失：對話歷史是單會話且無據的；文件會與程式碼漂移
（SmartTrip 儲存庫即浮現兩起真實漂移案例：已移除的功能仍在文件中宣稱，
以及一項文件陳述與量測到的出站流量（egress）行為相矛盾，§11.1）；臨時手寫的
markdown 知識檔案沒有生命週期、沒有權威模型、也沒有讀取時信任評估。

Veyra 的定位：工程記憶是**一等的、按專案隔離的、證據錨定的、版本化的儲存庫**，
具顯式的權威、驗證與新鮮度軸——只在讀取時投射進代理上下文，且每次讀取
都重新校驗（§3 信任鏈）。

---

## 3. 設計原則與核心不變量

Veyra 的行為圍繞一條信任鏈組織：

    倉庫事實（Repository Truth）＋ 工程記憶（Engineering Memory）
        → 適用性與新鮮度（Applicability & Freshness）
        → 信任（Trust）
        → 代理上下文（Agent Context）

記憶對代理有用，只有在它*在此倉庫狀態、對此任務下可信*時；即便如此，它
也是以**上下文而非指令**的形式到達。以下五項不變量是承載性的：每一項都有
具名機制，且每一項都由一個測試維度保護（§12.3 的 D 欄）。

| # | 不變量 | 陳述 | 機制 | 護衛 |
|---|-----------|-----------|-----------|-------|
| P1 | **觀察 ≠ 儲存** | 看見某事發生，不等於它為真。觀察管線僅記錄*候選*；噪聲過濾器丟棄非技術文本；捕獲閘門只保留技術面向。 | `src/observe.mjs:42` `isNoiseText`、`src/observe.mjs:174` `candidateFromBuffer` | D2（4 個噪聲探測產出 0 條偽記憶）、D3 |
| P2 | **候選 ≠ 事實** | 低權威記錄絕不自動召回，也絕不自動晉級。寫入閘門依出處（provenance）將自動學習暫緩（DEFER）；正典權威只能透過人類顯式簽發的 `veyra_promote` 到達。 | `src/learn.mjs:218` `learningGuards`（:221 DEFER `provenance-gated`、:224 `canonical-requires-explicit-promotion`）；召回閘 `isRecallEligible` 位於 `src/types.mjs`（排除 candidate 與 observation 種類；要求 authority 為 derived 或 canonical） | D31（0 次自動→正典嘗試）、D31b（1 次顯式晉級）、D4/D5 |
| P3 | **相似度 ≠ 權威** | 一則文本上與查詢高度吻合的記錄，仍只攜帶它實際擁有的權威。權威、驗證、信心與證據強度*獨立*於詞彙或語意相似度評分；相似度僅貢獻於排序，低相似度是地板、絕非否決——高相似度同樣永不授予權威。 | `src/retrieve.mjs`：`authorityTier` :78、`confidenceScore` :93、`relationshipScore` :223、`causalRelevance` :310（均與相似度無耦合） | D7/D8、D12/D13 |
| P4 | **相似度 ≠ 適用性** | 一則記錄可能文本上近似相關、卻不適用於當前工具鏈、任務或時間窗。適用性由結構化上下文鍵與時間邊界判定，而非查詢匹配；預設範圍詞衡量的是範圍接近度，而非適用性。 | `src/retrieve.mjs`：`scopeProximity` :87、`contextCompatibility` :476、`temporalBounds` :414、`temporalState` :434；`src/retrieve.mjs:512` RRF 融合（K=60、權重 0.06） | D10（6/6）、D11（4/4） |
| P5 | **記憶 ≠ 可執行指令** | 被召回的記憶進入代理上下文時被標註為「所記經驗」：「非倉庫事實；對照程式碼庫驗證；相似度不是權威。」代理可以無視它（代價是自身任務品質）；它絕不是一條命令。插件本身不對使用者倉庫執行任何寫入。 | 上下文建構器 `src/context.mjs:521` `buildRecallContext`（僅在零記錄時回傳空字串；召回錯誤時失敗閉合 fail-closed）、渲染時注入免責警告（`src/context.mjs:249`，經 `src/redact.mjs` 洗滌）；敵意注入訊號（`ignore_previous`、角色覆寫）被*偵測並標旗*，而非被服從（D30/D30b） | D30、D30b |

第六項原則 **倉庫事實（Repository Truth）** 是以上五項的底層基礎：任何已儲存
記錄都不高於倉庫，信任於每次讀取時重新推導（§6），且系統被設計為*隱瞞矛盾
是受否決的行為*——矛盾始終保持可見（D14–D15b）。

---

## 4. 系統架構

Veyra 是一個 DSH 插件（依 `package.json`，相容 DSH 版本 0.1.2-rc.1 至
0.2.0-rc.2；README 排障條目所列之發布範圍為 `>=0.1.2-rc.1 <0.3.0-0`；
`node:sqlite` 要求 Node `>=22.5.0 <25.0.0`）。它零運行時依賴；隨附模組圖
為純 ESM，打包後約 180 kB。

### 4.1 雙腦模型

    ```mermaid
    graph TB
        AGENT["coding agent 會話<br/>system-prompt 上下文：所記、僅供諮詢"]
        subgraph PLUG["VEYRA 插件 (DSH)"]
            OBS["observe → 捕獲閘門<br/>→ 寫入閘門（DEFERs）→ SQLite 儲存庫"]
            RET["retrieve（混合 + RRF + 1-hop 圖）<br/>→ 上下文投影"]
            LIFE["lifecycle：protect / invalidate / supersede<br/>/ forget / tombstone"]
            TRUST["trust（讀取時分類）· redact · security"]
        end
        STORE["每專案儲存庫<br/>$DSH_HOME/veyra/projects/&lt;p_id&gt;/memory.db（+ FTS5）"]
        CBM["codebase-memory-mcp 二進位（外部）<br/>不存在 → 降級模式；記憶層完好"]
        AGENT -- "recall（閘控、有界）" --> RET
        AGENT -- "observe / learn" --> OBS
        OBS --> STORE
        RET --> STORE
        TRUST --> STORE
        RET -. "stdio JSON-RPC（可選）" .-> CBM
    ```

一個儲存庫的四個**投影**，而非四個儲存庫：

1. **混合搜尋** — 詞彙（FTS5）＋語意（Jaccard token 重疊）
   兩通道，經互易排名融合（reciprocal-rank fusion，`src/retrieve.mjs:532`）融合。
2. **本地圖** — 建構於記憶列與其關係列之上的派生 SQLite 投影；節點是記錄
   標識，邊是 `{type, targetId}`，型別嚴格為
   `updates | extends | derives | contradicts | supersedes`
   （`src/types.mjs`；`src/graph.mjs` `localGraph`）。它*不是*
   第二事實來源；邊沿用其端點記錄的信任
   （`trusted === isRecallEligible`）。預設有界：1-hop 擴展、
   40 節點 / 80 邊上限（`GRAPH_LIMITS`，hops=1，maxHops=2）。
   WebUI 首頁以概覽投影提供同一合約
   （`src/webui.mjs:189` `handleVeyraHttp`，註冊於 :236——
   **唯讀**的 `/veyra` 介面；已對抗變更嘗試驗證，§11.1）。
3. **代理上下文** — §7 的召回投影，附免責聲明
   與注入警告洗滌。
4. **人機介面** — 唯讀 WebUI 與五個隨附代理技能
   （`veyra`、`codebase-memory`、`legacy-onboarding`、`memory-review`、
   `memory-maintenance`）。

**儲存身份。** 每專案一個 SQLite+FTS5 資料庫，位於
`$DSH_HOME/veyra/projects/<p_id>/memory.db`（預設 `~/.dsh/veyra`；
可用 `VEYRA_HOME` 覆寫）。專案標識 `p_<16hex>` 由
`sha256(gitRoot|remote)` 派生（`src/store.mjs` `projectIdFor`）；記錄標識為
`vey_<hash>_<suffix>`。任何內容都不寫入使用者倉庫。
索引：`memory`、`memory_fts`、`memory_search_fts`。去重
依寫入時的內容雜湊（儲存層提前回傳）。

**可選程式碼智能。** `src/code/`（`client`、`engine`、
`discovery`、`linking`、`watcher`）經 stdio 上的 JSON-RPC 2.0 與外部原生圖二進位
（環境變數 `CBM_EXE` 或 PATH）對話。當二進位
不存在時該層降級：所有記憶層功能保持完全
可用；結構性查詢單純不存在。

**設定。** `recallLimit`（預設 5，`src/types.mjs:82`
`DEFAULT_RECALL_LIMIT`；`src/config.mjs:26` `normalizeRecallLimit` 將
undefined/null/空 映射為預設值，並尊重顯式的 0）、
`includeReusable`、`observe`、`learn`、`codebaseWatch`、`home`。

---
## 5. 記憶生命週期

記錄具六種類型、三個權威層級、五種驗證狀態，以及生命週期動作。完整圖示：

    ```mermaid
    graph TD
        EVT["agent events"] -->|observeEvent| NOISE["噪聲過濾器（isNoiseText）<br/>＋ 捕獲閘門"]
        NOISE --> C["候選 candidate<br/>自動捕獲；絕不自動召回<br/>寫入閘門 learningGuards：DEFER"]
        C -->|"veyra_promote 至 derived<br/>標記為「有用的學習記憶」"| D["衍生 derived —— 具自動召回資格<br/>驗證：unverified → reviewed → verified<br/>（僅人類審查步驟）"]
        D -->|"veyra_promote explicit: true<br/>唯一途徑；絕不自動"| K["正典 canonical —— 專案事實<br/>具召回資格；verified 狀態下對失敗免疫"]
    ```

類型（與權威正交）：`observation`、`memory`、`knowledge`、`evidence`、
`negative`（已知失敗的方案：標題即假說，內文即否決理由）、`unresolved`
（開放中的調查：標題即問題，內文即已知線索）。

生命週期動作（`src/lifecycle.mjs`）：`protectionOf` :101、
`protect` :120、`unprotect` :136、`invalidate` :155、`supersede` :180、
`forget` :217（軟遺忘——記錄保持可檢查、但離開召回池；原因保存於
生命週期歷史；受保護記錄需要 override ＋ 原因）、`tombstone` :234。

演化（`src/evolve.mjs`）：`markStale` / `sweepStale` 偵測證據對倉庫狀態
不再成立的記錄；過時記錄離開召回池（D18：0 條過時記錄被召回），但*保持
可見*為過時狀態，絕不靜默刪除。

**負例（negative）與未決（unresolved）通道**是一等公民，不是特例：
它們參與召回，使針對失敗方案的查詢先把已知失敗的嘗試浮現出來
（D4/D4b/D5：negative＋unresolved 召回 1.0，top 結果是具體的死鎖否決
記錄，而非一個貌似合理的回答；D6：冪等——重複詢問不會產生重複記錄）。

**回饋迴路（§19 of the design，`src/feedback`）**：在實務中應用一條記憶
並回報結果（`veyra_feedback`）——成功使已驗證記錄增強，失敗則降級
（D21 降級階梯 1.0）。兩項刻意設計的非對稱性，均有測試保護：

- **成功永不自我驗證**（D22）：一條 verified 記錄即便只是「起作用了」
  也降回 reviewed——驗證是人類的審查步驟，不是應用計數器。
- **正典對失敗免疫**（D22b）：針對正典記錄的失敗只記錄歷史、保留
  verified 狀態；正典權威由人類授予、由人類收回。

**復發偵測（§20，`src/negative`，`veyra_recurrence`）** 跨記錄找出同一
根因／症狀／失敗救治（或某條記錄重複應用失敗）；預設唯讀。共享同一
已驗證救治方案的簇可升為寫入閘門候選（D23–D25 全數 1.0）。它絕不
自動晉級；晉級決定歸 P2 所有。

**健康度（§21，`src/health`）** 將資料庫歸類為九個品質類別
（verified / reviewed / unverified / stale / invalid / contradicted /
unresolved / negative / protected），並產出六類維護發現
（新矛盾、過時知識、未決調查、重複失敗、未驗證的高價值候選、需要
再驗證的記錄）——這些發現是*顯式審查的證據*，絕非自動編輯。

---

## 6. 證據與信任機制

### 6.1 證據錨點

每條記錄可攜帶證據錨點：相對於倉庫檔案的 `path`、自由文本 `note`、
或外部 `uri`。兩條硬規則：

- **倉庫外的路徑絕不成為證據** — 無法在專案中解析的錨點在讀取時被降級
  （D16 證據失效降級），而噪聲／捕獲閘門（P1）只保留技術面向
  （Veyra 儲存庫中的記錄 vey_1a148b492d3 即記錄了這起 P0 修復）。
- **證據健康度持續檢查**（D19：5/5）— 失效的錨點會在記錄上顯式標旗
  （`CODE EVIDENCE INVALID: anchored file missing or symbol unresolvable`），
  過時錨點依鮮度層級降級（§6.2），矛盾依 §6.2 的政策保持可見
  （D14–D15b）。

### 6.2 讀取時的信任上下文分類

信任是**讀取函數，不是儲存的欄位**。讀取時
`src/trust.mjs:95` `classifyRecordTrust` 將每條記錄歸入五個類別之一
（`TRUST_CATEGORIES` at :34）：
`trusted | review_required | stale | contradicted | insufficient_evidence`，
並附帶動作詞表（`TRUST_ACTIONS` at :43：use as context / revalidate / …）。
工具 `veyra_change_impact` 對 diff 的變更檔案執行此分類，使代理在
依賴被召回的知識之前，先看到哪些知識可能已被變更作廢——
且不對任何記錄自動晉級或自動降級。鮮度層級
（`src/retrieve.mjs:102`）與時間邊界（`:414`、`:434`）
餵入同一分類。

**矛盾政策：** 矛盾被偵測（D14）、在資料庫與召回輸出中保持可見
（D15）、並被精確計分（D15b）。隱瞞或靜默合併矛盾被列入架構決策的
*reject* 清單（`docs/architecture-graph.md` §3）——
解決矛盾是人類的動作（supersede/invalidate），絕不是檢索動作。

---

## 7. 召回與檢索

### 7.1 管線

    ```mermaid
    graph TD
        Q["查詢（＋ 任意 goal）"]
        LEX["詞彙通道（FTS5）<br/>lexicalScore :146"]
        SEM["語意通道（Jaccard token 重疊）<br/>semanticSimilarity :210"]
        FUSE["互易排名融合<br/>RRF_K=60, FUSION_WEIGHT=0.06 (:512/:532)"]
        RANK["rankRecords :561 —— 逐記錄因子：<br/>evidenceStrength :25 · validationTier :60 · authorityTier :78<br/>confidenceScore :93 · freshnessTier :102 · scopeProximity :87<br/>relationshipScore :223 · causalRelevance :310<br/>temporalBounds/State :414/:434 · contextCompatibility :476"]
        GOAL["目標親和度（選用）<br/>goalAffinity :352, GOAL_WEIGHT 0.7 (:331)<br/>排序方向，永不授予權威"]
        GRPH["對融合 top-K 做 1-hop 圖擴展<br/>(GRAPH_LIMITS；上限見 §4.1)"]
        GATE["召回閘 isRecallEligible (src/types.mjs；應用於 :970, :1029)<br/>未遺忘 · 狀態 current · 非 invalid/stale<br/>非 candidate · 非 observation<br/>authority ∈ {derived, canonical}"]
        TAIL["負例／未決覆蓋尾端<br/>NEG_COVERAGE_MAX (def :856, value 3)<br/>已知失敗方案即使排名靠後也浮現"]
        LIM["limit 處理：limit === 0 → [] (:952)<br/>slice 於 Math.max(0, limit − negTail) (:1014)"]
        CTX["buildRecallContext :521 → 代理上下文<br/>免責聲明＋注入警告經洗滌（src/redact.mjs）<br/>僅零記錄時回傳空字串；召回錯誤時失敗閉合"]
        Q --> LEX
        Q --> SEM
        LEX --> FUSE
        SEM --> FUSE
        FUSE --> RANK
        RANK --> GOAL
        GOAL --> GRPH
        GRPH --> GATE
        GATE --> TAIL
        TAIL --> LIM
        LIM --> CTX
    ```

M11（`docs/m11-recall-intelligence.md`，2026-09-28 於 v0.1.32 驗證；
測試套件 337 → 354 項）修復了探測套件發現的兩項結構性缺陷：
**(a)** 純元資料汙染——攜帶零查詢訊號的記錄，其組成分數被推高到 ~0.80、
甚至壓過真正 0.776 的匹配；此類零訊號組成現已被抑制；**(b)** 冗餘——
同一事實的三種表述在一個上下文中塌縮成三條「不同事實」
（931 → 724 位元組）。該里程碑明列的非目標：不做 embeddings、
不建向量庫、不加 reranker、不用 LLM judge、不用圖資料庫、
不設遠端服務、不做遷移——混合詞彙＋RRF 的設計是刻意選擇。

### 7.2 limit 處理（一個值得明言的已修缺陷）

在 v0.1.14，`recallLimit: 0` 被強迫為預設值 5，且檢索路徑將 limit
下界設為 1，使「關閉召回」不可能——這阻斷了成對任務影響實驗的
隔離臂（§11.3），並被凍結為架構文件中的開放問題。產品 bug 已修復
（`src/config.mjs:26` 尊重顯式的 0；`src/retrieve.mjs:952` 回傳
空列表），D31/D31b 與回歸測試守住它。但實驗的*結果*從未被量測——
見 §11.3。

---

## 8. 既有專案的開端（Bootstrapping）

`legacy-onboarding` 技能針對冷啟動問題：一個沒有記憶基線的陌生專案。
其合約，逐行：評估既有基線；發現倉庫；選擇漸進式調查深度；
僅提取**有可驗證證據支撐的持久工程知識**；產出供未來代理
召回、而非重新調查的**專案記憶基線（Project Memory Baseline）**。
捕獲的每一項都是候選（P1/P2）：只有經顯式晉級才進入召回，
且其證據錨點使其保持可檢查（錨點過時時自動降級）。§11.2 是實例。

---

## 9. 安全與隔離

| 性質 | 機制 | 護衛 |
|---|---|---|
| 按專案隔離儲存 | 每個專案標識一個 `memory.db`；reusable 範圍記錄僅在 `includeReusable`（選用）後共享 | D32：2 個查詢 0 跨專案洩漏；測試 `isolation-security-benchmark` |
| 機密衛生 | `scrub` / `redact`（`src/redact.mjs:45` / :74）於寫入時自標題、內文、標籤、證據與 source 欄位剝除機密 | D26：0 洩漏；D26b：bearer/JWT 型式 token 被洗滌 |
| 注入抵抗 | 被召回內容*作為數據*渲染：敵意標記（`ignore_previous`、角色覆寫措辭）於渲染時被偵測，並洗入一條警告，絕不執行 | D30 偵測、D30b 0 誤報 |
| 損毀時失敗閉合 | 未通過完整性檢查的資料庫被拒絕，而非被修復或半讀：原文錯誤 "Veyra refuses to open corrupted store" | D27–D29（標旗、排除、浮現、拒絕） |
| WebUI 唯讀 | `/veyra` 介面對任何變更一律不接受（`src/webui.mjs:189`） | SmartTrip 層級 L9，§11.1 |
| 正典安全 | 不存在任何自動化途徑——寫入閘門、回饋迴路或復發偵測——能到達正典權威（P2） | D31（兩種 defer 原因下 0 次嘗試）、D31b（顯式可行） |
| 不寫入倉庫 | 插件只在 $DSH_HOME/veyra 之下寫入 | 架構不變量，`docs/architecture-graph.md` §3 |

---
## 10. 評估方法學

**主體測試架構：** `test/m15-benchmark.test.mjs` — 29 項測試、覆蓋
45 個具標籤維度（D1–D32，含子維度），文件見 `docs/BENCHMARK.md`。
架構**在每次執行時重新斷言其自身結果表**：基準回歸會使建置失敗，
而非靜默改變已發布的數字。兩項計數政策：空分母以 null 呈現
（絕不為 0），且 BLINDSPOT 政策記錄*已知未覆蓋*行為（目前 0 項）；
今天的表格不帶盲點。

重點維度（皆於 v0.1.57 經 `npm test` 驗證）：

| 維度 | 量測內容 | 結果 |
|---|---|---|
| D1–D3b | 寫入精確度／錯誤記憶／去重／錯誤合併 | 1 / 0 / 1（5/5 重述不產生新列）/ 0 |
| D4–D6 | 負例與未決召回、冪等性 | 1 / 1 / 1 |
| D7–D8 | 5 個標註查詢之 top-1 與 MRR | 1 / 1 |
| D9/D9b | 離題壓制 | 0 / 0 |
| D10–D11 | 適用性、時間性 | 6/6、4/4 |
| D12–D13 | 因果強度排序、因果偽訊號 | verified(1) > suspected(0.567) / 0 |
| D14–D15b | 矛盾偵測／可見性／精確度 | 1 / 1 / 1 |
| D16、D18–D19 | 斷裂證據降級、過時離開召回、證據健康度 | / 0 / 5/5 |
| D20 | 回饋可靠性，5 次嘗試中 2 成功 3 失敗 | 0.4 — 為 fixture 的**算術恆等式**，非目標值 |
| D21、D22、D22b | 降級階梯／成功不自我驗證／正典免疫 | 1 / 1 / 1 |
| D23–D25 | 復發偵測／候選資格／精確度 | 1 / 1 / 1 |
| D26、D26b | 機密洩漏／bearer-JWT 洗滌 | 0 / 已洗滌 |
| D27–D29 | 損毀標旗／排除／浮現／損毀儲存庫拒絕 | 全數驗證 |
| D30、D30b | 注入偵測／誤報 | 已偵測 / 0 |
| D31、D31b | 自動→正典嘗試／顯式晉級 | 0 / 1 |
| D32 | 跨專案洩漏（2 個查詢） | 0 |

**補充套件：** `test/isolation-security-benchmark.test.mjs`
（專案隔離＋安全性質）、`test/dsh-runtime.test.mjs`（真實 DSH 運行時
整合）、`test/e2e-workflow.test.mjs`（完整 observe→learn→recall→
lifecycle 工作流）、十個 `test/code-*.test.mjs`（可選代碼智慧層模組），
以及各里程碑套件（`m1`–`m14`，例如 `m11` = 召回智慧探測、`m3` =
RRF 融合、`m4` = 適用性/時間性、`m5` = 因果溯源、`m10` = 遺忘與保護、
`m12` ×3、`m13` = 安全強化、`m14` = 目標檢索、`m1-write-gate`、
`m2-negative-unresolved`）。CI 執行 `npm test` 與
`npm run pack:check`（打包尺寸不變量）。

**誠實的評估限制：** 各維度是*fixture 化的*。它們證明*機制*在構造的
儲存庫上如規格般行為；它們不量測代理任務成果，也不是「野外」基準。
§11 才是真實、非構造的儲存庫與系統相遇之處。

---

## 11. 生產環境驗證（兩具儲存庫）

### 11.1 SmartTrip（`p_6aed36ea45dd7de9`）

Next.js ＋ Supabase 專案。2026-09-24 的十級 E2E 全數通過：
L1 插件安裝、L2 profile 整合、L3 專案儲存庫建立、L4 寫入路徑、
L5 讀取/召回、L6 權威模型、L7 儲存庫隔離、L8 圖譜投影、
L9 WebUI 變更保護、L10 新會話持久化。

儲存庫含 23 條記錄（16 條 derived/unverified、1 條 canonical/reviewed、
2 條 superseded、1 條 stale、2 條 candidate）。重點事實：

- **D1：** 「Supabase 走 REST 而非 TCP」被儲存、經顯式人類動作晉級為
  正典，並以原文與改寫（paraphrase）两种方式被召回——
  P2 在一具真實儲存庫上的證明。
- **文件漂移案例：** 已被移除的 chat-refine 功能仍殘留在
  docs/README/升級提示中；量測的 Gemini 出口流量為 Asia，與文件
  宣稱的 US 不符。
- 16/23 為 unverified——多數如此是正常狀態。
- 本次執行已記錄於 Veyra 自身儲存庫 `p_2d599165fe7aa1a7`（430 條記錄）
  中：`vey_1a0d44d8401` 與 `vey_1a0d4545572`（L1–L10 通過報告）。

### 11.2 dsh-token-saver（`p_0fd9252c3955a1c2`）

2026-10-27 經 `legacy-onboarding` 建立的基線。專案是一個成熟的 DSH
上下文工程插件；85 條記錄（66 條 candidate/unverified、16 條
derived/unverified、1 條 derived/reviewed、1 條 candidate/stale）。
內容涵蓋：架構概覽、穩定的提示快取佈局、提示整形、上下文壓力與
LLM 摘要壓縮、RTK 表格過濾。

依 §8，所有項目在建立時即為未驗證候選（candidate 加權）。
此處**坦陳一項缺陷**：自動召回曾浮現不相關的 reusable 記錄、且其
證據錨點過時——Cloudflare Workers「Issues」監控知識、wrangler
source-map 知識（錨定 `wrangler.jsonc`，無法解析）、以及一條
「DSH 插件整合模式」記錄（源檔案缺失）。每筆均被證據健康度標旗
（`CODE EVIDENCE INVALID`）；根因已分析並記錄為
「Veyra auto-recall noise observed in a dsh-token-saver session
(2026-10) — root cause analyzed」。

兩項限定條款：(a) 這是單一觀察會話的群體，不是量測出的噪聲率
（reusable 範圍屬 `includeReusable` 選用）；(b) 沒有前/後改善量測。

### 11.3 配對任務實驗（凍結）

`docs/experiment-impact.md` 內含凍結的 5 任務協議：v0.1.14、
commit `1c17f70`，無召回臂設 `recallLimit: 0`。實驗**凍結於受阻狀態**
（limit 0→1 記錄、678 字元提示、隔離臂洩漏；文件記為「Architecture
open question #2 未更新：沒有量測出的配對結果」）。該缺陷今已修復
（§7.2），實驗現可執行——但**尚未重跑**；不存在任何量測出的效用
聲明。這是最大的缺口，且是排程項目而非假設（§14）。

### 11.4 通用性限定

兩具儲存庫都是 DSH 插件相鄰專案、同機執行；SmartTrip 規模小；
dsh-token-saver 的基線在未驗證候選加權狀態下建立。上述驗證**不
可推廣**至陌生的大型 monorepo、非 DSH 宿主、或敵意貢獻環境。
基準＋此兩具儲存庫＝本文所聲稱的全部驗證。

---

## 12. 聲稱矩陣（已實現／已驗證／未證實／缺口）

### 12.1 設計目標（`GOAL.md`）

可靠的、持久的、具變更意識的工程記憶；知識有證據錨點；權威、
驗證、鮮度與適用性是顯式且相互獨立的軸；被召回內容以*僅供諮詢*
注入；按專案隔離；不寫入倉庫；確定性、有界、失敗閉合；最終在
配對任務上**量測**出效用（§11.3）。

### 12.2 已實現

| 能力 | 位置 |
|---|---|
| 觀察／捕獲／寫入管線 | `src/observe.mjs`、`src/learn.mjs`、`src/store.mjs` |
| 六種類型＋權威＋驗證軸 | `src/types.mjs` |
| 生命週期動作 | `src/lifecycle.mjs` |
| 演化（過時偵測） | `src/evolve.mjs` |
| 混合召回＋圖 | `src/retrieve.mjs`、`src/graph.mjs` |
| 讀取時信任分類 | `src/trust.mjs` |
| 回饋、復發、健康度 | `src/feedback`、`src/negative`、`src/health` |
| 上下文注入、注入警告、機密洗滌 | `src/context.mjs`、`src/redact.mjs` |
| WebUI＋觀測台 | `src/webui.mjs` |
| 可選代碼智慧層 | `src/code/` |
| 五項技能 | `skills/` |
| 29 測試／45 維度架構 | `test/`、`docs/BENCHMARK.md` |

### 12.3 已驗證

- §10 全部維度結果，於 v0.1.57 經 `npm test` 複斷言。
- M11 修復（337 → 354 項測試；探測 p1–p15）。
- 運行時與整合：`dsh-runtime`、`e2e-workflow`、
  `isolation-security-benchmark`。
- SmartTrip L1–L10（2026-09-24，真實儲存庫：含正典晉級、改寫召回、
  WebUI 唯讀、跨會話持久化）。
- Recall-off 屬真實功能（`recallLimit: 0` → 空上下文，§7.2）。

### 12.4 六項未證實（設計有此性質、使用中未證明）

1. **任務成果效用** — §11.3 的實驗被凍結。
2. **onboarding 覆蓋率**未量測（dsh-token-saver 無前/後對比）。
3. **自動召回噪聲率** — 僅單一会話群體。
4. **通用性**超出 DSH 插件相鄰專案（§11.4）。
5. **真實環境的失敗非對稱性** — D22/D22b 已 fixture 驗證，但
  長期儲存庫（如 Veyra 自身 430 條記錄）僅推斷、未審計。
6. **超出詞彙＋RRF 的語意召回** — 依 M11 設計不做 embeddings；
  詞彙＋重疊在大型儲存庫上的上限未量測。

### 12.5 相對於 dsh-memory 參考引擎的缺口

（`../refs/dsh-memory`，姊妹本機 checkout；Python `md_cg` 血脈；
`docs/capability-matrix.md` Phase 0）：確定性跨通道 RRF 評審、
獨立的適用性條件判斷、衰減時間性 v2、因果鏈走訪與解釋、
僅追加溯源台帳、准入式自主權讀取——差距列表，非承諾。

---

## 13. 限制

1. **確定性檢索**：無 embeddings、向量庫、reranker、LLM judge、
   圖資料庫或遠端服務（M11 非目標）。
2. **fixture 化基準**：機制證明，非任務成果（§10、§11.3）。
3. **證據粒度**：檔案/符號/URI；倉庫外路徑被禁止（§6.1）；
   web URI 錨點在讀取時不再複查——D19 只檢查倉庫側。
4. **onboarding 體量不對稱**：dsh-token-saver 85 條中 66 條為
   candidate；召回資格落後於基線一個顯式晉級步驟。
5. **reusable 範圍噪聲**：標旗是自動的，抑制品質仍開放
   （§11.2、§13 第 5 項）。
6. **人類綁定步驟**：驗證、正典晉級、矛盾解決、受保護記錄的
   遺忘皆需人類；P2 無法自行閉環。
7. **宿主要求**：DSH 插件、Node ≥ 22.5 之 `node:sqlite`；
   可選圖層需要 CBM 二進位，否則降級。
8. **建議式記憶**：代理可忽略召回內容（P5）；其價值受代理
   合規度約束；§11.3 的實驗正是要量測這一點。

---
## 14. 未來方向

GOAL 文件的姿態：**核心技術基盤已基本完成；剩下的方向是整合，而非功能蔓延。**
具體而言，以架構的 reject/defer 清單（`docs/architecture-graph.md` §3）
為常態邊界：

- **Reject（常態）：** 外部圖資料庫（Neo4j 或任何形式）；新的節點類型
  （file/commit/repo）；新的 UI 關係類型；「needs-review」詞彙；預設
  全專案圖譜；**auto-canonical、靜默合併、隱藏矛盾**（核心不變量）；
  FUSE/SMFS 连接器與遠端 API。
- **Defer（常態）：** 預設 2-hop 走訪（僅當 1-hop 被證明量測上薄弱時）；
  邊級驗證/溯源（關係保持為 `{type, targetId}` 並繼承端點信任）；
  新的 MCP 工具（`veyra_inspect` 已回傳關係）。
- **下一具體步驟：** 在其阻斷性產品缺陷已修復後，執行凍結的配對任務
  影響實驗（§11.3）；發布第一組量測出的效用數字，或第一個誠實的
  零結果。
- **具名未決事項：** 關閉 reusable 範圍噪聲項目（§11.2/§13.5）；§12.5
  的缺口列表仍是議程、非承諾；里程碑測試套件的整併是維護任務、非功能。

---

## 15. 可追溯性

| 本文中的聲稱來源 | 位置 |
|---|---|
| 英文版（對照原文） | `docs/WHITEPAPER.md` |
| 產品目標、信任鏈、現況列表 | `GOAL.md` |
| 事實基線、adopt/reject/defer、圖譜合約、WebUI 唯讀性 | `docs/architecture-graph.md`（§3 表格；基線 0.1.12/0.1.14/0.1.18） |
| 45 維度基準表＋架構政策 | `docs/BENCHMARK.md`、`test/m15-benchmark.test.mjs` |
| 召回智慧里程碑、非目標、探測 p1–p15 | `docs/m11-recall-intelligence.md`（2026-09-28 於 0.1.32 驗證） |
| 凍結的影響實驗協議及其受阻狀態 | `docs/experiment-impact.md`（v0.1.14 / 1c17f70 的 5 任務凍結） |
| 相對於先行技術的能力缺口 | `docs/capability-matrix.md`（Phase 0 對 `../refs/dsh-memory`，姊妹本機 checkout） |
| 檢索管線 | `src/retrieve.mjs`（§4/§7 所引行號） |
| 寫入閘門、溯源 defer | `src/learn.mjs:186/218/221/224` |
| 召回閘門、記錄類型、預設 limit | `src/types.mjs`（`isRecallEligible`、:82） |
| 生命週期動作 | `src/lifecycle.mjs:101–234` |
| 信任分類 | `src/trust.mjs:34/43/95` |
| 上下文＋注入警告 | `src/context.mjs:249/521` |
| 洗滌（redaction） | `src/redact.mjs:45/74` |
| 觀察管線 | `src/observe.mjs:42/82/174` |
| Limit 處理 | `src/config.mjs:26`、`src/retrieve.mjs:952/1014` |
| 圖譜投影 | `src/graph.mjs`（`localGraph`、GRAPH_LIMITS） |
| WebUI | `src/webui.mjs:189/236` |
| 代碼智慧 | `src/code/`（client/engine/discovery/linking/watcher） |
| CI | `.github/workflows/`：`npm test`、`npm run pack:check` |
| SmartTrip 真實儲存庫記錄（2026-09-24 通過 L1–L10；漂移案例） | Veyra 儲存庫 p_2d599165fe7aa1a7：vey_1a0d44d8401、vey_1a0d4545572；SmartTrip 儲存庫 p_6aed36ea45dd7de9 |
| dsh-token-saver onboarding（2026-10-27）＋自動召回噪聲記錄 | 儲存庫 p_0fd9252c3955a1c2（85 條記錄；根因記錄「auto-recall noise … (2026-10)」） |

**修訂脈絡：v0.1.57 @ 75d74ab，撰寫時樹為乾淨狀態。**

---

## 16.## 16. 詞彙表

- **權威階梯（Authority ladder）** — candidate → derived → canonical；
  唯一可自動召回的權威是 derived 與 canonical；正典僅經顯式人類晉級。
- **召回閘門（Recall gate，`isRecallEligible`）** — 記錄可被自動召回
  當且僅當：未遺忘、狀態為 current、非 invalid 或 stale、非 candidate
  或 observation，且 authority 為 derived 或 canonical。
- **RRF** — 詞彙通道與語意通道的互易排名融合（K=60，融合權重 0.06）。
- **證據錨點（Evidence anchor）** — 記錄的依憑：倉庫路徑、備註或 URI；
  倉庫外路徑不能成為證據。
- **信任上下文類別（Trusted-context category）** — §6.2 的五分路讀取時
  分類。
- **DEFER** — 寫入閘門附原因字串的「尚未」裁決
  （`provenance-gated`、`canonical-requires-explicit-promotion`）。
- **墓碑（Tombstone）** — 被遺忘記錄的終局生命週期標記。
- **降級模式（Degraded mode）** — 外部代碼智慧二進位缺席時的運作狀態；
  記憶層不受影響。

---
