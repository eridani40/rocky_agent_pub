---
title: 调研 4 — server stub 扩展方案（退 A）
type: research-finding
feature: et_refactor
updated: 2026-07-13
---

# 调研 4：server stub 扩展方案（A 方案）

## 前置：为什么是 A

基建 B 不可行（见 `infrastructure-b-sse-stub.md`），退 A：扩展现有 AT 的 server 内 stub 框架，把拦截点从「出站 fetch（server→LLM）」扩展到「入站 HTTP/SSE（浏览器→server）」。

## 现状：AT 的 stub 框架（出站拦截）

### 三通道架构（v2 重构后）

来源：`app/server/src/testing/record-replay-registry.ts:1-32`

```
StubPoint = 'llm' | 'web_search' | 'web_fetch'   ← 三通道
RecordReplayRegistry
├── activeCase: { caseId, mode, recordingsDir }
├── seq: SeqAllocator                            ← per-point seq 分配
├── channelReplaySets: Map<StubPoint, ReplaySet> ← 每通道独立录制集
├── channelFetchInstances: per-point fetch impl  ← 出站拦截器
├── currentStep: { index, declared: Set<point> } ← step 声明
├── actualHitByStep / declaredByStep             ← audit
└── undeclaredHits                               ← replay 未声明出站检测
```

### 拦截点（出站 fetch）

来源：`app/server/src/testing/record-replay-registry.ts:188-215`

```typescript
// pickChannelFetch：根据 active.mode 返回不同 fetch impl
getOrCreateChannelFetch(point): typeof fetch | null {
  // replay 模式：返回 replay-fetch（从录制读）
  // record 模式：返回 recording-fetch（用真 fetch 录）
}

getChannelRecordingFetch(point): typeof fetch {
  return createRecordingFetch(
    globalThis.fetch,
    () => this.getSessionHint(),
    (hint) => this.getNextSeq(hint, point),
    point,
    (p, rec) => { appendRecording(p, rec); this.recordStubHit(p); },
  );
}
```

接线位置（出站用）：
- `app/server/src/llm-client-factory.ts:27`（grep）：`pickLlmFetch(registry)` 选 LLM 出站 fetch
- `app/server/src/tools/web-fetch/jina-fetcher.ts`：`pickWebFetchFetch(registry)` 选 web_fetch 出站

### stub 协议（HTTP 端点）

来源：`tests/api/lib/stub_client.py:34-47`

```python
POST /test/stub          { case, mode, recordingsDir }   # case 级 set
POST /test/stub/step     { case, step, declared }        # step 边界 + 声明
POST /test/stub/commit   { case, passed }                # PASS 落盘 / FAIL 丢弃
```

handler 位置：`app/server/src/testing/stub-handler.ts`（206 行）

## 扩展方案：入站拦截（ET 用）

### 设计：新增 `http` / `sse` 两通道

`StubPoint` 类型扩展（`app/server/src/testing/types.ts`）：

```typescript
// 现有（AT）
export type StubPoint = 'llm' | 'web_search' | 'web_fetch';
// 扩展后
export type StubPoint = 'llm' | 'web_search' | 'web_fetch' | 'http' | 'sse';
```

`STUB_POINTS` 常量同步加 `'http'` / `'sse'`。

### 入站拦截器（新增 2 个文件）

**1. `app/server/src/testing/http-route-interceptor.ts`**（新增）

在 `router.ts` 入口处包装所有非 `/test/*` 路由：

```typescript
// 伪代码
export function installHttpInterceptor(app: Hono, registry: RecordReplayRegistry) {
  app.use('*', async (c, next) => {
    if (!isTestMode()) return next();
    const active = registry.getActiveCase();
    if (!active) return next();
    
    const api_norm = normalizeApi(c.req.method, c.req.path);
    
    if (active.mode === 'replay') {
      // 从录制读响应
      const recording = registry.matchHttpReplay(api_norm);
      if (recording) {
        registry.recordStubHit('http');
        return c.json(recording.response.body, recording.response.status);
      }
      // 未匹配 → 透传（让 handler 处理）or 报 undeclared
      // 策略：未声明的 http 请求默认透传（避免误杀非 stub 的静态资源等）
      return next();
    }
    
    if (active.mode === 'record') {
      // 透传真 handler，录制响应
      await next();
      const body = await c.res.text();
      registry.appendHttpRecording({
        seq: registry.getNextSeq(sessionHint, 'http'),
        api: c.req.path,
        api_normalized: api_norm,
        request: { method, path, body: c.req.json() },
        response: { status: c.res.status, body: JSON.parse(body) },
      });
      registry.recordStubHit('http');
    }
  });
}
```

**2. `app/server/src/testing/sse-interceptor.ts`**（新增）

SSE 端点（`/sse/:topic/:group`）在 replay 模式下读录制帧序列并按时序 write：

