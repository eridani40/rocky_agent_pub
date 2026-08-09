---
name: api-testing
description: 黑盒 API 测试框架（AT = tests/api）。声明式 case.yaml DSL + 真实 HTTP + 机械执行（LLM 不参与判定）+ NODE_ENV=test 独立数据目录 + record/replay/live 三 MODE（外部传入）+ record→replay 双关验收（FAIL 绝不落盘）+ stub 出站帧审计 + frame_checks 帧内容合同 + sse.sub 单通道订阅。用例库在 tests/api/。api-test-designer（设计 case.yaml）+ api-test-executor（跑 run_all.sh）遵循本 skill。
---

# API Testing（AT 框架 = tests/api）

**AT 唯一框架 = `tests/api/`**。声明式 `case.yaml` DSL 驱动、真实调 API、机械执行（LLM 不参与判定）、内置 record/replay 双关。
> **ET（e2e）不在本范围**——ET 仍用旧 `tests/e2e` 框架，与本 skill 无关。

## 何时用
服务端 / 接口验证。两个角色按本 skill 工作（设计 / 执行分离）：
- **api-test-designer**：设计每个 case（`case.yaml` [+ 可选 `recordings/`]），断言基于 `specs/api/` 契约，不读产品代码，不执行。
- **api-test-executor**：`bash tests/api/lib/run_all.sh`（前台，env→cases→shutdown + 计时）→ 读 `run_all_result.json` → 汇报（无脑执行，不改 case / 不读代码 / 不调试）。

**必读 `tests/README.md`**：AT 权威文档（DSL schema 全量 / MODE / 双关 / stub 协议 / frame_checks / audit 语义 / timeout 上限 / 断言配方库 6 条 / fail 自解释）。

## 目录结构
```
tests/api/
├── env_start.sh / env_shutdown.sh   # 起/关 test server（NODE_ENV=test）
├── lib/
│   ├── run_all.sh        # 全量入口（env→cases→shutdown）
│   ├── run_case.py       # 单 case 入口
│   ├── _run_all_exec.py  # 串行执行 + 双关编排 + 聚合
│   ├── case_loader.py    # case.yaml 解析 + 载入期校验（拒载非法 DSL）
│   ├── step_exec.py      # 步骤动作执行（requests/run/poll/wait/oracle）
│   ├── check_engine.py   # check 表达式求值（含数组谓词/负索引/~=）
│   ├── sse_collector.py  # SSE 命名流采集
│   └── interp.py         # 变量插值 + HTTP 辅助
└── {module}/{case_id}/
    ├── case.yaml         # case 定义（唯一入口，声明式 DSL）
    ├── recordings/       # LLM 录制（manifest.json + llm.jsonl [+ golden.json]）= 交付物，入 git
    └── last_run/         # 最后一次运行产物（result.json + steps/）
```
case 直接在 `tests/api/{module}/` 设计/迭代（持久化库），executor 的 run_all.sh 自动扫描全跑，**不复制到 states 副本、不回写 case.yaml**。结果聚合落 `states/<version>/verify/api-test/run_all_result.json`。

## 运行命令
```bash
bash tests/api/lib/run_all.sh                              # 全量 replay（默认）
MODE=record bash tests/api/lib/run_all.sh                  # 全量 record + 自动双关
CASES=chat_send_reply,compact_manual_sse bash tests/api/lib/run_all.sh   # 白名单
MODULE=chat bash tests/api/lib/run_all.sh                  # 限定模块
LIST_ONLY=1 CASES=chat_send_reply bash tests/api/lib/run_all.sh          # dry-run 列匹配 case
BASE_URL=http://127.0.0.1:3700 python3 tests/api/lib/run_case.py tests/api/chat/chat_send_reply replay  # 单 case 直跑
```

## MODE（外部传入，case.yaml 不写死）
| MODE | 行为 | 场景 |
|------|------|------|
| `replay`（默认） | 用 `recordings/` 离线回放：毫秒级、零费用、确定性 | CI / 日常回归 |
| `record` | 调真实 LLM 录制，**PASS 才落盘**；自动触发双关（record PASS → replay） | 新 case 录制 / 需求变更重录 |
| `live` | 调真实 LLM，不录制不回放 | smoke（case 标 `requires: live`） |

