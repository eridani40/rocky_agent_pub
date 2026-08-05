# v0.0.120 — AT/ET 测试体系 record/replay 改革方案

> 架构改革方案（只做设计，不写实现）。冻结契约见同目录 `change_plan.md`（method 级）。
> 用户已冻结 12 条设计决策（req.md + task-board），本方案严格遵守，偏离处均已注明。

## 0. 目标与问题

**现状痛点**（`states/v0.0.120.testing/verify/case-remediation-plan.md` D/E 组实证）：
1. **真外部依赖 flaky**（D 组）：Zhipu 429 余额不足、LLM 选错工具/重试风暴、run state=error——不确定性使 AT/ET 无法当稳定回归门禁。
2. **env 语义缺口**（E 组）：`tests/test.env` 写死 `ROCKY_TEST_MOCK_LLM=0` + `set -a; source` 覆盖命令行传参 → 无干净的 per-case mock 切换 → 13 个 computer_use case 永久 SKIP。
3. **mock 不真实**：现有 `mock-llm.ts` 是**剧本脚本**（`mock:text`/`mock:tool`/`@@cu` directive），凭固定文案伪造 SSE，与真实 provider 的 protocol 帧/tool schema/多轮行为脱节，测不到真实链路的回归。

**改革核心**：把「凭空造剧本的 mock」升级为「**录制真实响应 + 确定性回放**」。
- 拦截点 = `llm-client-factory` 的 **fetchImpl 注入口**（决策 1）：协议解析/SSE/tool loop 全链路保持真实，只把「出站 HTTP 响应」换成录制的真实字节。
- 首跑真调 LLM 录制（PASS 才落盘）→ 之后确定性回放，秒级、零 flaky、零 token 消耗。
- 保留「真 LLM smoke 层」（`llm:off`）：PRD 关键路径 + langfuse oracle 类 case 仍真调，守「真实链路没坏」。

## 1. 分层模型（两层 + 一个逃生舱）

| 层 | `llm:` 值 | 何时用 | LLM 流量 | 稳定性 |
|---|---|---|---|---|
| **回放层（默认）** | `replay`（缺省） | 绝大多数业务 case（验业务逻辑，LLM 只是依赖） | 无（吐录制字节） | 确定性、秒级 |
| **录制层（过渡态）** | `record` | 无 recordings 时自动进入 / 显式 `RECORD=1` 重录 | 真调（首跑） | 一次性，PASS 才落盘 |
| **真实 smoke 层（逃生舱）** | `off` | PRD 关键路径 + langfuse oracle + 「验真实效果」类 | 真调（每次） | 慢、可能 flaky（接受） |

**默认层 = replay**（决策 5）。case 不写 `llm` 字段 = replay。
**smoke 层 = off**（决策 5/9）：不 stub 任何东西，langfuse 只在此层真调（决策 9）。

## 2. 组件图

```
                    ┌──────────────────────── server 进程（单实例，跨 case 共用）────────────────────────┐
run_case.sh         │                                                                                    │
  │  ① POST /test/llm-mode {caseId, mode, recordingsDir}  (NODE_ENV=test gate)                           │
  ├────────────────►│  handleTestLlmMode → RecordReplayRegistry.setActiveCase(caseId, mode, dir)         │
  │                 │                                    │ (进程内单例，per-case 覆盖)                     │
  │  ② POST /session/:id/run (真实业务请求)               ▼                                                │
  ├────────────────►│  session-config.buildLlmClient(...) ──► pickFetchImpl(registry, env)               │
  │                 │        chat/agent-loop 全链路真实      │                                             │
  │                 │                                       ├─ mode=replay → ReplayFetch(recordingsDir)   │
  │                 │   LlmClient.stream()/.call()          ├─ mode=record → RecordingFetch(realFetch,dir)│
  │                 │        │ fetchImpl(url, init) ────────┤─ mode=off    → globalThis.fetch（真调）      │
  │                 │        ▼                              └─ (legacy mock:*  → createMockFetch，见 §9)   │
  │                 │   protocol.parseStream / parse（真实解析录制/真实字节）                              │
  │  web_search tool: proxyFetch ──► pickWebFetch(registry) ─ replay/record 同拦截（决策 9）              │
  │                 │                                                                                    │
  │  ③ POST /test/llm-mode {caseId, mode:"off"}  (case 收尾复位，可选)                                    │
  └─────────────────┴────────────────────────────────────────────────────────────────────────────────┘
                              recordings 落盘 / 读取：
                              tests/<kind>/<module>/<case>/recordings/{manifest.json, llm.jsonl, web_search.jsonl}
```

**核心组件**（server 侧，`app/server/src/testing/` 新目录，均 NODE_ENV=test 门禁）：
- **`RecordReplayRegistry`**（进程内单例）：持有「当前 active case → {mode, recordingsDir}」+ per-case 序列游标。`buildLlmClient`/web_search 从它取当前应注入的 fetch。
- **`RecordingFetch`**：包真 fetch，透传出站请求 → 落盘响应（JSON body 或 SSE 帧序列，脱敏）。
- **`ReplayFetch`**：从 recordings 按 session-内-按序匹配吐响应 → 构造 `Response`（含 SSE `ReadableStream`）。
- **`RecordingCodec`**：manifest/jsonl 读写 + 指纹计算 + 脱敏（单一序列化权威）。
- **`handleTestLlmMode`**（test-only HTTP handler）：`POST /test/llm-mode` 设 active case。

