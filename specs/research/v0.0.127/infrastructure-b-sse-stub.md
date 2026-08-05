---
title: 调研 1 — 基建 B SSE stub 可行性
type: research-finding
feature: et_refactor
updated: 2026-07-13
---

# 调研 1：基建 B（Playwright `page.route`/HAR 离线）SSE stub 可行性

## 结论（前置）

**退 A（server 内 stub 扩展）**——基建 B 在 Playwright 原生 `page.route`/HAR 下**无法直接 stub SSE 流式响应**；要做需自定义 route handler 扩展（工作量与 A 相当甚至更高，且偏离 Playwright 主流用法），故建议走 A（server 内 stub 扩展），复用 AT 已落地的 record/replay 基建。

### 三档可行性判定

| 档 | 判定 | 依据 |
|----|------|------|
| ① 原生支持 | ❌ 不可行 | `Route.fulfill` 是一次性响应（body=string/bytes/json/path），不支持流；HAR 规范不含 SSE 流；`routeFromHAR` 录制/回放也不处理流式响应 |
| ② 自定义 route handler 扩展 | ⚠️ 可行但工作量大 | 自己实现「录制 SSE 帧序列 + 时序」+「回放时模拟流式推送」；需在 page.route handler 内构造 ReadableStream + 主动 push 帧；非 Playwright 主流用法 |
| ③ 退 A（server 内 stub） | ✅ 推荐 | 复用 AT 现有 `record-replay-registry.ts`（3 通道：llm/web_search/web_fetch）扩展为 5 通道（加 http/sse），拦截点从出站 fetch 改为入站 HTTP/SSE；与 AT 一致 |

## 调研依据（代码位置）

### 1. Playwright `Route.fulfill` 一次性响应（不支持流）

签名实测（Python sync API，与项目 `tests/e2e/lib/runner.py:54` 用的 `playwright.sync_api` 一致）：

```
Route.fulfill(self, *, status=None, headers=None, body=None,
              json=None, path=None, content_type=None, response=None) -> None
```

`body` 接受 `Union[str, bytes]`——一次性写入，Playwright 内部把整个 body 发给浏览器后立即关闭响应。**无法增量推送帧**，无法模拟 SSE「事件一段段到达」的时序。

文档原文（Route.fulfill docstring 节录）：
> Fulfills route's request with given response.
> body: Union[bytes, str, None] — Response body.

### 2. `routeFromHAR` / `Context.route_from_har` 不处理流式

HAR（HTTP Archive format）规范本身是「单次请求→单次响应」模型，response.content 是完整字符串。SSE 的流式特性（chunked transfer + 事件序列 + 帧间时序）**不在 HAR 规范内**。

实测签名：
```
Context.route_from_har(har, *, url=None, not_found='abort',
                       update=None, update_content=None, update_mode=None)
```

`update=True` 时录制会把响应 body 整体写入 HAR（SSE 也会被压成单一 content），回放时整体返回——**失去时序**，浏览器 EventSource 收到一次性大块而非流式事件，前端订阅逻辑（如 `studio_member_messages_render` 的 SSE 等待）行为与真实场景不一致。

### 3. 现有 ET runner.py 也未用 page.route stub SSE

`tests/e2e/lib/runner.py:135-149` 的 `setup_api_route` 只做 URL 重写（`/api/**` 路径转发到 API server），不是 stub。runner 全程起真 server（`env_start.sh` 启 backend），SSE 流由真 server 产生。

### 4. ET 现有 case 已绕开 SSE 等待难的问题

`tests/e2e/sse_channel/squad_chat_usage_live_tc1/checkpoint.json:40`（line 40 的 `js:` action）与 `tests/e2e/chat/abort_run_finish_tc1/checkpoint.json:41`（step2 内联 JS）的写法是：**在 JS 里直接 fetch API + 内嵌 while-loop 轮询 DOM**，把 API 调用 + SSE 等待 + DOM 断言全塞进一个 JS expression。这是旧框架的 workaround，新框架 case.yaml 的 `requests`/`wait`/`poll` 应把这些拆到 step 层。

### 5. AT 框架已落地的 record/replay 不在浏览器层

AT 的 `record-replay-registry.ts`（294 行）+ `recording-fetch.ts`（199 行）+ `replay-fetch.ts` + `recording-codec.ts` 拦截在 **server 的出站 fetch**（server → LLM/web_search/web_fetch），不在浏览器层。详见：
- `app/server/src/testing/record-replay-registry.ts:188-215`：`getOrCreateChannelFetch` / `getChannelRecordingFetch`（出站拦截器）
- `app/server/src/testing/recording-fetch.ts`：record 轮用真 fetch 录；replay 轮用录制返
- `app/server/src/llm-client-factory.ts:27`（grep 命中）：`pickLlmFetch(registry)` 选 fetch impl

