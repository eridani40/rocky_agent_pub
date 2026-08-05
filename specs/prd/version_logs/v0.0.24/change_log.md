# v0.0.24 PRD 变更日志 — langfuse 会话内容/结果验证 oracle

## 概述

本版本交付一个**验证能力增强**（非新用户功能）：把 langfuse observability 从「观测管道验证」（trace 通不通）升级为「**会话内容/结果的独立验证 oracle**」——让 api verifier 能独立断言「agent 真的对了吗」，而不只是「agent 跑了吗」。

不动 app 源码（observability adapter v0.0.10 已够用），所有产物落在验证工具链（lib / 用例 / skill / 流程文档）。

| 交付项 | 一句话定位 | v0.0.24 范围 |
|------|-----------|-------------|
| **langfuse 验证 oracle 方法论** | api verifier 读 langfuse trace 作「内容/结果独立 oracle」 | 新 skill `.claude/skills/langfuse-verification/`（oracle 三类 + langfuse API 参考 + 真实 model id） |
| **可复用验证库** | 把 trace 读取/断言/provider 解析抽公共 | `tests/api/lib/langfuse_verify.py` + `provider_resolve.py` + `langfuse_setup.sh` |
| **三类 oracle 用例** | 内容一致性 / 工具结果保真 / 多轮 generation | `langfuse_session_content_tc1` / `langfuse_tool_result_tc1` / `langfuse_multi_turn_tc1`（+ tc1 重构复用 lib） |
| **流程增强** | api/e2e verifier 嵌入 langfuse 交叉验证 | `api-verifier.md` + api-testing skill + `e2e-verifier.md` + e2e-testing-vision skill |

权威输入：`reqs/v0.0.24/reqs.md`；状态：`states/v0.0.24/{task-board.md, verify/api-test/report.md}`。

---

## 1. 用户原话与产品定位

### 1.1 用户原话要点

- langfuse 配置一直开着（test.env `LANGFUSE_*`），**丰富 api 验证时的可验证能力**，**尤其是 session 对话内容和结果的验证**。
- 流程：通过 api 新建 session → 发起 query → event 结束后调 langfuse api 读相关 trace 信息。
- **走通流程 → 形成 skill**，并在 **api verifier 里写清楚**。
- **新增包含一定这种 case**；model 配置**记录 provider/model id 写到 case 里**；e2e 也提醒做完工作检查 trace。

### 1.2 产品定位

| 维度 | v0.0.10（既有） | v0.0.24（本版新增） |
|------|----------------|---------------------|
| langfuse 角色 | 观测 backend（运维/成本） | 观测 backend **+ 验证 oracle** |
| 「验证」断言 | trace 存在 = 管道通 | trace.output == session assistant message（**内容对不对**）/ tool span.result == 落盘文件（**结果真不真**）/ 多轮各 ≥1 generation（**轮次记全没**） |
| 用例口径 | `langfuse_trace_tc1`：真 LLM 写 proof.txt → 断管道 | + 3 oracle 用例断内容/结果/多轮 |
| 适用场景 | 任何带 observability 的版本回归 | agent 行为正确性验证（替代/补充「只看 HTTP 200」） |

---

## 2. 关键用户路径（= 测试最低覆盖要求）

| # | 路径 | 覆盖用例 | oracle 类 |
|---|------|---------|-----------|
| 1 | 建 session → 发 query（纯文本回复）→ 读 trace 验内容一致性 | `langfuse_session_content_tc1` | **内容一致性**：`GET /session/:id/messages` 的 assistant 回复（含 proof token）与 `trace.output` 一致 |
| 2 | 发 query（LLM 返回工具调用）→ 工具执行落盘 → 读 tool span 验结果保真 | `langfuse_tool_result_tc1` | **工具结果保真**：`tool span.arguments/output` 与真实落盘文件内容一致 |
| 3 | 多轮对话 → 读多 trace 验多轮 generation 记录 | `langfuse_multi_turn_tc1` | **多轮 generation**：两轮独立 trace、sessionId 贯穿、各轮 ≥1 generation、轮2 tool span 含 token |
| 4 | observability 管道完整性（回归） | `langfuse_trace_tc1`（重构） | trace.id==runId / generation usage / tool span args+result / trace input+output（14 项断言） |

---

## 3. 范围

### 3.1 IN

1. **新 skill** `.claude/skills/langfuse-verification/`：oracle 方法论（内容一致性/工具结果保真/多轮三类）+ langfuse REST API 参考（15 真实 API）+ 真实 model id（test env 固化）。
2. **新 lib** `tests/api/lib/langfuse_verify.py`（trace 读取/断言 helper）+ `provider_resolve.py`（解析真实 data.id）+ `langfuse_setup.sh`（observability 自保幂等）。
3. **3 新用例** + tc1 重构复用 lib（`tests/api/observability/langfuse_{session_content,tool_result,multi_turn}_tc1`）。
4. **流程增强**：`api-verifier.md` + `api-testing` skill 增「langfuse 交叉验证」步骤；`e2e-verifier.md` + `e2e-testing-vision` skill 增「工作做完检查 trace」提醒。

### 3.2 OUT（NON-GOALS）

| 排除项 | 理由 |
|--------|------|
| **不动 app 源码** | adapter v0.0.10 + manager v0.0.11 已足够支撑「读 trace 验内容」；改 app 不增值且扩大回归面 |
| **不新增 e2e 用例** | langfuse 是 server-side 概念，e2e 截图判定不到 trace；仅 e2e-verifier skill 加提醒 |
| **无设计稿** | 纯验证工具链增强，无 UI 改动 → 视觉保真度门禁跳过 |
| **不验证 langfuse UI** | 用例经 langfuse REST API 读 trace，不依赖 langfuse web UI |
| **不抽象非 langfuse backend 的 oracle** | v0.0.11 仅 langfuse type；OTel/其他 backend 的 oracle 抽象延后 |

---

## 4. 验证结论

4 用例（3 新 oracle + tc1 重构）在**真 langfuse（localhost:3000）+ 真 LLM（MiniMax-M3）** 下全 PASS：

| 用例 | 结果 | checks |
|------|------|--------|
| `langfuse_trace_tc1` | PASS | 14/14 |
| `langfuse_session_content_tc1` | PASS | 7/7 |
| `langfuse_tool_result_tc1` | PASS | 9/9 |
| `langfuse_multi_turn_tc1` | PASS | 16/16 |

详见 `states/v0.0.24/verify/api-test/report.md`。技术权威源：`specs/tech/version_logs/v0.0.24/change_log.md`。

---

## 5. 版本

v0.0.24（langfuse 验证 oracle — observability 从「观测管道验证」升级为「会话内容/结果独立验证 oracle」；不动 app 源码，产物全在验证工具链：skill + lib + 3 用例 + tc1 重构 + api/e2e verifier 流程增强）