## 3. per-case 路由机制（决策 7 — 关键裁决）

**问题**：server 单实例跨 case 共用（bootstrapCache 按 dataDir 缓存），但每个 case 有独立 recordings 目录 + 模式。需要「run_case 告知 server：当前跑的是哪个 case、什么模式、recordings 在哪」。

**裁决：test-only HTTP 端点 `POST /test/llm-mode`**（而非 header）。理由：
- **header 方案的致命缺陷**：SSE、agent loop 的出站 LLM 请求由 server 内部发起（不携带原始测试请求的 header），header 无法穿透到 `fetchImpl` 层。`/session/:id/run` 之后 server 异步跑多轮 tool loop，每轮 LLM 调用都要命中正确 recordings——header 只在入站请求上，传不到内部循环。
- **端点方案**：run_case 在跑 case 前先 `POST /test/llm-mode` 把 active case 状态写进 `RecordReplayRegistry` 单例；之后该 case 的所有内部 LLM/web_search 出站请求都从单例读当前 case 上下文。状态是「进程内 sticky」，覆盖到整个 case 生命周期（含异步 tool loop）。
- **串行保证**：AT/ET run_all 的 record/replay case 走 `serial` lane（决策 12 不破坏现有 concurrency；record/replay case 标 `concurrency:serial`，见 §7），单例 active case 无并发竞争。多 session 并发 case（squad）是**单个 case 内**多 session，靠 session 分道（§5），不是多 case 并发。

**门禁（决策 7 硬约束）**：
- router 层 `if (process.env.NODE_ENV !== 'test') return 404`（对齐现有 `/session/:id/run`、`/api/workspace/*` gate 模式，router.ts:393/416）。
- handler 内二次 gate（防绕过直接调，对齐 `session-run.ts:117`）。
- `RecordReplayRegistry` 仅在 `APP_ENV=test || NODE_ENV=test` 时由 bootstrap 实例化；非 test 环境 `pickFetchImpl` 直接返 `undefined`（走真 fetch，零测试代码进 prod 路径）。

**端点契约**：
```
POST /test/llm-mode   (NODE_ENV=test only, else 404)
body: { caseId: string, mode: "replay"|"record"|"off", recordingsDir: string }
→ 200 { ok: true, caseId, mode }
```
`recordingsDir` = 绝对路径（run_case 用 `$CASE_DIR/recordings` 展开后传，避免 server cwd 差异，对齐护栏 §4 路径展开）。

## 4. 数据格式（决策 2）

**位置**：`tests/<kind>/<module>/<case>/recordings/`（`<kind>` ∈ api/e2e，按 case 归属；随 case 入 git）。

### 4.1 `manifest.json`（case 级元信息 + 指纹基线）
```jsonc
{
  "case_id": "chat_basic_reply_tc1",
  "recorded_at": "2026-07-11T21:30:00Z",
  "provider": "unknown",          // manifest 顶层 provider/model 恒为 "unknown"（见下注）
  "model": "unknown",             // ← 顶层是占位；行级 request_meta.model 才是真实值
  "llm_calls": 3,                 // llm.jsonl 行数
  "web_search_calls": 1,          // web_search.jsonl 行数（无则 0/字段省略）
  "fingerprint": {                 // 漂移检测基线（§6）——录制时算，回放时比对
    "system_prompt_hash": "sha256:ab12…",   // 首个 LLM 调用的 system prompt SHA-256（前 16 hex）
    "tools_schema_hash": "sha256:cd34…",    // tools schema 规范化后 SHA-256
    "model": "MiniMax-M3"
  }
}
```

> **[实现现状注 — provider/model 顶层为 'unknown']**：`RecordReplayRegistry.commitIfPassed()`（`record-replay-registry.ts` L152-164）flush 时写 manifest，顶层 `provider`/`model` 恒填字面 `'unknown'`——registry 不持有 providerConfig（fetchImpl 注入口只见 url+init，拿不到 provider 元信息）。**真实值在行级**：`llm.jsonl` 每行 `request_meta.model` 由 `recording-fetch.ts::extractRequestMeta()` 从出站 body 的 `model` 字段抽取（真实 modelId）。回放/漂移不依赖 manifest 顶层 provider/model，只用行级 fingerprint + request_meta，故顶层占位无害。若后续需 manifest 顶层真实 provider（如人读诊断），须让 registry 携带 provider 元信息进 als 上下文（记 tech KB 已知债）。

### 4.2 `llm.jsonl`（每行一次 LLM 调用）
```jsonc
// 非流式（client.call，如 compact）
{"seq":0,"session_hint":"s1","fingerprint":{"system_prompt_hash":"…","tools_schema_hash":"…","model":"MiniMax-M3"},
 "request_meta":{"stream":false,"model":"MiniMax-M3","message_count":4},
 "response":{"kind":"json","status":200,"body":{...anthropic message json...}}}
// 流式（client.stream，chat/agent loop 主路）
{"seq":1,"session_hint":"s1","fingerprint":{...},
 "request_meta":{"stream":true,"model":"MiniMax-M3","message_count":6},
 "response":{"kind":"sse","status":200,"sse_frames":["event: message_start\ndata: {…}\n\n", "event: content_block_start\n…\n\n", …]}}
```
- **两种响应形态**（决策 2 硬要求）：`response.kind` = `json`（非流式，`body` 存解析后 JSON 对象）| `sse`（流式，`sse_frames[]` 存**原始帧文本**，逐帧含结尾 `\n\n`；ReplayFetch 拼回 ReadableStream 逐帧吐，protocol.parseStream 真实解析）。
- **error 响应**：`response.status` 非 2xx（如 500 + `sse_frames` 含 anthropic error event / `body` 含 error json）——录制真实错误响应，回放时 `LlmClient` 走 `buildHttpErrorFromResponse` 真实分类链路。
- `session_hint` = 出站请求所属 session 的标识（§5 多 session 分道用）。
- `seq` = 该 session 内的调用序号（0-based，按序回放游标）。
- `request_meta` = **非敏感**请求指纹（stream/model/message_count），供调试比对，**不含 messages 正文、不含 credentials/Authorization**（决策 11 安全）。