ET 要 stub 的是**浏览器→server 入站**，与 AT 的出站是**两个不同的拦截点**。

## 自定义 route handler 扩展（档②）的可行性深挖

如果坚持 B（不起 server），可做的设计：

```js
// 伪代码：自定义 SSE route handler
page.route('**/sse/**', async (route, request) => {
  const recording = loadRecording(request.url(), request.method());
  if (recording?.kind === 'sse') {
    // 构造 ReadableStream，按录制时序推帧
    const stream = new ReadableStream({
      async start(controller) {
        for (const frame of recording.sse_frames) {
          await sleep(frame.delay_ms);  // 还原时序
          controller.enqueue(new TextEncoder().encode(frame.raw));
        }
        controller.close();
      }
    });
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: stream,  // ⚠️ 关键问题：Playwright Route.fulfill 不接受 ReadableStream
    });
  }
});
```

**关键障碍**：`Route.fulfill` 的 `body` 参数类型是 `Union[str, bytes]`（Python）/ `str | Buffer`（Node），**不接受 ReadableStream**。这意味着档②实际需要：
- 用 CDP（Chrome DevTools Protocol）`Fetch.fulfillRequest` 直接操作底层（绕过 Playwright 抽象）
- 或用 Playwright 的 `page.unroute` + 多次 `page.route` 模拟流（不可靠，时序难控）
- 或改用 Playwright 的 Request/response 拦截 + mock service worker（需要前端配合）

**工作量评估**：CDP 直操 ≈ 重新实现一套 record/replay；估算 1-2 周（含录制器、回放器、时序还原、CDP 错误处理）。**比 A（扩展现有 AT 框架，估算 3-5 天）更重**。

## 为什么建议 A

1. **复用 AT 已验证的基建**：`record-replay-registry.ts` 三通道框架已 57/57 绿、翻车率持续降；扩展加 http/sse 通道是线性扩展（pattern 已固）
2. **一致性**：req 决策 11 要求 AT/ET 共用纯逻辑 lib；A 路径下 ET 直接复用 `recording-codec.ts` / `record-replay-registry.ts` / `stub-client` 协议
3. **SSE 时序保真**：server 内 stub 可在 response 写入时控制 flush 时序（Node http response 可写 `res.write(chunk)` 增量推），保真度高
4. **debug 体验**：server 内 stub 错误栈在 Node（与 AT 同），Playwright 层错误栈在浏览器（跨进程难调）
5. **运行成本**：A 仍需起 server，但 server 是 stub 模式（不调真 LLM，毫秒级），与 AT replay 同档；B 不起 server 但需自建 mock 层，并不省多少

## A 方案的 stub 拦截点（详见 server-stub-extension.md）

ET 走 A 时的链路：
```
浏览器（Playwright）
  ↓ HTTP request（API）
server router.ts 入站拦截器（新增 createServerRouteInterceptor）
  ↓ 命中 stub → 从 recordings 读响应 → 直接返回（replay）
  ↓ 或透传真 handler（record 轮）
```

SSE 的入站 stub：`router.ts` 内的 SSE 端点（如 `/sse/:topic/:group`）在 replay 模式下从录制读帧序列，按 `delay_ms` 增量 write 给浏览器。

## 替代方案备忘（不推荐，仅供决策参考）

- **MSW（Mock Service Worker）**：浏览器内拦截，支持 SSE。但需前端集成（注册 SW），且 MSW 主要面向开发期 mock 不面向录制/回放双关——与 AT 一致性差。**否决**。
- **Polly.js / @pollyjs/core**：录制/回放框架，支持 fetch/XHR，但 SSE 支持弱（同样不处理流式）。**否决**。
- **mitmproxy**：系统级代理，能录 SSE，但需外部进程，CI 集成复杂。**否决**。

## 推荐落地路径

1. PRD 确认退 A（架构期做基建决策，本调研已给依据）
2. 架构期：设计 `createServerRouteInterceptor`（入站拦截，复用 `record-replay-registry` 通道机制）
3. 录制格式（见 `recording-format.md`）：与 AT 一致，manifest.json + jsonl，加 http/sse 通道
4. coder 阶段：先做 server 侧（扩展通道 + 拦截器），再做 ET lib（case.yaml DSL + Playwright step 执行层）

## 边界（本调研未做的）

- 未实际 spike B 方案的 CDP 直操可行性（架构期如有争议再补；当前依据 Playwright API 类型签名 + HAR 规范 + 现有 runner.py 未用 page.route stub 的事实，结论已充分）
- 未对比 MSW/Polly/mitmproxy 的具体 API（已快速排除：与 AT 一致性差，不深挖）
