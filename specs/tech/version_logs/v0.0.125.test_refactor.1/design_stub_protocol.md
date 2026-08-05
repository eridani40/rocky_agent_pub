# 桩控制协议 + 多桩点 registry 泛化

> 归属：`design.md §0` 目录页拆分文件。定义 `/test/stub` 系列端点 schema、registry 从单桩点泛化为 {llm, web_search, web_fetch} 多桩点、step 边界通知、stub 标记核对的实现。
> 现状基线：`app/server/src/testing/record-replay-registry.ts`（单例 + 单 `pickFetch` + 单 seq/buffer）；泛化后 server 侧只动 `app/server/src/testing/` + 路由挂载，业务代码零改动。

## 1. 多桩点通道模型

**现状**：`RecordReplayRegistry` 有一个 `recordSeqMap`（session→seq）、codec 有一个 `llmBuffer`+`webSearchBuffer`，但 `pickFetch()` 对 llm 和 web_search **共用同一函数**（共享 sessionHint 派生的同一 seq 序列）。web_fetch 走 `pickWebFetch` 也共用 `pickFetch`。

**v2 泛化**：引入**桩点通道（StubChannel）**概念。三个桩点 `llm` / `web_search` / `web_fetch` 各持一个独立通道，通道内含：

| 通道内状态 | record 用 | replay 用 |
|---|---|---|
| `seqMap: Map<sessionHint, number>` | 记帧序号（每通道独立从 0） | — |
| `buffer: Recording[]` | 内存暂存帧（PASS 才 flush） | — |
| `cursorMap: Map<sessionHint, number>` | — | 回放游标（每通道独立） |
| `replaySet: Map<sessionHint, Recording[]>` | — | 从 `<point>.jsonl` 加载 |
| `driftEvents: DriftEvent[]` | — | 该通道漂移事件 |

- 帧文件按桩点分：`recordings/llm.jsonl` / `recordings/web_search.jsonl` / `recordings/web_fetch.jsonl`。
- `manifest.json` 顶层记录**每桩点帧数**：`{ llm_calls, web_search_calls, web_fetch_calls, fingerprint_by_point }`。
- 指纹/drift 每桩点独立（llm 用 system_prompt+tools_schema+model 指纹；web_search/web_fetch 用 query_hash/url_hash 指纹，见 §5）。

**registry 结构**：`RecordReplayRegistry` 内 `channels: Record<StubPoint, StubChannel>`（`StubPoint = 'llm'|'web_search'|'web_fetch'`）。setActiveCase 时按 mode 初始化三通道（replay 各自 loadReplaySet，record 各自清 buffer）。

## 2. 选择器泛化（业务接线点零改动）

现状三处出站接线：
- `llm-client-factory.ts:90` → `pickFetchImpl(getRegistry(), env)`
- `jina-fetcher.ts:94` → `pickWebFetch(getRegistry())`（web_fetch 与 web_search 混用）
- zhipu-provider（web_search）→ 同 `pickWebFetch`

**v2 三个专用选择器**（各自绑定对应通道）：

| 选择器 | 绑定通道 | 接线点 |
|---|---|---|
| `pickLlmFetch(registry)` | `channels.llm` | `llm-client-factory.ts`（替换 `pickFetchImpl`） |
| `pickWebSearchFetch(registry)` | `channels.web_search` | zhipu-provider web_search 出站 |
| `pickWebFetchFetch(registry)` | `channels.web_fetch` | `jina-fetcher.ts`（替换 `pickWebFetch`） |

- 每选择器内部逻辑同现状 `pickFetch`（按 mode 返 record/replay/undefined），但读写自己通道的 seq/cursor/buffer/replaySet。
- record/replay fetch 工厂 `createRecordingFetch`/`createReplayFetch` 泛化：增 `point: StubPoint` 参数，落 buffer/取 replaySet 时用对应通道 + 对应 jsonl。
- **业务代码改动 = 仅换选择器函数名**（`pickWebFetch` → `pickWebFetchFetch`，`pickFetchImpl` → `pickLlmFetch`），签名与返回类型不变，属机械替换（零逻辑改动，满足「业务代码零改动」——出站决策点接线模式不变，只是分道）。

