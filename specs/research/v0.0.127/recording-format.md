---
title: 调研 3 — 录制格式设计
type: research-finding
feature: et_refactor
updated: 2026-07-13
---

# 调研 3：录制格式（API 请求-响应 + SSE 事件序列）

## 设计原则

**与 AT recordings/ 对齐**——同一 codec 库、同一目录结构、同一 manifest 字段，只是通道扩展（AT = llm/web_search/web_fetch 出站；ET 加 http/sse 入站）。

## AT 现有 recordings/ 格式（参考基准）

来源：`tests/api/approval/approval_allow_deny/recordings/`

```
recordings/
├── manifest.json    # 元信息：case_id / recorded_at / provider / model / llm_calls / fingerprint
└── llm.jsonl        # 每行一个 LLM 调用记录（seq / session_hint / fingerprint / request_meta / response）
```

### manifest.json 结构（来自 AT）

```json
{
  "case_id": "approval_allow_deny",
  "recorded_at": "2026-07-12T12:07:52.376Z",
  "provider": "unknown",
  "model": "unknown",
  "llm_calls": 5,
  "fingerprint": {
    "system_prompt_hash": "",
    "tools_schema_hash": "",
    "model": "unknown"
  }
}
```

### llm.jsonl 每行结构（来自 AT，seq=0 第一行节录）

```json
{
  "seq": 0,
  "session_hint": "_default",
  "fingerprint": {
    "system_prompt_hash": "sha256:e3b0c44...",
    "tools_schema_hash": "sha256:72e66dab...",
    "model": "MiniMax-M3"
  },
  "request_meta": {
    "stream": true,
    "model": "MiniMax-M3",
    "message_count": 1
  },
  "response": {
    "kind": "sse",
    "status": 200,
    "sse_frames": [
      "event: message_start\ndata: {...}\n\n",
      "event: ping\ndata: {...}\n\n",
      "event: content_block_delta\ndata: {...}\n\n"
    ]
  }
}
```

**关键设计**：
- `seq`：本通道内调用序号（0,1,2,...），replay 按 seq 顺序匹配
- `session_hint`：会话隔离键（多 session 并发场景）
- `fingerprint`：录制指纹（用于 drift 检测——replay 时 fingerprint 不匹配则报 drift）
- `response.sse_frames`：SSE 帧数组（字符串，每帧含 `event:` + `data:` + 空行）

## ET 扩展设计（新增 http / sse 两通道）

### 目录结构

```
recordings/
├── manifest.json    # 扩展：加 http_calls / sse_streams 字段
├── llm.jsonl        # AT 已有（server 出站 LLM 调用，ET 也走同款）
├── http.jsonl       # 新增：浏览器→server 的 API 请求-响应
└── sse.jsonl        # 新增：浏览器←server 的 SSE 事件流
```

### manifest.json 扩展

```json
{
  "case_id": "chat_basic_tc1",
  "recorded_at": "2026-07-13T10:00:00.000Z",
  "provider": "unknown",
  "model": "unknown",
  "llm_calls": 1,
  "http_calls": 4,        // 新增：API 请求数
  "sse_streams": 2,       // 新增：SSE 流数
  "fingerprint": {        // AT 同款（LLM 指纹）
    "system_prompt_hash": "",
    "tools_schema_hash": "",
    "model": "unknown"
  },
  "et_fingerprint": {     // 新增：ET 入站请求指纹（可选，用于 drift）
    "ui_version": "0.0.127",
    "case_yaml_hash": "sha256:..."
  }
}
```

### http.jsonl 每行结构

```json
{
  "seq": 0,
  "api": "POST /session/{sid}/messages",
  "api_normalized": "POST /session/*/messages",
  "request": {
    "method": "POST",
    "path": "/session/01KXYZ/messages",
    "query": {},
    "headers": { "content-type": "application/json" },
    "body": { "content": "你好", "providerId": "01KV...", "modelId": "MiniMax-M3" }
  },
  "response": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": { "runId": "01KAB...", "state": "running" }
  },
  "elapsed_ms": 42
}
```

**字段说明**：
- `seq`：本通道（http）内调用序号；replay 按 seq 匹配
- `api`：原始路径（含具体 ID，便于调试）
- `api_normalized`：路径模板（`*` 替代 ID），用于 replay 匹配
- `request.body` / `response.body`：JSON 对象（非字符串，便于 diff）
- `elapsed_ms`：耗时（用于回放时序还原，可选）

### sse.jsonl 每行结构

```json
{
  "seq": 0,
  "api": "GET /sse/agent_loop/session_id:01KXYZ_amt:current",
  "api_normalized": "GET /sse/agent_loop/session_id:*",
  "subscription": { "topic": "agent_loop", "group": "session_id:01KXYZ_amt:current" },
  "events": [
    { "type": "agent_state", "data": { "state": "running" }, "delay_ms": 120 },
    { "type": "message_chunk", "data": { "delta": "你好" }, "delay_ms": 350 },
    { "type": "message_chunk", "data": { "delta": "！" }, "delay_ms": 80 },
    { "type": "run_stop", "data": { "reason": "end_turn" }, "delay_ms": 50 }
  ],
  "total_events": 4,
  "duration_ms": 600
}
```

**字段说明**：
- `seq`：本通道（sse）内流序号（不同订阅各自独立 seq）
- `events[].delay_ms`：本帧相对上一帧的延迟（用于回放时序保真）
- `events[].type` / `data`：SSE 事件的 type 和 data（不是原始字符串，结构化便于 diff）
- `duration_ms`：整流时长（用于回放整体节奏控制）

