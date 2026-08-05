---
type: change-plan
version: v0.0.127
feature: et_refactor
updated: 2026-07-13
status: draft
related_prd: specs/prd/version_logs/v0.0.127/change_log.md
related_research: specs/research/v0.0.127/{overview,infrastructure-b-sse-stub,case-inventory,recording-format,server-stub-extension}.md
---

# v0.0.127 变更计划书 — ET 框架重构（method 级 review 合同）

> 行 = 函数/符号（新增 class/interface/type 也各占一行）。8 列严格齐全。planner 按本表切 task，code-reviewer 按本表查偏离。
> **架构师核对结论**（预防性 grep/读代码确认符号存在）：
> - `STUB_POINTS`/`StubPoint`（`app/server/src/testing/types.ts:27,30`）三值闭合 ✅
> - `RecordReplayRegistry.{setActiveCase,getActiveCase,recordStubHit,commitIfPassed,getOrCreateChannelFetch,getChannelRecordingFetch}` 全部存在 ✅
> - `appendRecording`/`clearBuffer`/`flushAllPoints`/`loadReplaySetByPoint`（`recording-codec.ts`）签名已核对 ✅
> - `stub-handler.ts::handleTestStub/Step/Commit`（`/test/stub` 三端点）已存在，`declared` 已支持数组 ✅
> - `tests/api/lib/{run_case.py,step_exec.py,case_loader.py,check_engine.py,artifacts.py,sse_collector.py,stub_client.py,interp.py}` 全部存在 ✅
> - `router.ts::dispatchRequestInternal`（438-458 行 /test/stub + 449-458 行 /sse 段）已存在 ✅
> - **关键偏差（与 PRD/research 描述不符）**：SSE 实际是 `GET /sse`（单连接 fan-out）+ `POST /sse/subscribe {topic,group,subId}`（订阅登记），**不是** `GET /sse/:topic/:group`。本计划书 sse-interceptor 按实际架构设计（包装 `SseChannel.writeFrame` + 订阅登记）。详见 §关键架构修正。
> - `recording-codec.ts::pointBufferMap: Record<StubPoint, unknown[]>`（v2 buffer 表）已存在，扩 http/sse 通道只是加 key ✅

---

## 关键架构修正（architect 发现的 PRD/research 与现状代码偏差）

### 偏差 1：SSE 路由模式（PRD/research vs 实际代码）

- **PRD/research 描述**（§2.2 / recording-format.md）：`/sse/:topic/:group` 路径模板，topic 是路径一段
- **实际代码**（`handlers/sse.ts` + `sse/sse-channel.ts`）：
  - `GET /sse`：建立单连接（fan-out，所有 topic 共享一条 ReadableStream）
  - `POST /sse/subscribe {topic, group, subId}`：登记订阅（后端按 topic+group 过滤后 push 帧）
  - `DELETE /sse/subscriber/:subId`：取消单个订阅
  - 写帧点：`SseChannel.writeFrame(frame)`（私有方法，广播到所有 sinks）
- **修正**：sse-interceptor 包装 `writeFrame`（录帧）+ `subscribe`（录制订阅登记）；replay 时按 (topic, group) 匹配录制流，回放时仍走 fan-out 模型（同一 `/sse` 连接，按录制 push 帧）。**api_normalized = `{topic}:{group}`（订阅键）**，不是 URL 路径。
- **coder 须按实际架构实现**，PRD §2.2 的路径模板描述是概念性简化；本计划书的 sse-interceptor 行已按实际写。
- **orchestrator 裁决项**：是否需回写 PRD/research 的 SSE 描述？建议 doc-modifier 阶段 5 同步对齐。

### 偏差 2：router.ts 不是 Hono middleware（不是 `app.use`）

- **PRD/research 描述**：`installHttpInterceptor(app, registry)` 用 `app.use('*', ...)` 包装
- **实际代码**：`router.ts::dispatchRequestInternal()` 是一系列 `if path.startsWith(...)` 分发，**不是** Hono app（grep 后确认无 `new Hono()`，函数式 dispatch）
- **修正**：http-route-interceptor 提供纯函数 `interceptHttpRequest(method, path, req, registry)`，在 `dispatchRequestInternal` 入口（`/test/*` 排除之后、业务路由分发之前）调用；replay 命中则直接返回 Response，未命中返回 null 让原 dispatch 继续。
- **coder 须按函数式 dispatch 模式接线**，不要引入 Hono。

### 偏差 3：router.ts 是 615 行（已 >300）

- 现状已知债：本版本新增 SSE/http 拦截接线会再加若干行。建议把 `/sse` 路由分发段（449-458 行）+ 新增拦截器调用集中到独立 `sse-routes.ts`，或在 `dispatchRequestInternal` 仅加最小拦截器入口调用（拦截器内部逻辑全在 `testing/` 下，router.ts 只加 1-2 行调用）。
- **本计划书约束**：router.ts 净增 ≤ 20 行（仅入口调用 + 注释）。

---

## A 组：server stub 扩展（5 通道 + 入站拦截器）

