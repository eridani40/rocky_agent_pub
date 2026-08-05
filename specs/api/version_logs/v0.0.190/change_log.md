# v0.0.190 — API 变更

> 版本类型：纯测试基建（AT 去 record/replay）。生产 API 契约零变更——删除的端点全部 `NODE_ENV=test` 门控，prod 永不暴露。overall 同步：`04-agent-session.md` §13（v2.4）。

## 删除：`POST /test/llm-mode` + `POST /test/llm-mode/commit`（test-only）

**背景**：AT（tests/api）从 record/replay stub 范式整体重构为真实调 API（对齐 ET v0.0.188「不录制不回放真调 LLM」；维护成本不可持续——v0.0.131 实证 team 工具加 4 个 action 引发 28+ case 重录一整天）。record/replay 的服务端基建 `app/server/src/testing/` 整目录删除，这两个 per-case LLM 模式切换 / commit flush 端点随之失去存在意义。

| 删除端点 | 原语义 | 删除落点 |
|---|---|---|
| `POST /test/llm-mode` | 设 `RecordReplayRegistry.activeCase`（per-case 覆盖 + 重置游标） | `misc-routes.ts` 路由块 + `testing/test-llm-mode-handler.ts` 整文件 |
| `POST /test/llm-mode/commit` | pass=true → flush recordings + captureGolden；false → 丢弃 buffer | 同上 |
| `/test/stub` + `/test/stub/step` + `/test/stub/commit`（从未进 overall 契约） | case 级 / step 级 stub 声明 + PASS 落盘 | `misc-routes.ts` 路由块 + `testing/stub-handler.ts` 整文件 |

**同步删除的 test-only 接线（prod 行为零变化，全部 NODE_ENV=test 门控）**：`router.ts` interceptHttpRequest/recordHttpResponse 分支、`bootstrap-bus-phase.ts` installSseTestInterceptor、`llm-client-factory.ts` recordReplayFetch 分支、`jina-fetcher.ts` pickWebFetchFetch 分支、`sse-channel.ts` setTestInterceptor + testInterceptor 三处分支、`event-bus.ts` subscribe skipReplayHistory opt。

## 保留（test-only，不动）

- `POST /test/consolidation/run` — t2_daily_consolidation AT case 依赖（契约见 `../v0.0.151.t2_consolidate/change_log.md`，已补登 `04-agent-session.md` §13.1）
- `ROCKY_TEST_MOCK_LLM=1` mock fetch 路径 — computer_use case 依赖（非 HTTP 端点，env 开关）

## method 级契约

`specs/tech/version_logs/v0.0.190/change_plan.md`（A-F 6 节 8 列表）。