## 3. 端点 schema

### 3.1 `POST /test/stub` — 设置 active case（case 开始）

```
Request:  { "case": string, "mode": "record"|"replay"|"live", "recordingsDir": string(abs) }
Response: 200 { "ok": true, "case": string, "mode": string }   // test env
          404 { "error": "Not Found" }                          // 非 test env
          400 { "error": <校验失败原因> }
```

- 语义：`registry.setActiveCase(case, mode, recordingsDir)`——初始化三通道。`mode=replay` 且 `manifest.json` 缺失 → 自动切 record（沿用现状自动决策）。`mode=live` → 三通道全 pass-through（不拦截）。
- `recordingsDir` record/replay 必填（绝对路径护栏）；live 可省。

### 3.2 `POST /test/stub/step` — step 边界通知（每 step 开始，v2 新增）

```
Request:  { "case": string, "step": number, "declared": StubPoint[] }   // declared = 本 step 的 stub 标记
Response: 200 { "ok": true }
          404 (非 test) / 400 (校验)
```

- 语义：runner 在**每个 step 开始前**调用，告知 server「当前 step 序号 + 声明会撞的桩点集合」。registry 存 `currentStep = { index, declared: Set<StubPoint> }`。
- **框架不并行前提**：单槽 `currentStep`（下个 step 的通知覆盖上个）无竞争。
- record 轮：registry 每桩点通道记录「本 step 期间实际撞了哪些点」（`actualHitByStep`），供 commit 核对。
- replay 轮：出站到达时，通道检查「当前 step 的 `declared` 是否含本桩点」——**不含 → fail loud**（见 §4）。

### 3.3 `POST /test/stub/commit` — case 收尾（case 结束）

```
Request:  { "case": string, "passed": boolean }
Response: 200 {
            "ok": true,
            "flushed": boolean,                 // record + passed 才 true
            "frames": { "llm": N, "web_search": M, "web_fetch": K },   // 每桩点帧数（record 后核对用）
            "stub_audit": {                     // 标记核对结果（record 轮）
              "declared_not_hit": [{ "step": N, "point": "llm" }],     // 标了没撞
              "hit_not_declared": [{ "step": N, "point": "web_fetch" }] // 撞了没标
            },
            "drift": { "detected": boolean, "events": DriftEvent[] }   // replay 轮
          }
```

- `passed=true` + record → 每通道 `flushRecordings`（buffer→对应 jsonl，同步 writeFileSync）+ 写多桩点 manifest；`passed=false` → 全通道 clearBuffer（FAIL 绝不落盘，沿用现状铁律）。
- `stub_audit`（record 轮核对）：`declared_not_hit`（step 标了桩点但无出网）+ `hit_not_declared`（step 有出网但没标）——**任一非空 → runner 判 case fail**（标记不准，录制不可信）。
- `drift`（replay 轮）：任一通道 drift → runner 标 case `drift`（独立分类，不算 fail）。

## 4. replay 未声明出网 fail loud（实现）

replay 轮，某桩点出站到达对应通道的 replay fetch 时：
1. 通道读 `registry.currentStep.declared`——**若不含本桩点** → 抛 `UndeclaredStubError`（携带 step index + point + url_hash），经 onDrift 类回调累积到 registry 的 `undeclaredHits[]`。
2. commit 响应把 `undeclaredHits` 并入结果（新增字段 `undeclared: [{step, point}]`）；**非空 → runner 判 case fail loud**（`replay case hit undeclared stub point 'web_fetch' at step N`）。
3. 与 drift 区别：drift = 声明了但帧对不上（录制过时，重录）；undeclared = 根本没声明却出网（case 声明缺失或代码行为新增外呼，需人查）——两者都不静默。