**record→replay 双关（record 模式自动触发）**：record PASS → 立即以 replay 再跑一遍 → **两轮全绿才最终判 pass**。
record 绿只证明真 LLM 路径通；replay 绿才证明录制可离线复现（无动态 marker / 时序断链）。
**FAIL 绝不落盘**：record 轮 steps fail → server 不 commit recordings；`frame_checks` fail 时 server 已 commit → runner 事后主动删刚落盘的 `recordings/`，恢复不变量。replay 轮 fail 只判 fail，**绝不动已有 recordings**（入库资产）。
**新增 case = 必录制 + 双关 PASS 才算通过**：录制 + 回放两轮全绿后，`recordings/` 随 case 一起 commit（= 交付物）。

## case.yaml DSL 摘要
顶层字段：`case`（id，必填）/ `module`（必填）/ `timeout`（单 case 秒，默认 60，上限 300）/ `requires: live`（可选，仅 live 跑）/ `setup`（前置，任一 fail → steps 不跑、teardown 必跑）/ `steps`（核心）/ `teardown`（无论结果必跑）/ `frame_checks`（可选，见下）。

**step = 一个动作键 + 可选 `stub` + `save` + `check`**：
| 动作键 | 功能 |
|--------|------|
| `requests` | 发 HTTP 请求列表（简写 `METHOD PATH [JSON]` 或 object-form dict） |
| `run` | `POST /session/{sid}/run`（同步等终态，消除 poll/SSE 完成检测的 flaky） |
| `poll` | `{request, until, every, timeout}` 轮询直到满足或超时 |
| `wait` | `{stream, until, timeout}` 等 SSE 命名流条件满足 |
| `sse.sub` | 订阅 SSE 命名流：`sub: [{topic, group, as}]`（配合 wait；先订阅后触发） |
| `oracle` | Langfuse trace 有界轮询（仅 record/live） |

- `stub: [llm]` — **步骤级声明**本步涉及的桩点（`llm`/`web_search`/`web_fetch`）。凡触 LLM/工具出站的 step 必声明，否则 record 轮 `hit_not_declared` 判 fail（录制盲点）。
- `save: { sid: .id }` — 从响应提取变量，后续用 `{sid}` 插值（**只在 request path/body 插值，check 右侧不插值**，见陷阱）。
- object-form request：`{method, path, status, body|multipart}`；`status` 支持 int / list（OR 语义）；简写形式无法指定非默认 status。

### check 表达式（原子性——一条 check 一个谓词，禁 op 叠加/布尔连接/嵌套）
| 表达式 | 含义 |
|--------|------|
| `.field exists` | 字段存在且非空 |
| `.field == "value"` / `!= ` / `~= "substr"` | 等值 / 不等 / 包含子串 |
| `.items[0].id exists` / `.msgs[-1].content ~= "x"` | 数组索引（含负索引） |
| `stream.count(type=run_end) == 1` | 流事件计数（可带过滤 `type=X,status=Y`） |
| `stream.order(run_start < run_end)` | 流事件顺序 |
| `stream.absent(type=error)` | 流事件不存在 |
| `.providers[] any .id == "builtin"` | 数组谓词 any：≥1 元素满足（空数组→false） |
| `.items[] all .enabled == true` | 数组谓词 all：所有元素满足（空数组→true） |

数组谓词语法 `<array_path>[] any/all <sub_path> <op> <rhs>`：子谓词只支持路径比较（不支持 exists/absent 一元、布尔连接词、嵌套谓词——违反原子性 → **载入期拒载**）。

### frame_checks — 出站帧内容合同（case 级顶层，可选）
在 case 结束（`_stub_commit` 后读 `recordings/llm.jsonl`）逐条求值 LLM/工具出站帧的具体内容。路径根 `{ "llm": [帧0, 帧1, ...], "web_search": [...], "web_fetch": [...] }`，帧序=录制序，帧内容=jsonl 每行 JSON（`response`/`request_meta`/`fingerprint` 字段）。

**安全约束**：`request_meta` 只含非敏感派生指纹，完整 request body 不录制。`.request.messages[]`/`.request.tools[]` 路径**不存在**，用这些路径断言永远 fail。

**request_meta 可用字段**：`stream: bool` / `model: string` / `message_count: number` / `roles: string[]`（messages[].role 序列，只有角色名）/ `tool_names: string[]`（tools[].name 列表，只有工具名，无 tools 时=`[]`）