### 4.3 `web_search.jsonl`（决策 9，web_search 纳入同拦截）
```jsonc
{"seq":0,"session_hint":"s1","provider":"zhipu","request_meta":{"query_hash":"sha256:…","count":5},
 "response":{"kind":"json","status":200,"body":{...zhipu/jina response json...}}}
```
- Zhipu（`ZHIPU_URL` POST）与 Jina（`JINA_BASE` GET）出站响应同格式录制；`query_hash` = query 文本 hash（不存明文，减少无关漂移噪音，也避免存潜在敏感 query）。
- 回放按 session-内-按序（与 llm 同策略）。

> **[实现现状注 — record 模式 web_search 绕过 proxyFetch，仅测试期]**：`RecordReplayRegistry.pickWebFetch()` record 分支返回的 `RecordingFetch` 包的是 **`globalThis.fetch`**（`record-replay-registry.ts` L248-253），而**非** `proxyFetch`。即录制期 web_search 出站走裸 `globalThis.fetch`，绕过了 `web-fetch/proxy.ts` 的 EnvHttpProxyAgent/DNS-pin/SSRF 防护（`jina-fetcher.ts` L88-90、`zhipu-provider.ts` L129-131 的 `pickWebFetch(getRegistry()) ?? proxyFetch` 接线：命中 record → 用 RecordingFetch，未命中 → 走 proxyFetch）。**仅在 `NODE_ENV=test` 录制态生效**（registry 非 test 返 null → pickWebFetch 返 undefined → 恒走 proxyFetch）；**prod 完全不受影响**。回放态同理走 `ReplayFetch`（不出网，SSRF 无关）。若需录制期也保留 proxy 防护，须让 RecordingFetch 包 proxyFetch 而非 globalThis.fetch（当前取舍：录制只求拿到真实响应字节，防护非录制关注点）。

### 4.4.0 flush 时序（实现现状 — 同步落盘，无需固定 sleep）
`commitIfPassed(true)` → `recording-codec.ts::flushRecordings()` 用 **`writeFileSync`**（同步）把内存 buffer 一次性写 `manifest.json`/`llm.jsonl`/`web_search.jsonl`（L54/81/86）。`POST /test/llm-mode/commit` handler 在 `writeFileSync` 返回后才回 200 → **run_case 收到 commit 200 时录制已确定落盘**。因此 rr case 在 commit 后**无需固定 `sleep` 等 flush**（同步写已保证）。项目惯例：需等异步产物用 bounded poll（如 langfuse `langfuse_wait_for_trace`），禁固定 sleep；录制 flush 是同步的，连 poll 都不需要。若个别 case 仍留 `sleep 0.5` 是其他用途（SSE 帧 flush/后台 curl），非等录制落盘。

### 4.4 脱敏（决策 11 — 硬约束）
`RecordingCodec.redact()` 在**落盘前**执行，永不写入：
- 请求侧：`Authorization` header、`credentials.key`、任何 `x-api-key`/`api_key`/token 字段。
- 只落**响应侧 body/帧** + **非敏感请求指纹**（hash + 计数 + model + stream）。
- 录制的 response body 里若厂商回显了敏感字段（罕见），`redact()` 按 key 名白名单剔除。
- reviewer 校验点：`grep -riE 'authorization|api.?key|sk-|credential' recordings/` 应为空（除非是响应正文合法内容）。

## 5. 匹配策略（决策 4 — session 内按序回放）

**不匹配动态请求体**（决策 4）。回放纯按「session + 序号」定位，因为同一 case 回放时业务流程确定 → LLM 调用序列稳定。

**算法**：
1. `ReplayFetch` 构造时读 `llm.jsonl` → 按 `session_hint` 分组 → 各组按 `seq` 升序 → 得 `Map<session_hint, Recording[]>` + 各 session 独立游标。
2. 每次出站 LLM 请求：
   - 解析请求得 `session_hint`（§5.1 如何取）。
   - 取该 session 游标当前项 → 返其 response → 游标 +1。
   - 游标越界（录制条数 < 回放请求数）→ 结果类 `recording_drift`（§6），提示重录。
3. **多 session 并发 case（squad/multi_agent）**：各 session 独立游标，天然分道排序（决策 4）。并发出站请求各命中自己 session 的序列，互不干扰。

### 5.1 session_hint 获取（关键实现点 — coder 定位）
出站 LLM 请求本身不带 session id（fetchImpl 只见 url + init）。方案：**`RecordReplayRegistry` 提供 AsyncLocalStorage 上下文**，agent loop 发起 LLM 调用前 `als.run({sessionHint}, () => client.stream(...))`，`RecordingFetch`/`ReplayFetch` 从 als 读当前 session_hint。
- **fallback**（als 拿不到，如 chat 无 session 路径）：单一默认 session `"_default"`，退化为「全 case 单序列按序」——单 session case 无需 als，直接可用。
- session_hint 值 = 稳定标识（session id 的稳定派生，如 run 内序号 `s1/s2`），**不用原始 ULID**（每次跑 ULID 不同，会破坏回放匹配）。coder 定位：录制时把「首次见到的 session → 分配 s1/s2…」映射存进 registry，回放时同规则复现。

