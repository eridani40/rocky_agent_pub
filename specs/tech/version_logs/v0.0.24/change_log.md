# v0.0.24 技术变更日志 — langfuse 会话内容/结果验证 oracle

> 概述：**验证能力增强**（不动 app 源码）。把 langfuse observability 从「观测管道验证」（trace 通不通）升级为「会话内容/结果的独立验证 oracle」。产物全在验证工具链：① 新 skill `langfuse-verification`（oracle 方法论 + langfuse API 参考 + 真实 model id）；② 新 lib（`langfuse_verify.py` + `provider_resolve.py` + `langfuse_setup.sh`）；③ 3 新 oracle 用例（内容一致性/工具结果保真/多轮 generation）+ `langfuse_trace_tc1` 重构复用 lib；④ api/e2e verifier 流程增强。
> PRD：`specs/prd/version_logs/v0.0.24/change_log.md`；验证报告：`states/v0.0.24/verify/api-test/report.md`。
> 概念权威源：observability 全套（`specs/tech/agent/observability/`）**零改动**——v0.0.24 是「验证工具链增强」，不改 adapter/manager/接口/字段。

## 1. Scope 与口径

**IN SCOPE（v0.0.24 新增/重构）**：

- **langfuse 验证 oracle 方法论 skill**：`.claude/skills/langfuse-verification/`（oracle 三类定义 + langfuse REST API 参考 15 条 + 真实 model id 表）。
- **可复用验证 lib**（`tests/api/lib/`）：
  - `langfuse_verify.py` — trace 读取/字段断言 helper（按 runId/sessionId 取 trace + generation + tool span + input/output）。
  - `provider_resolve.py` — 从本地 provider 配置解析「真实 providerId/modelId」（model 级 mock 判定 + 返回 `data.id`）。
  - `langfuse_setup.sh` — `lf_ensure_observability` 幂等保 observability dev_config 项存在并 enabled（解决「test env 从未配 observability → manager Noop → trace not found」）。
- **3 新 oracle 用例 + tc1 重构**（`tests/api/observability/`）：见 §4。
- **流程增强**：`.claude/agents/api-verifier.md` + `.claude/skills/api-testing/` 增「langfuse 交叉验证」步骤；`.claude/agents/e2e-verifier.md` + `.claude/skills/e2e-testing-vision/` 增「工作做完检查 trace」提醒。

**OUT OF SCOPE**：

| 项 | v0.0.24 状态 |
|----|------------|
| `app/server/src/observability/*`（adapter/manager/types） | **不动**（v0.0.10/v0.0.11 已够用） |
| `agent-loop-observability.ts` 埋点 | **不动** |
| observability overall/adapter/manager spec | **不动**（v0.0.11 准确，仅补「验证 oracle 用法」节，见 §5） |
| e2e 用例 | **不新增**（langfuse 是 server-side，e2e 截图判定不到） |
| 设计稿 | 无（纯工具链） |

## 2. 锁定决策（用户确认）

| # | 决策 | 落地 |
|---|------|------|
| 1 | observability 角色扩展为「验证 oracle」 | skill 定义 oracle 三类（内容一致性/工具结果保真/多轮），不新增 adapter 能力 |
| 2 | oracle 数据源 = langfuse REST API | 经 `/api/public/traces|sessions|observations` 读，不依赖 langfuse web UI |
| 3 | 不动 app 源码 | adapter v0.0.10 已记全量 input/output/metadata/usage（overall §5），足够支撑 oracle |
| 4 | 范围 Comprehensive（3 新用例含多轮 / 6 任务） | session_content + tool_result + multi_turn + tc1 重构 + skill + lib + 流程增强 |

## 3. 关键技术事实（verify 发现，已固化进 spec — CLAUDE.md 原则13）

> 这三条是 verify 真机执行时暴露的 spec/工具链缺口，**必须在 spec 中落准**，否则后续 verifier 会重蹈。

### 3.1 observability 激活 = dev_config 列表（不是 env） ★

**事实**：server 自 v0.0.11 起**不读 `LANGFUSE_*` env**，只读 `dev_config`（group=`runtime`, key=`observability`）的 `ObservabilityConfigItem` 列表（`app/server/src/observability/index.ts:7-10` 注释明确）。列表空/全 disabled → `ObservabilityManager` 持 0 child → 等价 `NoopAdapter`（不记任何 trace）。运行中 PUT dev_config **不热更新**（须重启或下个 session）。