```typescript
// 伪代码
export function wrapSseHandler(originalHandler, registry) {
  return async (c) => {
    if (!isTestMode()) return originalHandler(c);
    const active = registry.getActiveCase();
    if (!active || active.mode !== 'replay') {
      // record/off 模式：透传真 handler（record 在 response.write 处录制）
      return recordSseStream(originalHandler(c), registry);
    }
    
    // replay：从录制读帧序列
    const topic = c.req.param('topic');
    const group = c.req.param('group');
    const api_norm = `GET /sse/${topic}/*`;
    const recording = registry.matchSseReplay(api_norm);
    if (!recording) return c.text('no recording', 404);
    
    registry.recordStubHit('sse');
    
    // 流式回放
    return streamSSE(c, async (stream) => {
      for (const event of recording.events) {
        await sleep(min(event.delay_ms, MAX_DELAY_MS));
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
      }
    });
  };
}
```

### record 模式 SSE 录制

SSE 在 record 模式下不能直接透传（要录帧序列）。需包装 response.write：

```typescript
async function recordSseStream(stream, registry) {
  const recorder = {
    events: [],
    last_ts: Date.now(),
    writeSSE: async (msg) => {
      const now = Date.now();
      recorder.events.push({
        type: msg.event,
        data: JSON.parse(msg.data),
        delay_ms: now - recorder.last_ts,
      });
      recorder.last_ts = now;
      await stream.writeSSE(msg);  // 透传给浏览器
    },
  };
  await originalHandler({ ...c, stream: recorder });
  // 结束后落盘
  registry.appendSseRecording({
    seq: registry.getNextSeq(sessionHint, 'sse'),
    api, api_normalized,
    events: recorder.events,
  });
}
```

### router.ts 接线

`app/server/src/router.ts`（grep 命中 `test/stub`）在 test 模式下安装拦截器：

```typescript
// 伪代码（router.ts 启动期）
if (process.env.NODE_ENV === 'test') {
  const registry = getRegistry();
  if (registry) {
    installHttpInterceptor(app, registry);
    wrapSseRoutes(app, registry, sseHandlerMap);
  }
}
```

**注意**：拦截器必须在所有业务路由注册**之前**装（保证匹配顺序）；`/test/*` 路由要排除（否则 stub 协议自己也被拦）。

## stub 协议：是否需新增端点

**结论：不需要**。现有 `/test/stub` + `/test/stub/step` + `/test/stub/commit` 已够用：

- `declared: ['http', 'sse']` 已支持（StubPoint 扩展后值域自动接受）
- `audit` 机制（hit_not_declared / declared_not_hit）天然适用 http/sse

ET 的 `stub_client.py` 与 AT 共用，不新增 HTTP 调用。

## ET case.yaml stub 声明样例

```yaml
case: chat_basic_tc1
module: chat
timeout: 60

setup:
  - name: 建 session
    stub: [http]                    # 仅 http 通道
    requests:
      - 'POST /session {...}'
    save: { sid: .id }

steps:
  - name: 发消息 + 订阅 SSE
    stub: [llm, http, sse]          # 三通道并发
    requests:
      - method: POST
        path: /session/{sid}/messages
        body: { content: "你好" }
    sse:
      sub:
        - { topic: agent_loop, group: "session_id:{sid}_amt:current", as: loop }
    check:
      - loop.count(type=run_stop) >= 1

teardown:
  - name: 删 session
    stub: [http]
    requests:
      - 'DELETE /session/{sid}'
```

## audit 语义对齐

AT 的 audit（`record-replay-registry.ts:110-128`）：
- `declared_not_hit`：声明了但没命中（过度声明）→ record 轮提示但不 fail（并发场景容忍）
- `hit_not_declared`：命中了但没声明（漏声明 = 录制盲点）→ record 轮判 fail

ET 扩展后语义一致：
- ET case 漏声明某 API → record 轮该 step `hit_not_declared` 含 http → fail（强制补全 stub 声明）
- ET case 声明了但浏览器没触发 → `declared_not_hit` → 宽松（可能 UI 分支未走到）

## 与 AT 的兼容性

**关键不变量**：扩展是**加性**的，不破坏 AT 现有行为。

- `StubPoint` 加值：AT 的 case.yaml 仍只写 `stub: [llm]`，http/sse 通道对 AT 透明（AT 不走浏览器，无入站 HTTP/SSE 要 stub）
- registry 的 `channelReplaySets` / `channelFetchInstances` 扩展为 5 通道（Map 加两个 key）
- `recording-codec.ts` 的 `appendRecording` / `loadReplaySetByPoint` 扩展支持 http/sse（按 point 分流，互不干扰）
- AT 的 selftest（`tests/api/lib/selftest/`）不受影响（不涉及 http/sse 通道）

## 工作量估算

| 改动点 | 文件 | 估算 |
|--------|------|------|
| types 扩展 StubPoint | `app/server/src/testing/types.ts` | 0.5h |
| record-replay-registry 扩展 5 通道 | `record-replay-registry.ts` | 2h |
| http-route-interceptor 新增 | 新文件 | 4h（含 normalize 规则、undeclared 策略、错误处理）|
| sse-interceptor 新增 | 新文件 | 4h（含录制 wrap、replay 时序、心跳处理）|
| router.ts 接线 | `router.ts` | 1h |
| recording-codec 扩展 http/sse | `recording-codec.ts` | 2h |
| ET selftest（stub 框架）| `tests/e2e/lib/selftest/` | 3h |

**总估算**：约 16-20 工时（基建层），不含 ET case.yaml 迁移（见 case-inventory.md，~50-60h）。

## 边界 / 风险

1. **SSE 端点识别**：需在 router.ts 枚举所有 SSE 端点（`/sse/:topic/:group` 等），否则拦截不全。建议统一前缀（`/sse/`）便于匹配
2. **静态资源穿透**：浏览器加载 HTML/JS/CSS 的请求不该被 stub；拦截器要白名单（`/`、`/assets/*`、`/index.html`）
3. **websocket**：项目有 ws 端点（`ws_panel_collapse_tc1` 测 ws）；ws 不在 HTTP stub 范围，需单独处理（或该 case 走 live 模式）
4. **session_hint**：ET 单浏览器场景，session_hint 可固定为 `_default`；多 session case（如 approval_allow_deny）需按 sid 分组
5. **异步时序**：SSE 录制的 `delay_ms` 在 server 高负载时会失真；建议 record 轮标记 server load，replay 时按负载档位选 delay 表