> **coder 决策权**：§5.1 的 als 接线细节 + session_hint 派生规则是标注的开放实现点，coder 可择优（als vs 显式参数透传）；但「session 内按序、多 session 分道、不匹配请求体」是决策 4 核心约束，不可偏离。

## 6. 指纹漂移检测（决策 4）

**目的**：录制数据是「针对某版 system prompt + tools schema」录的；若之后改了 prompt/工具定义，旧 recordings 语义已过期，回放会「用旧响应喂新请求」→ 假绿。漂移检测在回放时发现这种过期，提示重录。

**算法**：
1. 录制时：首个 LLM 调用算 `system_prompt_hash`（system prompt 文本 SHA-256）+ `tools_schema_hash`（tools 数组规范化 JSON 的 SHA-256）+ `model`，存 manifest.fingerprint + 每行 fingerprint。
2. 回放时：对每次出站请求，实时算当前 `system_prompt_hash`/`tools_schema_hash`/`model`，与该 seq 录制的 fingerprint 比对。
3. **不一致** → 不判 pass/fail，而是专门结果类 **`recording_drift`**（≠ 普通 fail，决策 4）。

**drift 接缝契约（实现现状 — 关键链路，orchestrator 裁决 v0.0.120 实现）**：出站请求由 server 内部异步发起（agent loop tool loop），ReplayFetch 抛的错**回不到** run_case 脚本（脚本只见 `/session/:id/run` 的 HTTP 响应，run 可能因内部 drift 而 error/异常，但脚本拿不到 `RecordingDriftError` 本体）。因此走**回调收集 + commit 端点回传**的接缝，而非 try/catch：

```
ReplayFetch (replay-fetch.ts::throwDrift)
  → onDrift 回调（构造时由 registry 注入，避免 import registry 环形依赖）
  → RecordReplayRegistry.recordDriftEvent() 累积到 driftEvents[]（record-replay-registry.ts L104-107）
  → [继续] throw RecordingDriftError（run 内部失败，但游标+driftEvents 已记）
  ↓ case 跑完
run_case → POST /test/llm-mode/commit
  → handleTestCommit 在 commitIfPassed 前先读 getDriftEvents()（test-llm-mode-handler.ts L169-171）
  → 响应体带 drift:{detected:boolean, events:DriftEvent[]}（L177/206）
  ↓
tests/lib/llm_mode.sh::llm_mode_commit
  → 解析响应 drift.detected；若 detected 且 last_run.result==pass
  → 改写 last_run.json → {result:"recording_drift", desc:"..."}（llm_mode.sh L104-126）
  → drift 改写优先于 golden（漂移时 golden 比对无意义，server 侧已跳过 golden 比对）
```

- 漂移维度（`RecordingDriftError.dimension`）：`model` / `system_prompt_hash` / `tools_schema_hash` / `sequence_overflow`（游标越界，录制条数 < 回放请求数）。
- run_all 聚合新增 `recording_drift` 分类（决策 12），提示「该 case 需重录」，**不算功能 fail**（不阻塞其他 case、不翻 overall，orchestrator 据此触发重录 `RECORD=1 CASES=xxx`）。
- **接缝缺口教训（T1/T3）**：原文只写「handler/run_case 捕获」，未指明 ReplayFetch 错回不到脚本 → 必须走 driftEvents 回调 + commit 回传。缺此实现细节导致 T1（registry 侧 driftEvents 累积）与 T3（脚本侧 commit 改写）接缝对不齐。
4. **规范化**（避免假漂移）：tools schema 排序 key + 去除运行时无关字段（如注入的动态时间戳）后再 hash。coder 定位规范化细节；约束：规范化必须**确定性**（同输入同 hash）。

## 7. 生命周期状态机（决策 6）

```
                 ┌─ recordings 缺失 ──────────► [record 模式] ─真调LLM─► case 跑
   run case      │                                                        │
   (llm=replay   │                                                   PASS ─┴─► 落盘 recordings ► 下次 replay
    缺省)   ─────┤                                                   FAIL ────► 不落盘（保持缺失，下次仍 record）
                 │
                 ├─ recordings 存在 ──────────► [replay 模式] ─吐录制─► case 跑 ─► pass/fail/recording_drift
                 │
   RECORD=1 /    └─ 强制重录 ─────────────────► [record 模式] ─真调─► PASS ─► 覆盖旧 recordings（决策 3）
   CASES=+RECORD                                                    FAIL ─► 保留旧 recordings（不破坏已有回放基线）

   llm=off ──────────────────────────────────► [off 模式] ─每次真调─► 不读不写 recordings（smoke 层）
```

**规则**（决策 3/6）：
- **自动录制**：`llm:replay`（缺省）+ recordings 缺失 → run_case 自动切 record（真 LLM）；case PASS 才落盘（PASS 判定 = runner/custom.sh 的 last_run.result==pass）。
- **强制重录**：`RECORD=1`（全量重录）或 `CASES=<id> RECORD=1`（重录指定 case）→ 覆盖该 case 旧 recordings（决策 3，直接覆盖不备份）。record PASS 才覆盖；FAIL 保留旧（不破坏已有基线）。
- **回放**：recordings 存在且非 RECORD → replay。
- **off**：`llm:off` → 恒真调，不碰 recordings。

