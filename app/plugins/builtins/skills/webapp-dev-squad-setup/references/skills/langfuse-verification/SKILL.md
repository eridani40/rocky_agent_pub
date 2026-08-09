---
name: langfuse-verification
description: 用 langfuse 作会话内容/结果的独立验证 oracle。当需要交叉核对 API/SSE 返回 == langfuse trace 记录（session 内容一致性、工具调用结果保真、多轮 generation 记录）时使用。api-test-executor / e2e-test-executor 可引用本 skill 补强 oracle 层。真 langfuse + 真 LLM（非 mock），凭证缺失则 clean SKIP。
---

# Langfuse Verification

把「用 langfuse 验证会话内容/结果」沉淀成可复用 oracle 方法论。**独立第二数据源**：agent loop 返回给客户端的内容，必须在 langfuse trace 里找到对等记录，否则视为「报出去的和记下的不一致」。

## 何时用

验证 session 对话内容与结果时——作 **独立 oracle** 交叉核对：
- **session 内容一致性**：API/SSE 返回的 assistant 回答 == `trace.output`
- **工具调用结果保真**：tool SPAN 的 `input.arguments` + `output.result` == 真实落盘/落库的工具产物
- **多轮 generation 记录**：N 轮迭代对应 N 条 GENERATION observation，`metadata.iteration` 递增，末轮 `output` == 最终回答

> 与 `api-testing` skill 关系：`api-testing` 验「接口本身行为」，本 skill 验「同一行为在观测层有等价落盘」。两者**互补**——api-test-executor 跑完接口用例后，可追加 langfuse 交叉验证步骤。

## 前置条件

1. `test.env` 含三项凭证：
   ```
   LANGFUSE_BASE_URL      # 如 http://localhost:3000
   LANGFUSE_PUBLIC_KEY    # pk-lf-...
   LANGFUSE_SECRET_KEY    # sk-lf-...
   ```
2. langfuse 实例可达：`GET /api/public/health` 返回 200
3. test 数据目录（`~/.{APP_NAME}_test`）含**真实（非 mock）provider**——见下方「真实 model id 表」
4. 起 server 时注入 `ROCKY_TEST_MOCK_LLM=0`（禁 mock LLM，否则 trace 是 mock 噪声）
5. **observability 必须在 dev_config (group=runtime, key=observability) 配置 enabled langfuse 项**——server v0.0.11+ **不读 `LANGFUSE_*` env**，只读 dev_config 列表；空/全 disabled → ObservabilityManager Noop，不记 trace，用例全挂。`dev_config_observability_crud_tc1` 会清场（PUT 空列表），故 langfuse 用例须**自保**：起 server 前调 `tests/api/lib/langfuse_setup.sh` 的 `lf_ensure_observability`（幂等，已存在 enabled langfuse → 跳过）。

**缺任何一项 → 用例 exit 0 clean SKIP**（observability 可选），见「skip 语义」。

## 验证流程（step-by-step）

```
1. source test.env + 校验三项凭证齐全        ── 缺 → SKIP
2. curl /api/public/health 探活               ── 不可达 → SKIP
2.5. 确保 observability 配置（用例调 tests/api/lib/langfuse_setup.sh 的 lf_ensure_observability 自保；
     server v0.0.11+ 不读 LANGFUSE_* env，只读 dev_config）
3. 解析真实 provider/model（MINIMAX_* 或自动查首个非 mock）
4. 起 server（注入 LANGFUSE_* + ROCKY_TEST_MOCK_LLM=0）→ 等 /health 200
5. POST /session                        → sessionId
6. POST /sse/subscribe + 后台 curl /sse → 收事件流
7. POST /session/:id/messages           → 返回体取 runId
8. 等 SSE run_end 事件（proof/产物落盘后续轮 LLM + endTrace）
9. sleep ≥12-18s（langfuse SDK flushInterval≈10s，run_end 后留足 18s）
10. 查 langfuse：
      GET /api/public/traces/{runId}                          → trace
      GET /api/public/observations?traceId={runId}&limit=100  → observations
11. 断言（见「记录字段位置表」+ 「判定铁律」）
```

**flush 等待是硬要求**：`endTrace` 走 batch 上报，run_end 后立即查会漏。最少 12s，稳妥 18s。

## langfuse API 参考