> 模块：testing（server 内测试基建层，非产品业务逻辑）。
> 原则：加性扩展，不破坏 AT 现有行为（AT 不走浏览器，无 http/sse 入站）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| testing | app/server/src/testing/types.ts | `StubPoint` | 修改 | 类型从 3 值扩为 5 值：`'llm'\|'web_search'\|'web_fetch'\|'http'\|'sse'` | MUST 保持闭合（enum 单一权威）；MUST 同步 STUB_POINTS 常量；AT case.yaml 仍只写 `stub:[llm]` 透明兼容 | specs/tech/testing/record-replay.md §2; research/server-stub-extension.md §2 | +2/-2 |
| testing | app/server/src/testing/types.ts | `STUB_POINTS` | 修改 | 常量数组加 `'http'`,`'sse'`：`['llm','web_search','web_fetch','http','sse']` | MUST 与 StubPoint 类型同步；单一权威避免多处硬编码漂移 | 同上 | +1/-1 |
| testing | app/server/src/testing/types.ts | `HttpRecording` | 新增 | interface：`{seq, api, api_normalized, request:{method,path,query,body}, response:{status,headers,body}, elapsed_ms}`；replay 按 api_normalized+seq 匹配 | body 是解析后 JSON 对象（便于 diff），不存字符串；MUST NOT 存敏感 header（Authorization/cookie 走 redact） | research/recording-format.md §http.jsonl | +22 |
| testing | app/server/src/testing/types.ts | `SseEventRecord` | 新增 | interface：`{type, data, delay_ms}`；delay_ms=相对上一帧延迟（用于保真回放） | MUST 与 RecordingResponse.sse_frames 区分（后者是 LLM 出站帧字符串；SseEventRecord 是入站业务事件结构化） | research/recording-format.md §sse.jsonl | +8 |
| testing | app/server/src/testing/types.ts | `SseStreamRecording` | 新增 | interface：`{seq, topic, group, api_normalized, events:SseEventRecord[], total_events, duration_ms}`；订阅键=topic+group | topic/group 来自 POST /sse/subscribe body（不是 URL 路径，与实际 SSE 协议对齐） | 关键架构修正 §偏差1 | +14 |
| testing | app/server/src/testing/types.ts | `RecordingManifest` | 修改 | 加可选字段：`http_calls?:number; sse_streams?:number` | AT case 无 http/sse 调用时字段省略（向后兼容） | research/recording-format.md §manifest | +2 |
| testing | app/server/src/testing/recording-codec.ts | `pointBufferMap` | 修改 | Record 表加 `http:[]`,`sse:[]` 两个 buffer key（v2 泛化天然支持） | MUST 不动 llm/web_search/web_fetch 现有 key | record-replay.md §2 | +2/-1 |
| testing | app/server/src/testing/recording-codec.ts | `flushAllPoints` | 修改 | 扩 manifest summary 加 http_calls/sse_streams 字段（沿用 frameCounts[p]）；STUB_POINTS 循环天然覆盖新通道 | MUST 保持同步 writeFileSync；MUST allocated≠buffer.length 时仍 fail loud 不落盘该通道 | record-replay.md §3.3; recording-codec.ts:107-145 | +6/-2 |
| testing | app/server/src/testing/recording-codec.ts | `loadReplaySetByPoint` | 修改 | 函数已泛化（按 point 读 `<point>.jsonl`），http/sse 自动支持；需确认返回 Map 的 value 类型 union 加 HttpRecording/SseStreamRecording | MUST 不破坏 llm/web_search/web_fetch 的 ReplaySet 结构 | recording-codec.ts:171-189 | +3/-1 |
| testing | app/server/src/testing/recording-codec.ts | `redact` | 修改 | redact 规则扩 http/sse 通道：剔除 request.headers 的 Authorization/Cookie/Set-Cookie；query/body 保留（业务断言用） | MUST 与 llm 通道 redact（messages 不落盘）同列安全约束；MUST 剔除 cookie/auth | research/recording-format.md §安全约束 | +12 |
| testing | app/server/src/testing/record-replay-registry.ts | `channelReplaySets`/`channelFetchInstances` 初始化 | 修改 | setActiveCase 内 5 通道初始化（加 http/sse 两个 Map/null）；reset 时清零 | MUST 不动 llm/web_search/web_fetch 现有重置；加性扩展 | record-replay-registry.ts:42-44,61-62 | +6/-2 |
| testing | app/server/src/testing/record-replay-registry.ts | `getOrCreateChannelFetch(point)` | 修改 | 类型签名已支持 StubPoint（5 值）；http/sse 通道**不走 createReplayFetch**（不是出站 fetch），需在函数内分流：http/sse 走 matchHttpReplay/matchSseReplay 专属方法 | MUST NOT 对 http/sse 调 createReplayFetch（出站 fetch 拦截器不适用入站）；MUST 在函数顶部判 point 分流 | record-replay-registry.ts:188-202 | +18/-3 |
| testing | app/server/src/testing/record-replay-registry.ts | `getChannelRecordingFetch(point)` | 修改 | 同上：http/sse 通道返 null（不走出站 fetch 录制）；录制走专属 appendHttpRecording/appendSseRecording | MUST NOT 对 http/sse 调 createRecordingFetch | record-replay-registry.ts:205-215 | +6/-1 |
| testing | app/server/src/testing/record-replay-registry.ts | `matchHttpReplay(api_normalized)` | 新增 | 方法：按 (api_normalized, seq 游标) 从 channelReplaySets['http'] 取录制；命中返 HttpRecording，未命中返 null；调 recordStubHit('http') 计 audit | seq 按 api_normalized 维护独立游标（Map<api_normalized, number>）；MUST 返回结构包含完整 response 供 interceptor 直接返回 | research/recording-format.md §replay 匹配; server-stub-extension.md §http-route-interceptor | +28 |
| testing | app/server/src/testing/record-replay-registry.ts | `matchSseReplay(topic, group)` | 新增 | 方法：按 (topic, group) 从 channelReplaySets['sse'] 取录制流；命中返 SseStreamRecording，未命中返 null；调 recordStubHit('sse') | topic+group 是订阅键（不是 URL 路径，对齐 SSE 实际协议）；seq 按 topic+group 组合维护游标 | 关键架构修正 §偏差1; recording-format.md §SSE 流匹配 | +24 |
| testing | app/server/src/testing/record-replay-registry.ts | `appendHttpRecording(rec)` | 新增 | 方法：record 模式录 http 请求/响应；分配 seq（getNextSeq(hint,'http')）；调 appendRecording('http', rec) + recordStubHit('http') | MUST 在 record 模式才调用；replay 模式走 matchHttpReplay | research/server-stub-extension.md §http-route-interceptor 伪代码 | +16 |
| testing | app/server/src/testing/record-replay-registry.ts | `appendSseRecording(rec)` | 新增 | 方法：record 模式录 sse 流；分配 seq（getNextSeq(hint,'sse')）；调 appendRecording('sse', rec) + recordStubHit('sse') | MUST 在 record 模式才调用；events 数组在流结束时一次性 append（不在每帧 append） | research/server-stub-extension.md §sse-interceptor | +18 |
| testing | app/server/src/testing/record-replay-registry.ts | `getHttpCursor(api_normalized)` / `nextHttpSeq(api_normalized)` | 新增 | 方法：per-api_normalized 游标管理（Map<api_normalized, number>）；replay 时消费 seq，record 时分配 seq | MUST 与 llm 的 SeqAllocator 解耦（llm 按 session_hint 分组，http 按 api_normalized 分组） | research/recording-format.md §replay 匹配 | +20 |
| testing | app/server/src/testing/record-replay-registry.ts | `getSseCursor(topic, group)` / `nextSseSeq(topic, group)` | 新增 | 方法：per-(topic+group) 游标管理；replay 时消费，record 时分配 | MUST 与 http 游标独立（不同通道） | 同上 | +18 |
| testing | app/server/src/testing/http-route-interceptor.ts | `interceptHttpRequest(method, path, req, registry)` | 新增 | 文件 + 函数：入站 HTTP 拦截器入口。test 模式 + activeCase 存在时调；record 透传真 handler 后录响应；replay 命中 matchHttpReplay 返录制响应；非 test/无 active 返 null（让原 dispatch 继续）。返 Promise<Response\|null> | MUST NOT 拦截 /test/* 路径（stub 协议自身）；MUST NOT 拦截静态资源（`/`、`/assets/*`、`/index.html`、`/vite/*` 白名单透传）；replay 未命中默认透传（非 fail，因非 stub API 如 HMR 不应阻塞）；record 模式 await next() 后读 c.res.clone() 录 body | 关键架构修正 §偏差2; research/server-stub-extension.md §http-route-interceptor | +95 |
| testing | app/server/src/testing/http-route-interceptor.ts | `normalizeApiPath(method, path)` | 新增 | 函数：路径模板化——替换 ULID（01J*）/数字 ID 为 `*`；返 `'{METHOD} {templated_path}'`（如 `POST /session/*/messages`）；query 不进 normalized_key（仅记录） | MUST 用正则识别 ULID（`/[0-9A-HJKMNP-TV-Z]{26}/`）+ numeric id；MUST 区分 /sse 系列（走 sse-interceptor 不走这里） | research/recording-format.md §api_normalized | +32 |
| testing | app/server/src/testing/http-route-interceptor.ts | `STATIC_ASSET_WHITELIST` | 新增 | 常量：`['/', '/index.html', '/assets/', '/vite/', '/favicon.ico', '/health']`；这些路径 replay 时强制透传不 stub | MUST 在 interceptHttpRequest 顶部检查；避免浏览器加载静态资源被 stub 误杀 | server-stub-extension.md §边界 §2 | +6 |
| testing | app/server/src/testing/sse-interceptor.ts | `wrapSseChannelForTest(channel, registry)` | 新增 | 文件 + 函数：包装 SseChannel 的 writeFrame + subscribe，record 录帧序列 / replay 保真回放。返包装后的 channel（router.ts 注入） | MUST NOT 改变 channel.openConnection 协议（GET /sse 仍返 ReadableStream）；MUST record 时包 writeFrame（不破坏 fan-out）；MUST replay 时拦截 subscribe + 后续 writeFrame | 关键架构修正 §偏差1; sse/sse-channel.ts:62,93,321 | +120 |
| testing | app/server/src/testing/sse-interceptor.ts | `recordSseSubscription(topic, group, subId, registry)` | 新增 | 函数：record 模式下登记订阅（建空 SseStreamRecording 占位 + 启动帧收集器）；返 recorder handle 供 writeFrame 钩子用 | MUST 用 topic+group 做 key（不是 subId，因 reconnect 时 subId 变但 topic+group 不变）；MUST 在 unsubscribe 时 finalize 录制（计算 delay_ms 序列后 appendSseRecording） | research/server-stub-extension.md §record 模式 SSE 录制 | +38 |
| testing | app/server/src/testing/sse-interceptor.ts | `recordSseFrame(topic, group, type, data)` | 新增 | 函数：record 模式 writeFrame 钩子——push (type, data, ts) 到对应 recorder buffer；不阻塞 fan-out（异步累加） | MUST 用 Date.now() - last_ts 算 delay_ms；MUST 容忍 recorder 不存在（订阅前偶发帧，跳过） | research/recording-format.md §sse.jsonl events[].delay_ms | +22 |
| testing | app/server/src/testing/sse-interceptor.ts | `replaySseStream(topic, group, recording, sink, options)` | 新增 | 函数：replay 模式按 recording.events[] 保真回放——读 delay_ms，sleep(min(delay_ms, MAX_DELAY_MS=5000))，sink.push(wire)；ET_REPLAY_FAST=1 时一次性 push 不 sleep | MUST 用 sink.push（走 channel fan-out 机制，不直接写 HTTP response）；MUST MAX_DELAY_MS 上限避免单帧异常拖垮 case；MUST FAST 模式受 env 控制（replay 轮 smoke 用） | PRD §2.2 SSE 时序还原; recording-format.md §时序还原策略 | +42 |
| testing | app/server/src/testing/sse-interceptor.ts | `MAX_DELAY_MS` / `REPLAY_FAST_MODE` | 新增 | 常量：`MAX_DELAY_MS=5000`；`REPLAY_FAST_MODE = process.env.ET_REPLAY_FAST === '1'` | MUST 与 AT 的 stub 协议解耦（ET 专属，AT 不读此 env） | PRD §2.2 | +3 |
| testing | app/server/src/router.ts | `dispatchRequestInternal()` | 修改 | 入口加拦截器调用：`/test/*` 排除后、业务路由分发前调 `interceptHttpRequest(method, path, req, getRegistry())`；命中（非 null）直接 return；未命中继续原 dispatch。同样在 SSE channel 注入处调 `wrapSseChannelForTest`（test 模式） | MUST router.ts 净增 ≤20 行（仅入口调用）；MUST test 模式 gate（process.env.NODE_ENV==='test'）；MUST NOT 引入 Hono 或 app.use | 关键架构修正 §偏差2、§偏差3; router.ts:438-458 | +12/-0 |
| testing | app/server/src/testing/stub-handler.ts | `VALID_STUB_POINTS` 校验逻辑 | 修改 | 校验 declared 数组时，错误消息加 http/sse 提示（值域已扩展，自动通过） | MUST NOT 改协议（/test/stub/step 仍接收 declared 数组）；仅错误消息文案更新 | stub-handler.ts:92,122-125 | +2/-2 |

---

## B 组：ET 框架新建（tests/e2e/lib）

> 模块：testing（Python 框架代码）。
> 原则：对齐 AT 架构（case.yaml DSL + runner + step_exec + selftest + run_all），ET 专属 step 是 Playwright 动作。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| testing | tests/e2e/lib/case_loader.py | `load_case(case_dir)` | 新增 | 文件 + 函数：ET case.yaml 加载 + 校验。复用 AT case_loader 的顶层字段校验逻辑（case/module/timeout/requires/setup/steps/teardown）；扩 ET 专属 step 字段（navigate/click/type/press/hover/drag/screenshot/vision_check/js_eval/compares）；stub 声明扩 http/sse | MUST 复用 AT 的 _STUB_POINTS（加 http/sse）；MUST 校验 ET step 不可与 AT step 在同一 step 混用 action（一个 step 一个主动作）；MUST timeout 上限 300s（ET 比 AT 长，含浏览器启动） | PRD §2.1; tests/api/lib/case_loader.py:43-49 | +280 |
| testing | tests/e2e/lib/case_loader.py | `Case` / `Step` dataclass | 新增 | dataclass：与 AT 同名但扩字段（Step 加 et_action: str；Case 加 compares: list + viewport: dict 可选）；保持 setup/steps/teardown 三 phase 结构 | MUST 与 AT Case 结构对齐（designer 学一套）；MUST 校验 compares[] 元素结构（design/impl/checks） | PRD §2.1; tests/api/lib/case_loader.py:24-41 | +30 |
| testing | tests/e2e/lib/case_loader.py | `_validate_et_step(step, loc)` | 新增 | 函数：校验 ET 专属 step 字段（navigate/click/type 等的子字段必填；selector 非空；text 可空；url 必须 http(s):// 或 /相对路径） | MUST 拒载多 action（同 AT）；MUST 拒载未知 ET step 字段 | tests/api/lib/case_loader.py:170-214 | +60 |
| testing | tests/e2e/lib/step_exec.py | `exec_step(step, ctx, page, sse)` | 新增 | 文件 + 函数：ET step 执行器。action 分发（navigate→page.goto；click→page.click；type→page.fill；press→page.keyboard.press；hover→page.hover；drag→page.drag_and_drop；screenshot→命名截图；vision_check→调 vision_check.py；js_eval→page.evaluate）；复用 AT 的 requests/run/poll/wait/oracle（同 case.yaml 可混用，setup 用 AT step 造数据，steps 用 ET step） | MUST Playwright auto-wait 内置（禁显式 sleep）；MUST 每 step 默认截图（auto-wait/networkidle/断言后三时机）；MUST check 走 check_engine（与 AT 同款原子断言）；page 是 Playwright Page 对象（ET 专属，AT 无） | PRD §2.1; tests/api/lib/step_exec.py:22 | +280 |
| testing | tests/e2e/lib/step_exec.py | `_do_navigate(step, ctx, page)` | 新增 | 函数：page.goto(url, wait_until='domcontentloaded')；url 走 interp 插值 | MUST auto-wait domcontentloaded（不 networkidle，避免 SSE 长连接阻塞）；MUST url 支持相对路径（拼 RENDERER_URL） | PRD §2.1 navigate | +18 |
| testing | tests/e2e/lib/step_exec.py | `_do_click(step, ctx, page)` | 新增 | 函数：page.click(selector, timeout=step.timeout_ms or 10000)；selector 走 interp；支持 testid 语法（`[data-testid="X"]`） | MUST Playwright auto-wait（可见/可点/稳定）；MUST selector 支持 testid 简写（`testid:X` → `[data-testid="X"]`） | PRD §2.1 click | +24 |
| testing | tests/e2e/lib/step_exec.py | `_do_type(step, ctx, page)` | 新增 | 函数：page.fill(selector, text)；text 走 interp；clear 默认 true | MUST auto-wait；MUST contenteditable/tiptap 走 page.locator(selector).pressSequentially（fill 不触发 input rule，旧 runner.py 已知坑） | 旧 runner.py type action 注释 | +28 |
| testing | tests/e2e/lib/step_exec.py | `_do_press(step, ctx, page)` | 新增 | 函数：page.keyboard.press(key)；key 走 interp（Enter/Escape/Tab 等 Playwright 标准键名） | MUST 校验 key 是 Playwright 合法键名（拒载未知） | 旧 runner.py press action | +12 |
| testing | tests/e2e/lib/step_exec.py | `_do_hover(step, ctx, page)` / `_do_drag(step, ctx, page)` | 新增 | 函数：page.hover(selector) / page.drag_and_drop(src, dst) | MUST auto-wait；drag 走 mouse.down→move→up 序列（对齐旧 runner.py HTML5 DnD） | PRD §2.1; 旧 runner.py drag | +32 |
| testing | tests/e2e/lib/step_exec.py | `_do_screenshot(step, ctx, page)` | 新增 | 函数：命名截图 page.screenshot(path=...)；默认每 step 也截图（框架内置，不需显式 step） | MUST 与 vision_check 配合（截图供 vision_check.py 读）；MUST 截图存 last_run/steps/NN/screenshot.png | PRD §2.1 screenshot | +16 |
| testing | tests/e2e/lib/step_exec.py | `_do_vision_check(step, ctx, last_screenshot)` | 新增 | 函数：调 vision_check.py 单图判定（subprocess.run）；step.vision_check.checks 是 JSON 数组；返 [{id,pass,note}] | MUST 走 vision_check.py 脚本（禁 MCP/Read 看图）；MUST vision fail = conflict 不阻塞（dom 主判定） | PRD §2.1; tests/e2e/lib/vision_check.py | +28 |
| testing | tests/e2e/lib/step_exec.py | `_do_js_eval(step, ctx, page)` | 新增 | 函数：page.evaluate(code)；严格限制使用（case_loader 标 warn） | MUST 仅兜底用（无法用上述 step 表达时）；MUST code 走 interp | PRD §2.1 js_eval | +14 |
| testing | tests/e2e/lib/run_case.py | `main(case_dir, mode)` | 新增 | 文件 + 函数：ET 单 case 入口。load → 启 Playwright（sync_playwright）→ 启 browser/context/page（注入 window.api init script）→ setup/steps/teardown 编排（调 step_exec.exec_step + per-step /test/stub/step）→ 截图 → commit → 写 result.json | MUST teardown 必跑（steps fail 也跑）；MUST 每 step 调 stub_client.set_step（与 AT 同款）；MUST Playwright browser 每 case 新建（隔离）；MUST page.add_init_script 注入 window.api（旧 runner.py build_api_init_script 已验证） | tests/api/lib/run_case.py:131 | +260 |
| testing | tests/e2e/lib/run_case.py | `_run_phase(phase_name, steps, ctx, page, sse, case_dir, step_offset, case_id)` | 新增 | 函数：执行一个 phase（setup/steps/teardown）；返 (phase_pass, step_offset_after, steps_summary)；与 AT run_case._run_phase 同结构但加 page 参数 | MUST 每 step 调 stub_client.set_step；MUST step fail 后同 phase 后续跳过（teardown 例外必跑）；MUST step 产物落 last_run/steps/NN/{screenshot,responses,events,checks}.json | tests/api/lib/run_case.py:25-93 | +90 |
| testing | tests/e2e/lib/run_case.py | `_inject_window_api(page, server_url)` | 新增 | 函数：page.add_init_script 注入 window.api={serverUrl, quit:()=>{}}（web 模式 Playwright 无 preload 的兜底） | MUST 复用旧 runner.py 的 build_api_init_script 逻辑；MUST 在首次 page.goto 前调用 | 旧 runner.py 注释 web 模式注入 window.api | +22 |
| testing | tests/e2e/lib/run_case.py | `ET_REPLAY_FAST` / `MAX_DELAY_MS` env 读取 | 新增 | 常量：从 env 读 ET_REPLAY_FAST（默认 '0'）；透传给 server（test 模式下 server 也读同 env） | MUST 与 server 端 sse-interceptor 的 REPLAY_FAST_MODE 同源（env 单一权威） | A 组 sse-interceptor REPLAY_FAST_MODE | +4 |
| testing | tests/e2e/lib/stub_client.py | 复用 AT stub_client | 复用 | 不新建：ET 直接 import tests/api/lib/stub_client（PYTHONPATH 加 tests/api/lib）；set_case/set_step/commit 三方法协议不变（StubPoint 扩 http/sse 后 declared 数组值域自动接受） | MUST NOT 复制 stub_client（避免双份维护）；MUST run_all.sh 设 PYTHONPATH 含 tests/api/lib | research/server-stub-extension.md §stub 协议不新增端点 | +0 |
| testing | tests/e2e/lib/check_engine.py | 复用 AT check_engine | 复用 | 不新建：ET import tests/api/lib/check_engine（parse_atomic / eval_check）；dom 断言走 page.evaluate 读 DOM 后 eval（或直接 page.locator 断言） | MUST NOT 复制；MUST dom 断言适配——ET 的 check 可能引用 page 状态（如 `dom: [data-testid="X"] exists`），扩展 check 引擎支持 dom: 前缀 | PRD §2.1 check 数组主判定 | +0 |
| testing | tests/e2e/lib/check_engine_et_ext.py | `eval_dom_check(expr, page)` | 新增 | 文件 + 函数：ET 对 check_engine 的扩展。dom: 前缀断言走 Playwright（page.locator().count()/.text_content()/.is_visible()）；与 AT check_engine 的 requests/sse 断言正交 | MUST dom 断言主判定（PRD §2.1）；MUST fail 自解释（actual 列实际 DOM 状态） | PRD §2.1; tests/api/lib/check_engine.py | +120 |
| testing | tests/e2e/lib/check_engine_et_ext.py | `parse_dom_atomic(expr)` | 新增 | 函数：解析 dom: 前缀表达式——`dom: <selector> <op> <value>`（op=exists/not_exists/text=count/visible/hidden）；返结构化 atomic check | MUST 与 AT parse_atomic 同返回结构（AtomicCheck dataclass） | 同上 | +40 |
| testing | tests/e2e/lib/artifacts.py | 复用 AT artifacts（扩截图字段） | 复用+扩展 | import AT artifacts.write_step/write_result/build_result；ET 在 extra 字段加 screenshot_path；产物路径 last_run/steps/NN/{responses,events,checks,screenshot}.json | MUST 复用 write_step（不复制）；MUST screenshot 单独文件不进 JSON（二进制） | tests/api/lib/artifacts.py | +0（AT 文件不改） |
| testing | tests/e2e/lib/interp.py | 复用 AT interp（加 RENDERER_URL 变量） | 复用 | import AT interp（interpolate/http_request/get_base_url）；ET 扩 RENDERER_URL 变量（goto URL 拼接用） | MUST NOT 复制；MUST {RENDERER_URL} 是 ET 专属变量（AT 无） | tests/api/lib/interp.py | +0 |
| testing | tests/e2e/lib/sse_collector.py | 复用 AT sse_collector | 复用 | import AT sse_collector.SseCollector；ET case.yaml 的 sse.sub 走同款订阅协议（POST /sse/subscribe） | MUST NOT 复制；MUST ET 与 AT 共享 SSE 订阅语义（同一 server SSE 端点） | tests/api/lib/sse_collector.py | +0 |
| testing | tests/e2e/lib/vision_check.py | 复用现有 vision_check.py | 复用 | 不改：现有 tests/e2e/lib/vision_check.py 的 compare 子命令 + 单图判定都保留；ET step_exec._do_vision_check 调它 | MUST NOT 重写；MUST 保持 compare 子命令签名不变（run_all 跑 compares[] 依赖） | tests/e2e/lib/vision_check.py | +0 |
| testing | tests/e2e/lib/run_all.sh | `main()` 入口段 | 修改 | 改造现有 run_all.sh：扫 case.yaml（替代 checkpoint.json）→ 调 run_case.py（替代 run_case.sh）→ 聚合；移除 checkpoint.json 扫描逻辑；加 MODE=record\|replay 外部传（与 AT 对齐）；加 ET_REPLAY_FAST 透传 | MUST CASES= 白名单语义不变（防呆规则保留）；MUST 列 case 用 case.yaml（不是 checkpoint.json）；MUST run_case.py 取代 run_case.sh；MUST 产物路径 states/<ver>/verify/e2e-test/ 不变 | tests/e2e/lib/run_all.sh:99-122（LIST_ONLY 段）; tests/api/lib/run_all.sh | +60/-40 |
| testing | tests/e2e/lib/run_all.sh | `MODE` env 处理 | 新增 | 段：读 MODE=record\|replay（默认 replay）；传给 run_case.py；record 双关（PASS 自动紧接 replay）逻辑复用 AT run_all 的双关实现 | MUST 与 AT run_all MODE 语义一致；MUST record 缺 recordings 自动切 record（同 AT setActiveCase 逻辑） | tests/api/lib/run_all.sh | +20 |
| testing | tests/e2e/lib/run_all.sh | `ET_REPLAY_FAST` env 透传 | 新增 | 段：读 ET_REPLAY_FAST=1（默认 0）；export 给 server 端 sse-interceptor 读 | MUST env 单一权威（server/client 同源） | A 组 sse-interceptor | +4 |
| testing | tests/e2e/lib/run_case.sh | 整个文件 | 删除 | 旧框架入口（调 runner.py + checkpoint.json），被 run_case.py 取代 | MUST 删除（不遗留死代码，架构原则#2）；MUST grep 确认无其他引用后删 | 旧 runner.py 入口 | -45 |
| testing | tests/e2e/lib/runner.py | 整个文件 | 删除 | 旧 Playwright 执行器（checkpoint.json 解析 + action 字符串分发），被 run_case.py + step_exec.py 取代 | MUST 删除；MUST 保留 build_api_init_script 逻辑（迁移到 run_case._inject_window_api）；MUST 删前 grep 确认无 selftest 引用 | 旧 runner.py 全文 | -573 |
| testing | tests/e2e/lib/_run_compares.py | `main(impl_dir, design_dir, compares)` | 修改 | 适配新 case.yaml 的 compares[] 字段（design/impl/checks 结构不变）；从 last_run/ 读 impl 截图（而非旧 screenshots/） | MUST compare 子命令签名不变；MUST 读 last_run/steps/NN/screenshot.png 或 last_run/final.png | tests/e2e/lib/_run_compares.py 现有 | +15/-10 |
| testing | tests/e2e/env_start.sh | boot 序列 | 修改 | 不变（启 backend + web server）；但加 test 模式下 NODE_ENV=test 透传 + ET_REPLAY_FAST 透传 | MUST 不改 env 启动逻辑；MUST env vars 透传 | tests/e2e/env_start.sh 现有 | +4/-0 |

---

## C 组：ET selftest（框架自检）

> 模块：testing（框架自测，只能 UT，用户裁决原则）。
> 原则：对齐 AT selftest（tests/api/lib/selftest/run_selftest.py）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| testing | tests/e2e/lib/selftest/run_selftest.py | `main()` | 新增 | 文件 + 函数：ET selftest 入口。跑 case_loader/step_exec/check_engine_et_ext 的 UT（mock Playwright page）；不跑真实 case；命令 `python3 tests/e2e/lib/selftest/run_selftest.py` | MUST 只 UT 框架自身（不跑 case，用户裁决）；MUST mock Playwright（不起真 browser）；MUST 与 AT selftest 同款零依赖运行 | tests/api/lib/selftest/run_selftest.py; PRD §2.5 | +120 |
| testing | tests/e2e/lib/selftest/test_case_loader.py | `test_*()` 多个 | 新增 | UT：case.yaml 加载校验（顶层字段/ET step 字段/stub 声明/compares 结构/插值变量） | MUST 覆盖拒载场景（未知字段/多 action/超时 timeout） | tests/api/lib/selftest/ | +180 |
| testing | tests/e2e/lib/selftest/test_step_exec.py | `test_*()` 多个 | 新增 | UT：step 执行器（mock page 验证调用序列：navigate→goto、click→click、type→fill 等）；check 求值（dom 断言 mock page.locator） | MUST mock Playwright Page 对象（unittest.mock.MagicMock + assert_called_with） | 同上 | +220 |
| testing | tests/e2e/lib/selftest/test_check_engine_et.py | `test_*()` 多个 | 新增 | UT：dom 断言解析 + 求值（exists/not_exists/text=count/visible/hidden 各 op） | MUST fail 自解释（actual 列实际 DOM） | tests/api/lib/selftest/ | +140 |

---

## D 组：case 全量迁移（46 → ~41）

> 模块：testing（case.yaml 文件，非框架代码）。
> 原则：迁移规则统一（旧 checkpoint.json → 新 case.yaml step 映射表见 PRD §2.4）；逐 case 迁移由 designer 阶段做，不在本计划书逐 case 列（只记迁移策略规则）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| testing | tests/e2e/<module>/<case>/checkpoint.json | 旧文件 | 删除 | 46 个旧 checkpoint.json 全删（迁 39 / 并 5→3 / 弃 2 后） | MUST 迁移完成 + 新 case.yaml 双关 PASS 后才删旧；MUST grep 确认 run_all.sh 不再扫 checkpoint.json | PRD §2.4; research/case-inventory.md | -46 文件 |
| testing | tests/e2e/<module>/<case>/case.yaml | 新文件 | 新增 | ~41 个新 case.yaml（39 迁 + 2 合并产出）；按 PRD §2.4 旧→新 step 映射表转换；setup/teardown 用 AT step（requests 造数据）；steps 用 ET step（navigate/click/type/check）+ 按需 sse.sub/vision_check/compares | MUST designer 阶段逐 case 设计（本计划书不逐 case 列）；MUST case_id 与目录名一致（同 AT 规则）；MUST stub 声明含 [llm] 的 case 在 setup 加建 session 的 requests step | PRD §2.4 旧→新映射; case-inventory.md | +41 文件 |
| testing | tests/e2e/<module>/<case>/test_case.md | 文档 | 新增/修改 | 每 case 配 test_case.md（描述 + testid 契约引用 + 视觉保真声明）；从组件 spec 读 testid | MUST testid 从 specs/ui/components/ 读（不扒代码）；MUST 有设计稿的 case 填 compares[] | e2e-test-designer skill | +41 文件 |

---

## 迁移策略规则（非逐 case 列，给 designer 用）

1. **action 字符串 → step 类型映射**（PRD §2.4 已列）：`goto:` → `navigate`；`click:` → `click`；`type:` → `type`；`press:` → `press`；`hover:` → `hover`；`drag:` → `drag`；`js:` → 拆为 requests/click/type/wait/poll，无法拆保 `js_eval`。
2. **wait_ms 字段 → 框架 auto-wait**：删显式 wait_ms；step 内置 Playwright auto-wait。
3. **dom_asserts → check 数组**：保持原子断言语义；selector 改用 testid 简写（`testid:X` → `[data-testid="X"]`）。
4. **vision_checks → vision_check step（按需）**：纯功能 case 不写 vision（v0.0.100 dom 主判定模型）；仅视觉呈现无法 dom 断言或设计稿保真时写。
5. **compares[] → 顶层 compares 字段**：结构不变（design/impl/checks），run_all 自动跑 vision_check.py compare。
6. **顶层 llm: replay/record/off/mock → MODE=record|replay|live 外部传**：case.yaml 不写 mode（MODE 归执行层，对齐 AT）。
7. **stub 声明**：case 含 LLM 调用 → `stub:[llm]`；含 API 请求 → `stub:[http]`；订阅 SSE → `stub:[sse]`；可多通道共存 `stub:[llm,http,sse]`。
8. **setup/teardown 只用 AT step**：建 session 用 `requests: ['POST /session {...}']` + `save: {sid: .id}`；删 session 用 `requests: ['DELETE /session/{sid}']`。
9. **SSE 等待**：旧 `js:fetch+轮询` 拆为 `sse.sub` + `wait`（条件：`<stream>.count(type=X) >= N`）；禁显式 sleep。
10. **合并规则**：approval allow+deny → 单 case 双 session 并行（setup 建 2 session + steps 内两路断言）；enqueue 2→1（同队列渲染）。
11. **弃置规则**：纯视觉对齐类（studio_sidebar_visual_align_tc1）转 selftest 或 compares[]-only case（不入版本白名单）。

---

## 文件级变更清单（汇总 roll-up）

### 新增文件（18 个）

| 文件 | 用途 |
|------|------|
| app/server/src/testing/http-route-interceptor.ts | server 入站 HTTP 拦截器（record/replay） |
| app/server/src/testing/sse-interceptor.ts | SSE 流录制/保真回放 |
| tests/e2e/lib/case_loader.py | ET case.yaml 加载 + 校验 |
| tests/e2e/lib/step_exec.py | ET step 执行器（Playwright 动作分发） |
| tests/e2e/lib/run_case.py | ET 单 case 入口（启 browser + 编排） |
| tests/e2e/lib/check_engine_et_ext.py | ET dom 断言扩展 |
| tests/e2e/lib/selftest/run_selftest.py | ET selftest 入口 |
| tests/e2e/lib/selftest/test_case_loader.py | case_loader UT |
| tests/e2e/lib/selftest/test_step_exec.py | step_exec UT |
| tests/e2e/lib/selftest/test_check_engine_et.py | check_engine_et UT |
| tests/e2e/<module>/<case>/case.yaml × ~41 | 新 case 文件 |

### 修改文件（10 个）

| 文件 | 改动概述 |
|------|---------|
| app/server/src/testing/types.ts | StubPoint 扩 5 值 + 新 HttpRecording/SseEventRecord/SseStreamRecording interface |
| app/server/src/testing/recording-codec.ts | pointBufferMap/flushAllPoints/loadReplaySetByPoint/redact 扩 http/sse |
| app/server/src/testing/record-replay-registry.ts | channelReplaySets 加 http/sse + matchHttpReplay/matchSseReplay/appendHttpRecording/appendSseRecording + 游标管理 |
| app/server/src/testing/stub-handler.ts | VALID_STUB_POINTS 错误消息更新（值域已自动扩展） |
| app/server/src/router.ts | dispatchRequestInternal 加 interceptHttpRequest 调用 + SSE channel 包装（净增 ≤20 行） |
| tests/e2e/lib/run_all.sh | 扫 case.yaml（替 checkpoint.json）+ MODE env + ET_REPLAY_FAST 透传 |
| tests/e2e/lib/_run_compares.py | 适配新 last_run/ 截图路径 |
| tests/e2e/env_start.sh | env 透传（NODE_ENV=test + ET_REPLAY_FAST） |
| tests/e2e/<module>/<case>/test_case.md × ~41 | case 文档 |

### 删除文件（48 个）

| 文件 | 原因 |
|------|------|
| tests/e2e/lib/run_case.sh | 旧框架入口，被 run_case.py 取代 |
| tests/e2e/lib/runner.py | 旧 Playwright 执行器，被 run_case.py + step_exec.py 取代 |
| tests/e2e/<module>/<case>/checkpoint.json × 46 | 旧 case 格式，被 case.yaml 取代（迁移完成后删） |

---

## 不变的核心 invariants（coder 不可偏离）

1. **StubPoint 闭合性**：types.ts 的 StubPoint 类型 + STUB_POINTS 常量是单一权威；任何 `Record<StubPoint,...>` / `Set<StubPoint>` 自动覆盖 5 值（v0.0.68 教训）。
2. **FAIL 绝不落盘**：record 轮 case fail 时 clearBuffer 不 flush（record-replay.md §3.3）；http/sse 通道同规则（appendHttpRecording/appendSseRecording 只写内存 buffer，commitIfPassed(passed=false) 时 clear）。
3. **/test/* 不被 stub**：http-route-interceptor 顶部排除 /test/* 路径（避免 stub 协议自被拦导致死锁）。
4. **静态资源白名单透传**：replay 模式下 `/`、`/assets/*`、`/index.html`、`/vite/*`、`/favicon.ico`、`/health` 强制透传（浏览器加载资源不阻塞）。
5. **AT 透明兼容**：扩展是加性的，AT case.yaml 仍只写 `stub:[llm]`，AT run_all 不受影响，AT selftest 不涉及 http/sse。
6. **dom 主判定**：ET 功能验证以 dom 断言为主（v0.0.100 模型），vision_check 按需（不强制默认）；hard_fail=0 才能合并。
7. **MODE 归执行层**：ET case.yaml 不写 mode（外部 MODE=record|replay|live 传入），与 AT 一致。
8. **router.ts 净增 ≤20 行**：仅拦截器入口调用 + 注释，不引入 Hono / app.use。
9. **router.ts dispatchRequestInternal 函数式分发不变**：http-route-interceptor 是纯函数（不是 middleware），返 Response|null。
10. **SSE 协议是 fan-out（GET /sse + POST /sse/subscribe）**：sse-interceptor 包装 writeFrame + subscribe，不引入 `/sse/:topic/:group` 路径（与实际代码对齐）。

---

## 待 orchestrator 裁决项（architect 提请）

1. **PRD/research 的 SSE 描述偏差**：PRD §2.2 + research 都写 `/sse/:topic/:group`，实际是 `GET /sse` + `POST /sse/subscribe`。建议 doc-modifier 阶段 5 同步 PRD/research 描述对齐到代码（本计划书已按实际写 sse-interceptor，coder 按本计划书实现）。
2. **router.ts 是函数式 dispatch（非 Hono）**：research 的 `installHttpInterceptor(app, registry)` 伪代码不适配。本计划书改为纯函数 `interceptHttpRequest`，coder 按此实现。建议 doc-modifier 同步 research 描述。
3. **case 全量迁移由 designer 阶段做**：本计划书只记迁移策略规则（D 组），不逐 case 列。designer 按 PRD §2.4 + case-inventory.md + 本计划书迁移策略规则逐 case 迁移。如 designer 阶段发现规则有 gap，提 change_plan 偏离。
4. **POST /sse/subscribe 录制时机**：record 模式下，订阅登记本身是不是「http 通道」的一次调用（应 appendHttpRecording）？还是 sse 通道的元事件？architect 倾向：**POST /sse/subscribe 走 http 通道录制**（它是 HTTP API 调用），**writeFrame 的帧序列走 sse 通道录制**（分属不同通道，不混淆）。coder 按此实现。
5. **ET case timeout 上限**：AT 是 60s（case_loader 校验），ET 含浏览器启动建议放宽到 300s。PRD §2.1 step 内 wait/poll 上限 60s 不变（仅 case 总 timeout 放宽）。