**verify 踩坑**：test env 从未在 dev_config 配 observability（只在 test.env 注 `LANGFUSE_*`），导致 server 全程 Noop，用例报「trace not found」。

**解法**：`langfuse_setup.sh::lf_ensure_observability` 幂等 PUT 一条 enabled observability 项到 dev_config（用例起 server 前自保），test env 已 persist 此项。

**spec 状态**：observability overall §7/§10、langfuse_adapter §2/§3/§8、observability_manager §6/§7、dev_config §3.4.1 + 源码注释**都已准确记录**——v0.0.24 **不修正**，仅在 overall 补「验证 oracle 视角的激活前提」提示（§5）。

### 3.2 providerId = `data.id`（不是文件名） ★

**事实**：`POST /messages` 的 `providerId` = `ProviderInstance.data.id`（providers 组 record 的 `data.id` 字段），**不是 provider 配置文件名**（`record.id` = 文件名去 .json）、**不是 record.key**（虽然常与 data.id 重合）。

**verify 踩坑**：MiniMax 配置文件名 `01KVJMPG2FA9ZSWDND60HV56N2.json`，但 server 认的 `data.id` 是 `01KVJMPG2EZ1078MCT9JH4J5HG`。用例硬编码文件名 → server 报「provider not found」。

**解法**：`provider_resolve.py::resolve_real_provider` 扫 provider 配置返回 `data.id`；4 用例改调它。

**spec 状态**：`llm_model_interface.md §2` 仅说 `providerId → LlmProviderConfig.id`，**未明示 `LlmProviderConfig.id = record.data.id ≠ 文件名`**——v0.0.24 **补注**（§6.1）。

### 3.3 mock 判定须 model 级（不是 provider 级）

**事实**：test env 的 MiniMax provider 同时含真模型 `MiniMax-M3` 和 mock 占位 `mock:tool`。provider 级 `'mock' in str(models)` 判定会把整个 provider 误判为 mock；ark baseUrl 不含 `minimax/anthropic` 也永不被旧启发式选上。

**解法**：`provider_resolve.py::_scan_real_providers` 改 **model 级** 判定（某 modelId 含 `mock` 只跳该 model，不影响同 provider 其他真 model）+ 放宽 real 判定（baseUrl 非空且不含 `mock` / credentials.key 不在 mock 黑名单 / 至少 1 个非 mock model）。

**固化**：仅 lib 实现，不进 spec（属工具链实现细节，非系统概念）。

**test env 真实 provider/model（已固化进 skill + 用例）**：
- MiniMax：`data.id=01KVJMPG2EZ1078MCT9JH4J5HG`，`model=MiniMax-M3`（另含 `mock:tool`，用例 model 级筛掉）
- volcengine(glm)：`data.id=01KVX1JBFHG51E2X0KXPBG9B15`，`model=glm-5.2`

## 4. 文件级变更清单（精确到文件/函数）

### 4.1 新增（验证工具链）

| 文件 | 内容 |
|------|------|
| `.claude/skills/langfuse-verification/SKILL.md` | oracle 三类方法论（内容一致性/工具结果保真/多轮 generation）+ langfuse REST API 参考（15 真实 API：traces/sessions/observations GET + 字段语义）+ 真实 model id 表 |
| `tests/api/lib/langfuse_verify.py` | `fetch_trace_by_runId(runId)` / `fetch_session_traces(sessionId)` / `assert_trace_has_generation(trace)` / `assert_tool_span_matches_file(span, filepath)` / `assert_output_matches_session(trace, sessionMsgs)` 等 helper |
| `tests/api/lib/provider_resolve.py` | `resolve_real_provider(data_dir, prefer_label='minimax') -> (provider_id=data.id, model_id)`；`_scan_real_providers` model 级 mock 判定 |
| `tests/api/lib/langfuse_setup.sh` | `lf_ensure_observability <data_dir>` 幂等 PUT enabled observability 项到 dev_config（保 trace 不 Noop） |
| `tests/api/observability/langfuse_session_content_tc1/` | **内容一致性 oracle**：发 query → SSE 收 → `GET /session/:id/messages` 取 assistant 回复（含 proof token）→ 调 lib 断 `trace.output == assistant`（7 checks） |
| `tests/api/observability/langfuse_tool_result_tc1/` | **工具结果保真 oracle**：发 query 触发 write_file 工具 → 读落盘文件 → 调 lib 断 `tool span.arguments/output == 文件内容`（9 checks） |
| `tests/api/observability/langfuse_multi_turn_tc1/` | **多轮 generation 记录**：连续两轮对话 → 调 lib 断「两轮独立 trace / sessionId 贯穿 / 各 ≥1 generation / 轮2 tool span 含 token」（16 checks） |