**认证**：HTTP Basic Auth，`user=LANGFUSE_PUBLIC_KEY`，`password=LANGFUSE_SECRET_KEY`：
```bash
curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" "$LANGFUSE_BASE_URL/api/public/..."
```

| 端点 | 用途 | 备注 |
|---|---|---|
| `GET /api/public/health` | 探活 | 无需 body，200 即活 |
| `GET /api/public/traces/{runId}` | 取单 trace | **runId 即 trace.id** |
| `GET /api/public/observations?traceId={runId}&limit=100` | 取该 trace 下所有 observation | 响应兼容 `{data:[]}` 与裸 `[]` |

**runId == trace.id（关键不变量）**：`LangfuseAdapter.startTrace` 用 `client.trace({id: p.id})` 显式指定 trace.id = runId。所以拿到 runId 就能直接定位 trace，无需列表搜索。

**observations 响应形状兼容**（不同 langfuse 版本不同）：
```python
obs_raw = resp.json()
obs = obs_raw.get("data", obs_raw) if isinstance(obs_raw, dict) else obs_raw
if isinstance(obs, dict): obs = obs.get("data", [])
```

## 记录字段位置表（LangfuseAdapter 映射）

字段从哪来——查 trace/observation 时按下表定位断言：

| 验证目标 | langfuse 字段 | 产生位置（adapter） |
|---|---|---|
| 触发的用户消息 | `trace.input` | `startTrace`（inbox peek 到的触发消息，list 形态） |
| 最后 assistant 回答 | `trace.output` | `endTrace({output})` |
| 会话归属 | `trace.sessionId` | `startTrace({sessionId})` |
| 模型 id | `trace.metadata.modelId` | `startTrace({metadata})` |
| LLM token 用量 | `GENERATION.usage` | `endGeneration`（`mapUsage`: input/output/total/unit=TOKENS） |
| LLM 模型名 | `GENERATION.model` | `startGeneration({model})` |
| 工具入参 | `SPAN.input.arguments`（name 形如 `tool:xxx`） | `startSpan(ToolSpanStart)` |
| 工具结果 | `SPAN.output` | `endSpan(ToolSpanEnd.output.result)` |
| 工具出错 | `SPAN.level == "ERROR"` | `endSpan`（output.isError=true → level:ERROR） |
| 迭代轮次 | `GENERATION.metadata.iteration` | agent loop 注入，0/1/2 递增 |

> 字段提取助手见 `tests/api/lib/langfuse_verify.py`（Task#1 提供）。trace input/output 存的是 message dict 列表，提取文本需兼容 `content` / `blocks` / 直接 string 三种形态。

## 真实 provider/model id 表（test 环境固化）

验证用例**必须用真实 model**，不接受 mock（含 test 数据目录里的 `mock:tool`）：

| provider(label) | providerId(=data.id) | modelId | baseUrl | 备注 |
|---|---|---|---|---|
| minimax | `01KVJMPG2EZ1078MCT9JH4J5HG` | `MiniMax-M3` | https://api.minimaxi.com/anthropic | 同 provider 另含 `mock:tool`，须选真模型 |
| volcengine(glm) | `01KVX1JBFHG51E2X0KXPBG9B15` | `glm-5.2` | https://ark.cn-beijing.volces.com/api/coding | |

> **providerId = provider 配置的 `data.id`（ProviderInstance.id，server 真正认的 providerId），不是文件名 record.id、也不是 record.key 字段。** 用例应通过 `tests/api/lib/provider_resolve.py` 的 `resolve_real_provider()` 解析，勿手抄文件名（v0.0.24 verify 曾因手抄文件名 `01KVJMPG2FA9ZSWDND60HV56N2` 导致 server 报 "provider not found"）。
>
> test 数据目录另含 `mock:tool` 模型（工具测试桩），**验证用例不可选它**——mock 产物的 trace 是噪声。

## 复用库

**`tests/api/lib/provider_resolve.py`**（v0.0.24 verify 修复提供）— 解析真 provider/model：

```python
import sys
sys.path.insert(0, "<repo>/tests/api/lib")
from provider_resolve import resolve_real_provider
# 返回 (provider_id=data.id, model_id) 或 None；prefer_label 多 provider 时优先匹配 label
pid, mid = resolve_real_provider("/path/to/.rocky_agent_test", prefer_label="minimax")
```

run.sh 约定：env 显式指定 > `resolve_real_provider()` > `exit 77 SKIP`。绝不接受 mock。