**response 可用字段**：`kind: "sse"|"json"` / `status: number` / `sse_frames: string[]`（SSE 帧文本数组）/ `body`（JSON 响应体）

```yaml
frame_checks:
  - .llm[0].request_meta.message_count >= 1              # 第 0 帧至少 1 条消息
  - .llm[1].request_meta.roles[] all . != "tool"         # 第 1 帧 wire 无 role=tool（anthropic 协议）
  - .llm[1].request_meta.roles[0] == "user"              # 第 1 帧首条消息是 user
  - .llm[0].request_meta.tool_names[] any . == "bash"    # 第 0 帧 tools 含 bash
  - .llm[0].response.status == 200                       # 第 0 帧响应 200
  - .llm[0].response.sse_frames[] any ~= "tool_use"      # 第 0 帧响应含工具调用
  - .llm[1].response.sse_frames[] all !~= "tool_use"     # 第 1 帧响应无工具调用
```
仅 steps 全 pass 后执行；任一 fail → result=fail。路径首段须是已知桩点，否则载入期拒载。与 `stub` 声明互补（stub=告知涉及哪些桩点，frame_checks=校验录下的帧内容）。

## 断言配方库（可直接抄进 case.yaml，每条含陷阱注记 — 源自 README §异步场景配方）
1. **等异步任务完成**：`run` 同步返终态即断言；SSE 完成用 `main.count(type=run_end,status=done) >= 1`。陷阱：`running` 帧也算一帧，`count(type=run_end)` 不带 `status=done` 会误计 running 帧。
2. **fire-and-forget（202 受理 ≠ 完成）**：`requests` status:[202] → `poll { until: .status == "done", timeout }` → 再断言结果。陷阱：202 只证受理，直接断言结果必 fail。
3. **SSE 事件序列**：先 `sse.sub` 订阅 → 触发 `run` → `wait { until: main.count(type=run_end) >= 1 }` → `check` order/count/absent。陷阱：反序（先触发后订阅）丢早期帧。
4. **动态实体唯一化**：`POST /session {"title": "test-{case_id}"}` → `save {sid}` → 后续用 `.id == "{sid}"`（request 内插值）+ `exists` 断言稳定字段。陷阱：**check 右侧不插值**，靠 save 后用 id（request path 插值）比对，不用 name 过滤。
5. **错误路径断言**：object-form `status: [400]` / `[403,404]` → `check .error ~= "required"`。陷阱：`status` 支持数组用于同端点不同违规返不同码；简写形式无法指定非默认 status。
6. **snake_case 字段 + 归零态字段**：`.usage.total_tokens >= 1`（非 `totalTokens`）；归零态字段可能整体缺省 → 断 `exists`/`absent` 或只断稳定字段。陷阱：fail 时 `actual` 输出 `<missing> (available at .usage: total_tokens, ...)` 可快速定位拼写；`== 0` 遇缺省字段因 `<missing>` 假 fail。