> 为何不直接在出站处真出网：replay 铁律「桩点零出网」；未声明桩点若放行真出网，等于回放轮偷偷打真 LLM/网络（费用+flaky+不确定）。所以 undeclared 出网必须拦截报错，而非放行。

## 5. 每桩点指纹（drift 判据独立化）

| 桩点 | fingerprint 维度 | 现状 |
|---|---|---|
| `llm` | `system_prompt_hash` + `tools_schema_hash` + `model` | 沿用 `computeFingerprintFromInit`（codec） |
| `web_search` | `query_hash`（query 文本 SHA-256 前 16）+ `provider` | 现状 `WebSearchRecording.request_meta.query_hash` 已有，v2 用作 drift 判据 |
| `web_fetch` | `url_hash`（目标 URL SHA-256 前 16） | **新增**（现状 web_fetch 与 web_search 混用无独立指纹）——从 fetch init 的 url 算 |

- 每通道 replay 时按自己维度 checkDrift；不匹配 → 该通道 driftEvents 累积 + 抛 RecordingDriftError（沿用现状回调不 try/catch 机制）。
- 指纹计算收敛到 codec 单一权威（record 侧与 replay 侧走同一构造，避免两侧不一致导致永远 drift/永不 drift）。

## 6. session 分道现状（sessionHint）

- 沿用现状 ALS + `extractSessionHint`：单 session case 走 `_default` 单道（现状已知债，v2 不解锁）。
- 每通道的 seqMap/cursorMap 仍按 sessionHint 分组——单 session case 三通道各自 `_default` 道按序消费。
- 多 session case（squad）→ 归 `requires: live` 白名单（回放机制结构性边界，不录制），与现状 v0.0.120 一致。

## 7. server 侧改动清单（只动 testing/ + 路由挂载）

| 文件 | 改动 | 业务侵入 |
|---|---|---|
| `app/server/src/testing/record-replay-registry.ts` | 泛化多桩点通道 + 三选择器 + currentStep + undeclaredHits | 无（testing 内部） |
| `app/server/src/testing/recording-codec.ts` | per-point buffer/loadReplaySet/flush + 多桩点 manifest + url_hash 指纹 | 无 |
| `app/server/src/testing/recording-fetch.ts` | `createRecordingFetch(point,...)` 泛化 | 无 |
| `app/server/src/testing/replay-fetch.ts` | `createReplayFetch(point,...)` 泛化 + undeclared 检查 | 无 |
| `app/server/src/testing/stub-handler.ts` | **新增**：`/test/stub` + `/test/stub/step` + `/test/stub/commit` handler | 无 |
| `app/server/src/testing/types.ts` | 加 `StubPoint` / `StubChannel` / `StubAudit` 类型 | 无 |
| `app/server/src/router.ts` | 挂载 `/test/stub*`（test-only gate，对齐现有 `/test/llm-mode` 挂载） | 路由挂载 |
| `app/server/src/llm-client-factory.ts` | `pickFetchImpl` → `pickLlmFetch`（机械换名） | 出站决策点换名，逻辑零改 |
| `app/server/src/tools/web-fetch/jina-fetcher.ts` | `pickWebFetch` → `pickWebFetchFetch`（机械换名） | 同上 |
| `app/server/src/tools/web-search/zhipu-provider.ts`（或对应文件） | web_search 出站接 `pickWebSearchFetch` | 同上 |

> 旧 `/test/llm-mode` + `test-llm-mode-handler.ts` **保留不动**（tests/ 旧框架依赖）；v2 用新 `/test/stub` 前缀端点，二者共存。旧 `pickFetchImpl`/`pickWebFetch` 若无其它引用可在 doc-sync 期评估删除（coder 编码时确认引用后定，避免误删旧框架依赖）。