**`tests/api/lib/langfuse_verify.py`**（Task#1 提供，API 已固定；同时 re-export `resolve_real_provider` 供向后兼容）。导入：

```python
import sys, os
sys.path.insert(0, os.path.join("<用例目录>", "..", "..", "lib"))  # tc1 路径多一层 ".."
from langfuse_verify import (
    LangfuseClient,
    message_text, trace_input_text, trace_output_text,
    generations, tool_spans,
    check_trace_id, check_session_id,
    check_input_contains, check_output_contains,
    check_generation_count, check_generation_usage, check_generation_usage_nonzero,
    check_generation_model, check_tool_span,
)
```

**客户端（IO 层，basic auth）** —— 所有方法吞网络异常，失败返回空结构：

```python
class LangfuseClient:
    def __init__(self, base_url: str, public_key: str, secret_key: str): ...
    def is_reachable(self) -> bool                  # GET /api/public/health 返 2xx
    def fetch_trace(self, run_id: str) -> dict      # GET /traces/{runId}，失败/未落库返 {}
    def fetch_observations(self, run_id: str, limit: int = 100) -> list
        # GET /observations?traceId={runId}，兼容 {data:[...]} 与裸 [...]，失败返 []
```

**纯函数（无 IO）—— 文本/筛选提取**：

```python
def message_text(msg) -> str                # 单条 message dict/list/string → 文本
def trace_input_text(trace: dict) -> str    # trace.input（list of messages）拼文本
def trace_output_text(trace: dict) -> str   # trace.output（list of messages）拼文本
def generations(observations) -> list       # 筛 type == GENERATION
def tool_spans(observations) -> list        # 筛 type == SPAN 且 name startswith "tool:"
```

**断言助手（返 bool，不含失败原因 —— 失败时把实际值写进 last_run.json 供排查）**：

```python
def check_trace_id(trace, run_id) -> bool
    # trace.id == run_id
def check_session_id(trace, session_id=None) -> bool
    # session_id=None 仅判 sessionId 非空；给定则要求 == session_id
def check_input_contains(trace, needle) -> bool   # trace_input_text 含 needle（大小写不敏感）
def check_output_contains(trace, needle) -> bool  # trace_output_text 含 needle（大小写不敏感）
def check_generation_count(observations, expected: int) -> bool
    # GENERATION 数量 == expected
def check_generation_usage(observations, model_id=None) -> bool
    # ≥1 generation 且 usage.input>0 且 usage.output>0；可选 model==model_id
def check_generation_usage_nonzero(observations) -> bool
    # 同上，不含 model 判定（对应 tc1 的 generation_exists_with_usage）
def check_generation_model(observations, model_id: str) -> bool
    # ≥1 generation：model == model_id
def check_tool_span(tool_spans_list, name_prefix="tool:",
                    arg_substrings=None, result_substrings=None) -> bool
    # ≥1 tool span：name startswith name_prefix；input.arguments 非空；output truthy；
    # arg_substrings / result_substrings 给定则要求各自全包含（大小写不敏感），None 跳过
```

> tc1 run.sh 在 py heredoc 内导入上述函数并按需调用即可；trace/observations 已由 bash curl 落盘，py 只需 `json.load` 再用纯函数判定（无需再走 LangfuseClient）。

## skip 语义（observability 可选）

以下情形用例 `exit 0`（clean SKIP，**不当失败**）：
- `LANGFUSE_*` 三项凭证任一缺失
- langfuse 实例 `/api/public/health` 不可达
- test 数据目录无真实（非 mock）provider

输出明示跳过原因（`SKIP: langfuse not configured — ...`），便于区分「没跑」vs「跑挂」。退出码 77（Unix 习惯：跳过）或 0 均可，本 skill 统一用 0。

## 判定铁律

- **不真调 langfuse API 不能判通过**——禁止「应该记下了」「trace 大概有」之类推测
- **trace / observation 内容不许用 `...` 省略**——断言失败时把实际值写进 last_run.json 供排查
- 断言必须基于**真实字段值**（如 `trace.id == runId`、`GENERATION.model == "MiniMax-M3"`），不是「字段存在」
- 多轮 case 必须验证**每轮** generation 落库，不是只验末轮

## 资源（references/）

- `example_verify_session.sh` — 最小样例：建 session → 发 query → 等 flush → curl 查 trace → 调库断言 input 含触发词、output 非空