**PASS-才落盘 的实现（现状）**：record 模式下 `RecordingFetch` 先写**内存 buffer**（`recording-codec.ts` 模块级 `_buffer`），case 跑完 run_case 显式 `POST /test/llm-mode/commit {passed}` 触发 → `commitIfPassed(passed)`：pass 则 `flushRecordings` 落盘（同步 writeFileSync），非 pass 则 `clearBuffer` 丢弃。约束：**FAIL 绝不落盘**。

**重复 commit 边界（现状 — 双层守卫）**：`commitIfPassed` 收尾把 `this.activeCase = null`（`record-replay-registry.ts` L149/170）——第二次 commit 命中 `if (!this.activeCase) return` 早退，不双写。另 handler 层有 **caseId mismatch 守卫**（`test-llm-mode-handler.ts` L153-163）：`active.caseId !== body.caseId` → no-op + warn + 返 `{mismatch:true, flushed:false}`，防并发下一个 case 的 setActiveCase 已覆盖 active 时，上一个 case 的迟到 commit 写错 recordingsDir。serial lane 约束下（§7）单槽无并发，两守卫是防御性纵深，非当前真实触发路径。

## 8. env 优先级修复（决策 10 — 关键裁决）

**Bug 根因**（实证 tests/test.env:28 + env_start.sh:18/86）：
```bash
set -a; source "$TESTS_DIR/test.env"; set +a   # test.env 里 ROCKY_TEST_MOCK_LLM=0 → 无条件写进 shell
...
ROCKY_TEST_MOCK_LLM="${ROCKY_TEST_MOCK_LLM:-1}"  # 已被 source 设为 0，:-1 永不生效
```
命令行 `ROCKY_TEST_MOCK_LLM=1 bash env_start.sh` → `source test.env` 把它**覆写回 0** → 命令行传参被静默吞掉。这是「source 覆盖命令行传参」的双 env 语义并存 bug。

**裁决：显式环境变量/参数 > test.env 文件默认**（决策 10）。实现方式 = **source test.env 时不覆盖调用方已显式设的变量**：
```bash
# 修复：先捕获调用方显式传入的 override（source 前），source 后再恢复
# 方案 A（推荐，最小改动）：把 test.env 里的 KEY=val 改成 KEY="${KEY:-val}" 形态（默认语义）
#   → source 时若 shell 已有 KEY（命令行传入）则保留，否则用文件默认。
# test.env: ROCKY_TEST_MOCK_LLM="${ROCKY_TEST_MOCK_LLM:-0}"  ← 从 =0 改成 :-0
```
- **方案 A（裁决采用）**：把 `tests/test.env` 中**所有会被命令行 override 的键**改成 `KEY="${KEY:-default}"` 形态（默认值语义）。`set -a; source` 后，命令行显式传入的值保留，未传的用文件默认。改动集中在一个文件、语义清晰、无需改 env_start 的 source 逻辑。
- 受影响键（至少）：`ROCKY_TEST_MOCK_LLM`。其余纯 schema 键（provider id/端口）保持 `KEY=val`（不需 override）。
- **消除双 env 语义**：`ROCKY_TEST_MOCK_LLM` 保留作「server 全局启动模式」的粗开关（AT 默认 mock、ET 默认 real），但**per-case 精细控制改由 `llm:` 字段 + `/test/llm-mode` 端点驱动**（§9 迁移）。命令行 override 现在能穿透。

## 9. legacy mock 机制的去留（决策 10 裁决）

**现状**：两套并存——(a) `createMockFetch`（`mock:*` model 剧本 + `@@cu` directive）；(b) 新 record/replay。用户要求裁决保留/并入，约束「13 个 computer_use case 不能回退」。

**裁决：分阶段——本版本保留 legacy，新增 record/replay 与之并行；computer_use 暂留 legacy `@@cu` 路径**。
- **理由**：computer_use 的 13 case 靠 `@@cu:<json>@@` directive 让 mock LLM 出确定的 `computer` tool_call + `ROCKY_TEST_COMPUTER_NATIVE_PORT=mock` 驱动本地 mock port——这套是「**确定性驱动 tool 参数**」，不是「回放真实 LLM 响应」。它们本质是 mock 而非 replay（computer OS 能力无法真录）。强行迁 record/replay 无收益且高风险（违反「不能回退」约束）。
- **本版本**：computer_use case 的 `llm` 字段设为 `mock`（新增枚举值，见下），run_case 见 `mock` → 走 legacy `createMockFetch`（server 该 case ROCKY_TEST_MOCK_LLM=1）。**修掉 SKIP**：靠决策 10 的 env 优先级修复 + `llm:mock` per-case 声明，让 computer_use 在标准跑里能干净切 mock（不再永久 SKIP）。
- **`llm` 字段枚举**（本版本）：`replay`（默认）| `record` | `off` | `mock`（legacy 剧本，仅 computer_use 等 OS-mock 类用）。
- **未来**（本版本不做，注明）：`mock:text/tool/compact/error` 剧本类 case 可逐步迁 record/replay（录真实响应替代手写剧本），directive-mock（@@cu）长期保留。