## DSL 陷阱清单（W1–W4 实战沉淀 — 每条都曾造成假 fail / 拒载）
1. **check 右侧不做变量插值**：`.name == "{sid}"` 中 `{sid}` 是字面字符串（不替换）。动态 name 断言改 `exists` + 固定 marker 等价断言，或 save 后用 request path 插值的 id 比对（W1 memory_http_contract）。
2. **snake_case 字段名**：usage 类字段是 `total_tokens`/`input_cache_read`（非 camelCase）；写错 → `<missing>` 假 fail（W3 chat_clear）。归零态字段任务未执行时整体省略，别断 `== 0`（W3）。
3. **object-form 才能指定非默认 status / multipart**：简写 `METHOD PATH [JSON]` 只走默认成功码；要断 4xx 或传 multipart 必须 object-form（`{method, path, status:[400]}` / `{multipart:{...}}`）（W2 config_plugin_inventory 写端点 405、配方 5）。
4. **动态实体用 `{case_id}`/save 派生名唯一化**：DELETE=归档致 name 永久占用等场景，条目 name 全 `{sid}` 派生唯一化，不依赖清理残留（W1 memory_http_contract）。
5. **wait/count 带 status 过滤 `status=done`**：`summary_task_update`/`run_end` 等带 status 的帧，running 帧一到就放行会误判——`until: main.count(type=X,status=done) == 1` 才精确等完成（W3 compact summary null 根因）。
6. **stub 声明范围要全**：凡触 LLM/工具出站的 step（含 fire-and-forget 的 compact、inbox_cancel）都要 `stub: [llm]`，漏声明 → record 轮 `hit_not_declared` fail（W3 inbox_cancel audit、W4）。
7. **check 原子性（载入期拒载）**：一条 check 只放一个谓词。禁 op 叠加（`.a == 1 == 2` 会假 PASS）、禁 `>= 1 <= 2` 双比较、禁 `~=`+`==` 混合、禁数组谓词内嵌套/布尔连接（Task#2 check_engine 修复）。
8. **命名流 case 内唯一**：`sse.sub` 的 `as:` 流名在整个 case 内唯一（不只 step 内），重名拒载（Task#2 M1）。
9. **SSE 订阅 = 1 subId 唯一化**：collector 每次 `sse.sub` 用唯一 subId，先订阅后触发；两命名流订同一 (topic,group) 时 server 按 subId 各发一帧是协议正确 fan-out（W1 BUG-001，纯测试侧路由，产品零改动）。
10. **`{var}` 未定义 → 载入期拒载**：case.yaml 里引用未 save/未定义的 `{var}`，case_loader 直接拒载（Task#2 C1，`_check_interp_refs`）。
11. **wait/poll timeout 上限 60**（v0.0.125 放宽，短等待仍建议 ≤10）；单 case `timeout` 默认 60、上限 300。compact 等重链路用 poll 接力（GET /summary until `.summary != null`）替代长 wait。
12. **protocolId / providerId 用真实值**：`providerId` 用 provider 的 `data.id`（ULID，如 case.yaml 里 `01KVJMPG2EZ1078MCT9JH4J5HG`），`modelId` 用厂商模型名字符串（`MiniMax-M3`），非外层文件名 id。
13. **YAML 里 `${}` 不是插值语法**：本 DSL 插值用 `{var}`（单花括号），YAML 值里的 `${...}` 是普通字符串，不解析——别写成 shell 风格。
14. **triage / 语义偏差按代码实际写 + 记 doc-sync 待办**：spec 落后于代码时（如 accept 不改 status，defer/reject 才置 cancelled；session 字段 biz/role vs spec bizType/type），case 按实际实现写，偏离汇报 orchestrator 记 doc-sync 待办交 doc-modifier 统一修 spec（W2）。

## fail 自解释输出怎么读
`run_all_result.json` + 每 case `last_run/result.json` 的 fail 项自带上下文（v0.0.125 fail 自解释）：
- **键缺失** → `actual: <missing> (available at .usage: total_tokens, input_cache_read, ...)`：列出该层级实际可用键 → 多半是拼写/大小写（camelCase vs snake_case）错，对照可用键改路径。
- **流事件 check fail** → 列出该流实际事件类型分布（如 `run_start×1, run_end×1(status=running)`）：对照期望的 type/status/count 过滤条件，多半是漏 `status=done` 过滤或订阅时序问题。
- **frame_checks fail** → `result.json.frame_checks{ok, checks[], empty_recordings}`：`empty_recordings=true` 说明该桩点无录制帧（step 未触发 LLM 或 replay 无 recordings）。
- **载入期拒载** → case_loader 报「非法 DSL」+ 具体行（原子性/未定义 var/未知桩点/重名流）→ 改 case.yaml 语法，非产品 bug。
- **stub audit fail** → record 轮 `hit_not_declared` 列出未声明就出站的桩点 → 给对应 step 补 `stub`。

## 判定铁律
- 不真实调 API 不能判通过；响应体不许用 `...` 省略。
- 缺环境条件（凭证/live 依赖）标记 `⏭️ 跳过` 并列出缺什么。
- **AT 与 ET 严禁并发**：AT（tests/api）与 ET（tests/e2e）共享 `tests/lib/port_alloc.sh` 端口注册表 + DATA_DIR，必须串行。

## 部署要点（一次性）
- Python 3.9+（`python3` 在 PATH）。
- `tests/test.env`（提交的 schema，无机密：`TEST_PROVIDER_ID`/`TEST_MODEL_ID` 等 id；AT/ET 共用）。
- `~/.rocky_agent/test.secrets.env`（gitignored，含 API key 等机密；record/live 需要）。
- **id vs 凭证别混**：`providerId`/`modelId` 是「指路的 id」（非密钥，进 test.env）；真密钥在 provider 池 `data.credentials.key`，server 自己读，测试脚本永不碰。