## replay 匹配策略（req 决策 5：api + seq）

### 匹配键

**`api_normalized + seq`** 双键：

1. **api_normalized**：路径模板（`POST /session/*/messages`）—— 同一 API 的多次调用归一组
2. **seq**：组内第几次调用 —— 区分同 API 不同响应（如 session A 的 messages vs session B 的 messages）

### 匹配逻辑伪代码

```python
def match_replay(request, recordings):
    api_norm = normalize_api(request.method, request.path)
    seq = get_next_seq_for(api_norm)  # 递增游标
    key = (api_norm, seq)
    
    recording = recordings.http.get(key)
    if not recording:
        raise UndeclaredStubError(f"no recording for {api_norm} seq={seq}")
    
    # 可选：fingerprint 校验（body hash 不匹配 → drift）
    if fingerprint_mismatch(request.body, recording.request.body):
        return DriftResult(recording, drift_reason="body_hash_mismatch")
    
    return ReplayResult(recording.response)
```

### SSE 流匹配

SSE 的「调用」是订阅建立（`GET /sse/:topic/:group`）。匹配键：
- `api_normalized` = `GET /sse/{topic}/session_id:*`（topic 是路径一部分）
- `seq` = 同 topic+group 组合的第几次订阅

回放时按 `events[].delay_ms` 还原时序（见下）。

## 时序还原策略

### 两种模式（PRD 决策点）

**模式 A：保真回放（推荐）**——按 `delay_ms` 还原时序

```python
def replay_sse(recording, response_writer):
    response_writer.write_header('content-type', 'text/event-stream')
    for event in recording.events:
        sleep(event.delay_ms / 1000.0)
        response_writer.write_chunk(f"event: {event.type}\ndata: {json.dumps(event.data)}\n\n")
        response_writer.flush()
    response_writer.close()
```

优点：真实模拟 SSE 流式（前端 EventSource onmessage 触发多次）；UI 渲染行为与真跑一致。
缺点：慢（要等所有 delay 累加；典型 SSE 流 3-10s）。

**模式 B：即时回放**——不 sleep，全部帧一次性 write

优点：快（毫秒级）；缺点：UI 渲染时序与真跑不同（可能掩盖竞态 bug）。

**建议**：默认 A（保真），提供 `ET_REPLAY_FAST=1` 环境变量切换 B（用于快速 smoke）。

### 时序漂移容忍

录制时 `delay_ms` 可能有抖动（如某帧 delay=2000ms 是因 server 处理慢）。回放时设上限：

```python
delay = min(event.delay_ms, MAX_DELAY_MS)  # 默认 MAX_DELAY_MS=5000
```

避免单帧异常 delay 拖垮整个 case。

## 与 AT 共用的 codec 库

**`recording-codec.ts` 扩展**（参考 `app/server/src/testing/record-replay-registry.ts:16-18` 已 import 的 `appendRecording/clearBuffer/flushAllPoints/loadReplaySet`）：

新增对 `http` / `sse` 通道的支持：
- `appendRecording(point: 'http' | 'sse', rec)`：追加到 buffer
- `loadReplaySetByPoint('http' | 'sse', dir)`：从 jsonl 加载到 Map
- `flushAllPoints` 扩展支持 http/sse 落盘

`StubPoint` 类型扩展（`app/server/src/testing/types.ts`）：

```typescript
// 现有（AT）
export type StubPoint = 'llm' | 'web_search' | 'web_fetch';
// 扩展（ET）
export type StubPoint = 'llm' | 'web_search' | 'web_fetch' | 'http' | 'sse';
```

## stub 协议扩展（与 AT 一致）

ET case.yaml 顶层声明 stub（同 AT）：

```yaml
case: chat_basic_tc1
module: chat
timeout: 60

setup:
  - name: 建 session
    stub: [http]              # 声明本 step 会触发 http stub 命中
    requests:
      - 'POST /session {"title": "..."}'
    save: { sid: .id }

steps:
  - name: 发消息（触发 LLM）
    stub: [llm, http, sse]    # 本 step 触发三个 stub 通道
    requests:
      - method: POST
        path: /session/{sid}/messages
        body: { content: "你好" }
    sse:
      sub:
        - { topic: agent_loop, group: "session_id:{sid}_amt:current", as: loop }
    check:
      - loop.count(type=run_stop) >= 1
```

`stub_client.py` 扩展（参考 `tests/api/lib/stub_client.py:34-47` 现有 set_case/set_step/commit）：同协议，无需新增端点（`/test/stub` 已支持 declared 数组，只是值域扩展）。

## 录制器（record 模式）实现位置

**server 内拦截器**（A 方案）：
- `app/server/src/testing/server-route-interceptor.ts`（新增）：在 router.ts 入口处包装 handler，录制 http 请求/响应
- `app/server/src/testing/sse-interceptor.ts`（新增）：在 SSE 端点 response.write 处录制帧序列

详细见 `server-stub-extension.md`。

## 边界

- `delay_ms` 精度：Node `setTimeout` 不保证 ms 精度（事件循环 busy 时偏大）；建议容忍 ±20% 偏差
- SSE 心跳帧（`event: ping`）：录制时保留，回放时是否发？默认保（前端可能依赖心跳判活）
- 大 body 截断：LLM 长 transcript 可能 MB 级；建议 body > 100KB 时单独存 `bodies/NN.json` 文件，jsonl 只存 hash 引用
- 多 session 并发：seq 匹配需按 session_hint 分组（AT 已用 ALS 实现，ET 复用）