> **与旧 `llm_mode` 字段的关系**：现有 checkpoint 用 `llm_mode: none|real|any|mock`（82+62+24+14 个）。新 `llm` 字段是**正交新增**（控 record/replay 拦截），`llm_mode` 保留（控 server mock-gate skip）。**coder 定位**：是否把二者合并/映射（如 `llm_mode:real` ≈ `llm:replay`、`llm_mode:mock` ≈ `llm:mock`）——建议本版本**新增 `llm` 字段、不动 `llm_mode`**（渐进，减少存量 144 case 改动面），迁移波次（§11）再逐步统一。约束：computer_use 13 case 从 SKIP 变实跑。

## 10. 迁移策略（本版本内全量录制 — 交付物）

**升级（追加裁决 1）**：全量录制是**本版本交付物**，不推迟到后续版本。除 `llm:off` 白名单外，**所有出站依赖 LLM/web_search 的 case 都在本版本内录制落盘 tests/**。波次仍可分批**执行**（避免一次跑爆真 LLM），但**全部波次都在本版本收口**——验收前所有非 off case 都有 recordings 且回放通过。

**存量 ~62 个 `llm_mode:real` case + D 组 flaky case** 是录制主力（业务 case，验逻辑不验真实效果 → 转 replay）。

**批量驱动**：靠 `RECORD_BATCH.sh`（新增脚本，change_plan E 组）分波驱动 `RECORD=1 CASES=<批> run_all.sh`——按 module/lane 切批、串行录制、汇总落盘结果、失败 case 单列重试清单。避免手动逐 case 敲命令。

**波次（本版本内全部收口，验证阶段执行）**：
- **波次 0（基建验证）**：2-3 代表 case（chat 纯文本、tool loop、compact 非流式）`RECORD=1` → 回放通过 → 证明基建可用。
- **波次 1（存量 real 业务 case 主体）**：`RECORD_BATCH.sh` 批量录制 → 落盘 → 转 `llm:replay`（缺省）。D 组 flaky（web_search zhipu、presence_tool、skill_agent_read、workitem_* 等）此波次录制后 flaky 消失。
- **波次 2（多 session/squad case）**：验 §5 多 session 分道后录制。
- **保留 off（不录制）**：PRD 关键用户路径 smoke（至少 1 条真实 chat + 1 条 tool loop）+ langfuse oracle case → `llm:off`，守「真实链路没坏」。**off 白名单是全量录制的唯一豁免集**，由 test-plan 明确列全。

**收口验收口径**：验证阶段跑一次全库 → 每个非 off case 要么 recordings 存在且 replay pass，要么在 off 白名单内。无「既非 off 又无 recordings」的 case（否则每跑真调 LLM，违背本裁决）。

**防腐**（case-remediation-plan A 组机制）：change_plan 涉及改 system prompt/tools schema → 触发对应 case `recording_drift` → 提示重录（§6 天然覆盖 A 组「契约漂移」防腐的一部分）。

## 11. 风险与边界

| 风险 | 影响 | 缓解 |
|---|---|---|
| session_hint 派生不稳（§5.1） | 多 session case 回放错乱 | 波次 2 专项验证；单 session case 用 `_default` 兜底不受影响 |
| 录制期真 LLM 非确定（同 prompt 每次响应不同） | 录制的是「某一次」响应，回放固定它 | 接受——回放验的是「给定这个 LLM 响应，业务链路对不对」，非验 LLM 本身；验 LLM 走 off 层 |
| 指纹规范化不彻底 → 假漂移 | case 频繁 recording_drift 误报 | §6 规范化确定性；drift 不阻塞（只提示重录），orchestrator 裁决 |
| recordings 体积膨胀入 git | 仓库变大 | jsonl 精简（不存 request messages 正文）；每 case 通常 <10 调用 |
| tool loop 内 LLM 调用数因代码改动变化 | 游标越界 → drift | drift 机制捕获，提示重录，符合设计（代码变了本就该重录） |
| als 上下文在 Bun 下行为 | session_hint 传递 | coder 验证 Bun AsyncLocalStorage 可用；不可用则退显式参数透传（§5.1 fallback） |
| off 层仍 flaky（真 LLM） | smoke case 偶发 fail | 限定 off 层 case 数（PRD 关键路径 only）；沿用现有 USE_FALLBACK 重试 |
| **golden 剔除不足 → 动态值泄漏** | 假 golden fail（漏剔 ULID/timestamp） | §16 规范化占位符替换全覆盖；reviewer 校验无动态值泄漏 |
| **golden 过度剔除 → 空壳** | golden 失去断言价值（什么都不比） | §16 核心断言留 tool_call 序列 + 拓扑 + stopReason；reviewer 校验非空壳 |
| runner.py 拆分改动面 | 存量声明式 case 回归 | `_steps.py` 抽取保持行为等价；波次 0 前先跑全库现状基线对比 |
| 全量录制真调 LLM 耗时/rate-limit | 录制波次跑很久/429 | RECORD_BATCH 分批 + USE_FALLBACK 重试 + 串行 lane；分波执行不必一次跑完 |
| case 精简误删有效覆盖 | 覆盖矩阵破洞 | §17 保护线 + orchestrator 核对覆盖矩阵后才执行删除 |

**边界（本方案不含）**：
- 不改 protocol 解析 / SSE / tool loop（决策 1：全链路真实）。
- 不 stub ET 的 API/SSE（决策 8：ET = 真后端 + 后端内 LLM 回放）。
- 不动 vision_check/compare（ET vision 能力保留，决策外）。
- 不重写 mock-llm.ts 的 computer directive 路径（§9 保留）。

## 12. 单文件 ≤300 行拆分规划

`app/server/src/testing/` 新目录，按职责拆分（每文件预估 <250 行）：
- `record-replay-registry.ts`（单例 + active case 状态 + als 上下文 + `pickFetchImpl`/`pickWebFetch`）~180 行
- `recording-fetch.ts`（RecordingFetch：透传真 fetch + buffer 落盘）~150 行
- `replay-fetch.ts`（ReplayFetch：按序回放 + 构造 Response/SSE stream + drift 抛错）~200 行
- `recording-codec.ts`（manifest/jsonl 读写 + 指纹 + 脱敏）~220 行
- `golden-recorder.ts`（record 模式产出 golden.json + replay 结构比对，§16）~200 行
- `test-llm-mode-handler.ts`（`POST /test/llm-mode` + `/commit` handler，test gate）~90 行
- `types.ts`（Recording/Manifest/Mode/Golden 等 interface）~110 行

`llm-client-factory.ts` 只加接线（调 `pickFetchImpl`），不膨胀。

**runner.py 拆分（关键——现有已超限）**：`tests/api/lib/runner.py` **现 367 行已超 300**（引入 steps DSL 扩展只会更长）。拆分：
- `tests/api/lib/_steps.py`（新增，~200 行）：steps DSL 引擎——`resolve`/`resolve_value`/`resolve_body`/`get_json_path`/`check_value`/`do_request`/`do_file_check` + **新增 step 类型 `run`/`save`**（§15）。
- `tests/api/lib/runner.py`（瘦身到 ~120 行）：只留 `main()` 编排（读 checkpoint → 循环调 `_steps` → 写 last_run + golden 比对钩子）。
- e2e `tests/e2e/lib/runner.py` 现状不在本裁决拆分范围（steps DSL 主要服务 AT 八股场景；ET 走 Playwright action 序列，已有独立 DSL）。若 golden 比对钩子加入使其超限，同法抽 `_e2e_steps.py`（coder 定位）。

> **[本版豁免 — ET runner 拆分]**：`tests/e2e/lib/runner.py` 现 **573 行 > 300**，本版本**明示豁免**拆分（已知债，记 tech testing KB `log.md`）。理由：ET runner 是 Playwright action 序列执行器（自有 DSL），本版核心改动是 AT record/replay + AT runner 拆 `_steps.py`；ET 只接 llm-mode 路由块（走共享 `tests/lib/llm_mode.sh`），未新增 ET 专属 DSL 逻辑。强拆 ET runner 改动面大、回归风险高、与本版目标正交。后续版本按 §12 同法抽 `_e2e_steps.py`（steps/vision/compare/dom_assert 分段）。

## 14. 追加裁决 2.1 — 单一权威文件（checkpoint 唯一手写）

**目标**：case 只手写 `checkpoint.json`，`test_case.md` 不再手写。
- `test_case.md` 改为**脚本自动生成**：`tests/lib/gen_case_md.sh`（新增）从 checkpoint 渲染人类可读文档（case_id / description / steps 摘要 / checks 列表 / references / prd_path）。生成时机：designer 写完/改完 checkpoint 后跑一次（或 run_all 前批量再生）。
- `references` / `prd_path` **降为可选字段**（缺省不阻塞）；gen_case_md 有则渲染、无则省略段落。
- **不删存量 test_case.md**：本裁决只改「新 case 不手写、由脚本生成」+ 提供批量再生工具；存量 md 是否清理由 designer 定（生成脚本可覆盖再生，保持一致）。

## 15. 追加裁决 2.2 — 声明式 steps DSL + 共享 helper 库

**现状**：AT runner.py **已有 steps DSL**（`checkpoint.steps[]`：`{id,description,request:{method,url,body,headers},expect:{status,checks}}` + 跨 step `{stepN.path}` 引用 + `save` 语义靠 `{stepN.field}` 隐式）。缺口 = 缺高层八股封装（建 session→run→查 messages→断言每次都手写 4-5 个 step）。

**扩展（进 `_steps.py`）**：
1. **新增 step 类型 `run`**：`{id, run:{content, providerId?, modelId?}, expect}` → 内部 `POST /session/:id/run`（复用 test-only 同步端点），把返回的 `messages`/`state`/`stopReason` 存进 ctx（供后续 step `{stepN.messages[0]...}` 引用）。消除手写 run + poll。session id 从前序 `save` 或显式 `sessionId` 字段取。
2. **`save` 简写**：step 加 `save:{varName: "path"}` → 把响应字段存命名变量（`{var.varName}` 引用），比 `{step3.data.id}` 可读。向后兼容——`{stepN.path}` 继续可用。
3. **`create_session` 简写 step**：`{id, create_session:{title?, providerId?, modelId?}, save:{sid:".id"}}` → `POST /session` + 存 sid。
4. `custom.sh` **只留真命令式流程**（SSE 事件序列监听、langfuse oracle bounded poll、多分支逻辑）；八股场景全转声明式 steps。

**共享 helper 库 `tests/api/lib/_case_lib.sh`**（新增，泛化 computer_use `_cu_lib.sh` 的成熟模式）：
- `rr_init` / `rr_fail` / `rr_skip`（对齐 `cu_init`/`cu_fail`/`cu_skip`，写 last_run.json）。
- `rr_new_session <title>`（对齐 `cu_new_session`：POST /session + 存 SID + trap cleanup）。
- `rr_run <content>`（对齐 `cu_run`：POST /session/:id/run 同步 + 存 RUN_STATUS + 落 resp-messages.json）。
- `rr_assert_msg` / `rr_assert_tool`（transcript 结构断言 helper，命令式 case 复用）。
- **定位**：`_cu_lib.sh` 保留（computer_use 专用 fixture 逻辑），`_case_lib.sh` 为通用父集；coder 判断是否让 `_cu_lib.sh` 复用 `_case_lib.sh` 的 rr_new_session/rr_run（减重复）——约束：不回退 computer_use 13 case。

## 16. 追加裁决 2.3 — golden transcript（录制即断言 + 结构匹配）

**机制**：record 模式除录 LLM 响应外，**同时把最终 transcript 结构基线存 `recordings/golden.json`**；replay 时 runner 自动比对结构一致性。
- **产出（record 时）**：case 跑完（PASS），`golden-recorder` 从 `GET /session/:id/messages`（或 run 返回的 messages）提取**结构骨架**存 golden.json：`tool_call` 名称序列、每个 message 的 role、终态 `stopReason`/`state`、关键结构字段（tool_call.arguments 的 key 集合、tool_result 数量与绑定关系）。
- **断言（replay 时）**：`golden-recorder.compare(actual, golden)` 做**结构匹配非全文匹配**（§下「结构匹配算法」）。结果并入 last_run（golden fail 记为普通 fail，因回放确定性下结构应稳定）。
- **生命周期**：与指纹漂移同一周期——`RECORD=1` 重录时 golden.json 一并覆盖更新（决策 3 覆盖语义）。
- **退出机制**：checkpoint 声明 `golden: "off"` → 该 case 不产出/不比对 golden（如结构本身非确定的 case）。缺省 `golden: "on"`（对 replay case 生效；off/record 模式不比对）。

### 结构匹配算法 + 动态值剔除（新风险重点）
golden 存**规范化结构**，比对前对 actual 同规范化，再深比对：
1. **保留（结构骨架）**：message role 序列、tool_call `name` 序列（**有序**，tool loop 顺序是行为契约）、每 tool_call 的 `arguments` **key 集合**（不比 value）、tool_result **数量** + `toolCallId` 绑定拓扑、最终 `stopReason`/`state`。
2. **剔除（动态值）**：所有 ULID（message id / toolCallId / runId / sessionId → 规范化为占位符 `<id>`，只保留绑定拓扑）、时间戳、usage token 数（每次略有浮动）、cost、文本正文（text block 的 `text` 只留「非空/空」布尔，不比字面——LLM 文案回放虽固定但避免脆性，也兼容未来微调 prompt 后文案变而结构不变）、tool_result 正文（只留存在性 + 绑定）。
3. **规范化 tool_call.arguments**：只比 key 集合 + 类型，不比具体 value（如 `element_index:3` 的 3 不比——回放虽固定，但结构断言不该依赖具体坐标；要验具体值走 checkpoint 显式 check）。
4. **深比对**：规范化后两结构做递归 deep-equal，**首个差异点**报出（`golden drift at tool_calls[1].name: expected 'bash' got 'computer'`）。
5. **确定性保证**：规范化函数纯函数、有序遍历、占位符替换确定——同 transcript 同规范化结果（否则假 golden fail）。

> **风险**：过度剔除 → golden 变空壳（什么都不比，失去断言价值）；剔除不足 → 动态值泄漏致假 fail（如漏剔某个 ULID）。平衡点 = **剔一切每次跑会变的、留一切代码正确性决定的**。tool_call 名称序列 + 拓扑是核心断言价值；文本正文剔除是脆性防御。coder 定位剔除清单，reviewer 校验「golden 非空壳 + 无动态值泄漏」。

## 17. 追加裁决 3 — case 库精简策略（准则，清单由 designer 定）

**目标**：全库从现 182 → ~120-140 个。**精简先于录制**（录得少维护得少——先删再录，不给废 case 录 recordings）。

**判断准则**（具体哪些模块合并/删由 designer 在测试计划阶段产出清单，本节只定准则）：
1. **同接口琐碎 CRUD 合并**：同一 endpoint 的多个只差参数的 CRUD case（create/get/update/delete 各一）→ 合并成一个多 step case（一条 case 内建→查→改→删→验）。
2. **低价值/重叠删除**：断言重叠（A case 的断言是 B case 的子集）、覆盖同一路径无新增覆盖价值的 → 删冗余那个。
3. **修不如删**：腐烂（契约漂移）且价值低、修复成本 > 重建价值的 case → 直接删（对齐 memory `test-case-user-principles`「fail 三分处置」的删档）。
4. **保护线**：PRD 关键用户路径 case、off smoke 白名单、每个 endpoint 至少一个 happy-path + 一个错误路径 → 不删。
5. **精简不减覆盖**：合并/删除后，`specs/api` 每个 endpoint 仍有 case、PRD 每条路径仍有 case（覆盖矩阵不破洞）。

**执行**：精简清单由 designer 产出并经 orchestrator 核对覆盖矩阵后执行；精简 → 录制 → 回放验证的顺序在验证阶段收口。

## 18. specs/api 更新

新增 test-only 端点文档：`specs/api/overall/` 新增或在既有 test-only 端点章节追加 `POST /test/llm-mode`（标注 NODE_ENV=test gate、非 test 404、record/replay 路由用途、绝不进 prod surface）。详见 change_plan「specs/api」行。