### 4.2 重构（复用 lib）

| 文件 | 变更 |
|------|------|
| `tests/api/observability/langfuse_trace_tc1/run.sh` | 内联断言逻辑抽出，改调 `langfuse_verify.py`（统一 `LF_LIB_DIR` env + `sys.path.insert` 加载）；14 项断言全保持 |

### 4.3 流程增强（agent + skill）

| 文件 | 变更 |
|------|------|
| `.claude/agents/api-verifier.md` | 增「langfuse 交叉验证」步骤：API 测完读 trace 验内容/结果一致性（指向 `langfuse-verification` skill） |
| `.claude/skills/api-testing/` | 同上增交叉验证提醒 + 用例选择指引（observability 模块必带 langfuse oracle 用例） |
| `.claude/agents/e2e-verifier.md` | 增「工作做完检查 trace」提醒（E2E 完成后取 runId 查 langfuse 验后端记录完整） |
| `.claude/skills/e2e-testing-vision/` | 同上增 trace 检查提醒 |

### 4.4 配置同步

| 文件 | 变更 |
|------|------|
| test env provider 配置 | dev 环境真实 model 配置复制到 test env（保真 model，**不覆盖 `mock:tool`**——用例 model 级筛） |

## 5. tech spec 同步（overall — 仅补「验证 oracle 视角」，概念零改动）

observability overall/adapter/manager 在 v0.0.11 已准确（见 §3.1），v0.0.24 仅补一节「langfuse 作为验证 oracle 的用法」（见 §6.2）。

## 6. 验证

### 6.1 用例结果（真 langfuse + 真 LLM MiniMax-M3）

| 用例 | checks | 说明 |
|------|--------|------|
| `langfuse_trace_tc1` | 14/14 | 回归：重构复用 lib 后全保 |
| `langfuse_session_content_tc1` | 7/7 | 内容一致性 oracle |
| `langfuse_tool_result_tc1` | 9/9 | 工具结果保真 oracle |
| `langfuse_multi_turn_tc1` | 16/16 | 多轮 generation 记录 |

vitest 1402/1409 通过；7 失败全在 `app/web/.../skill-page/__tests__/`（`vi.mocked(...).mockResolvedValue is not a function`），为 **dev1 既有**，非本版回归（本版未改 TS 源码）。

### 6.2 verify 过程发现并闭环的 6 项问题（详见 report.md §3）

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 用例报 "provider not found" | providerId 应取 `data.id` 非文件名 | 新增 `provider_resolve.py`，4 用例改调 |
| 2 | auto-scan 误判整个 MiniMax mock | provider 级 mock 判定过粗 | 改 model 级判定 + 放宽 real 判定 |
| 3 | heredoc `ModuleNotFoundError: langfuse_verify` | `<<'PY'` 带引号不展开 `$ROOT_DIR` | 改 `export LF_LIB_DIR` + `sys.path.insert(0, env["LF_LIB_DIR"])` |
| 4 | langfuse trace "not found" | server v0.0.11+ 不读 env → Noop | 新增 `langfuse_setup.sh::lf_ensure_observability` 自保 |
| 5 | `sse_assistant_has_token` 误 false | SSE listener 抓 0 字节不可靠 | oracle 源改 `GET /session/:id/messages` |
| 6 | `api_assistant_has_token` 仍 false | GET 响应形状 `{items:[...]}`，parser 不认 | parser 加 `items` key 回退 |

## 7. 版本

v0.0.24（langfuse 验证 oracle — 不动 app 源码；新 skill + lib + 3 oracle 用例 + tc1 重构 + api/e2e verifier 流程增强；固化 3 关键技术事实：observability dev_config 激活 / providerId=data.id / mock 判定 model 级）
