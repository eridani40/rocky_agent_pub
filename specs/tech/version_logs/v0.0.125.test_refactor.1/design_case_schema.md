# case.yaml 字段级 schema

> 归属：`design.md §0` 目录页拆分文件。定义 case.yaml 的每个字段类型/必填/默认/校验规则 + step 动作类互斥 + 变量插值。
> 校验实现：`case_loader.py`（加载即校验，失败 raise `CaseLoadError`，case 标 `not_run(load_error)`）。

## 1. 顶层字段

| 字段 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `case` | string | ✅ | — | 非空；`^[a-z0-9_]+$`（case_id 命名）；须与所在目录名一致（否则拒载） |
| `module` | string | ✅ | — | 非空；须与父目录名一致（`tests_v2/api/<module>/<case>/`） |
| `timeout` | number | ❌ | 60 | 秒；范围 [1, 300]（整 case 上限，非 wait 上限）；超范围拒载 |
| `requires` | string enum | ❌ | — | 仅 `live`；填 `live` 则该 case 仅 `MODE=live` 跑，其它 MODE skip（`not_run(requires_live)`） |
| `setup` | Step[] | ❌ | [] | fixture 步骤（自建数据，幂等）；每项按 Step schema 校验 |
| `steps` | Step[] | ✅ | — | 至少 1 个；case 主判定只看 steps 的 check |
| `teardown` | Step[] | ❌ | [] | 清理步骤（必执行，含 steps fail 时）；其 check 记入 result 但不影响主判定（D8） |

**未知顶层字段 → 拒载**（req「未知字段拒载」硬规则）。

## 2. Step schema（setup/steps/teardown 通用）

```yaml
- name: <人读描述>          # string，必填，非空
  # ── 动作类（互斥，选一，见 §3）──
  requests: [...]            # 或 request: <单请求简写>
  run: {...}
  poll: {...}
  wait: {...}
  oracle: {...}
  # ── SSE 订阅（step 级，可选，见 §4）──
  sse: { sub: [...] }
  # ── 桩点标记（可选，见 §5）──
  stub: [llm]
  # ── 变量提取（可选，见 §6）──
  save: { sid: .id }
  # ── 断言（可选，见 design_check_lang.md）──
  check: [ <表达式字符串>, ... ]
```

| 字段 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `name` | string | ✅ | — | 非空 |
| `requests` / `request` / `run` / `poll` / `wait` / `oracle` | 见 §3 | 动作类 0 或 1 个 | — | **至多一个动作类**（§3 互斥）；0 个 = 纯订阅/纯 check step（合法，如只开 SSE 流不发请求） |
| `sse` | object | ❌ | — | `{ sub: SseSub[] }`；见 §4 |
| `stub` | string[] | ❌ | [] | 元素 ∈ `{llm, web_search, web_fetch}`；未知桩点拒载 |
| `save` | map<string, path> | ❌ | {} | value 是 check path 语法的提取表达式（见 §6） |
| `check` | string[] | ❌ | [] | 每项是原子 check 表达式（`check_engine` 解析；非原子拒载，见 check_lang §4） |

**未知 step 字段 → 拒载**。

## 3. 动作类（互斥，选一）

一个 step **至多一个**动作类；多于一个 → 拒载（`CaseLoadError: step 'X' has multiple action classes`）。

### 3.1 `requests` / `request`（HTTP 请求）

```yaml
requests:
  - GET /session/{sid}                          # 简写：METHOD PATH，期望 status 默认 [200,201,202,204]
  - POST /session { "title": "t" }              # METHOD PATH JSON_BODY
  - { method: POST, path: /session/{sid}/clear, body: {}, status: [200] }   # 全写形式
request: GET /session/{sid}                     # 单请求简写（= requests: [该项]）
```

| 子字段（全写形式） | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `method` | enum | ✅ | — | `GET/POST/PUT/DELETE` |
| `path` | string | ✅ | — | 以 `/` 开头；支持 `{var}` 插值 |
| `body` | object | ❌ | — | JSON body；支持 `{var}` 插值（值与嵌套） |
| `status` | number[] | ❌ | [200,201,202,204] | 期望响应码集合；实际不在集合 → step fail（附 actual status） |

- 多请求时最后一个请求的响应体作为本 step 的「主输出」（供 `save`/`check` 的 `.field` path 引用）；多请求响应各自也可经 `.responses[N]` 引用（见 check_lang path 语法）。
- 简写文法：`METHOD SP PATH [SP JSON]`；解析器按首个空格切 method、次空格前切 path、余下解析为 JSON body。

### 3.2 `run`（发消息同步等 agent loop 终态）

```yaml
run: { content: "你好", providerId?: "...", modelId?: "..." }
```

- 打 `POST /session/{sid}/run`（test-only sync wrapper，`04-agent-session.md`）；**sid 从 ctx 变量取**（step 或前序 save 的 `sid`；无 sid → 拒载）。
- 返回 200 `{ runId, state, stopReason, error, messages }` 作为主输出；`check` 可断言 `.state=="idle"` / `.stopReason=="no_tool_call"` / `.messages[...]`。
- `content` 必填非空；`providerId`/`modelId` 可选（缺省用 session 预绑定）。

### 3.3 `poll`（轮询直到条件满足）

```yaml
poll: { request: "GET /session/{sid}/summary", until: ".summary != null", every: 0.5, timeout: 8 }
```

| 子字段 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `request` | string（简写） | ✅ | — | 每轮打的请求（同 §3.1 简写文法） |
| `until` | string | ✅ | — | 单个 check 表达式；对每轮响应求值，true 即停 |
| `every` | number | ❌ | 0.5 | 轮询间隔秒；范围 [0.1, 5] |
| `timeout` | number | ✅ | — | **≤10 硬顶**（超 10 拒载，req 铁律）；到时未满足 → step fail（timeout） |

- 满足即继续（拿满足时的响应作主输出）；超时 → step fail，result 记「poll timeout, last actual: <值>」。

### 3.4 `wait`（等 SSE 流条件满足）

```yaml
wait: { stream: main, until: "main.count(type=run_end) == 1", timeout: 8 }
```

| 子字段 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `stream` | string | ✅ | — | 命名流名（须为前序 `sse.sub[].as` 已声明的流；未声明拒载） |
| `until` | string | ✅ | — | 单个 check 表达式（可用事件流函数，见 check_lang §3） |
| `timeout` | number | ✅ | — | **≤10 硬顶**（超拒载）；到时未满足 → step fail |

- wait 不发 HTTP，只对**已后台收集的 SSE 流缓冲**做条件求值（每 100ms 重估）；条件满足立即继续。
- 无主输出（wait 后 `check` 引用的是流，用 `<stream>.xxx`）。

### 3.5 `oracle`（langfuse 断言，仅 record/live 轮）

```yaml
oracle: { langfuse: { trace_by: session, ready_when: "output != null", timeout: 8 } }
```

| 子字段 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `langfuse.trace_by` | enum | ✅ | — | `session`（按 sessionId 定位 trace）；预留其它 |
| `langfuse.ready_when` | string | ✅ | — | 有界轮询终止条件（对 trace 求值，如 `output != null` 治异步 patch 坑） |
| `langfuse.timeout` | number | ✅ | — | **≤10 硬顶**（超拒载） |

- **仅 `MODE ∈ {record, live}` 生效**；`MODE=replay` 轮 oracle step **自动跳过**（不发请求、不算 fail、result 记 `skipped(replay)`）。
- trace 定位用 ctx 里的 `sid`（无 sid → 拒载）。ready_when 满足后，其后 `check` 可断言 trace 字段（`.output` / `.observations` 等）。

## 4. `sse.sub` 订阅（step 级）

```yaml
sse:
  sub:
    - { topic: agent_loop, group: "session_id:{sid}_amt:current", as: main }
    - { topic: session_panel, group: "session_id:{sid}", as: panel }
```

| 子字段 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `topic` | string | ✅ | — | 非空（server 会校验 ALLOWED_TOPICS，runner 不校验白名单，仅校验非空） |
| `group` | string | ✅ | — | 非空；支持 `{var}` 插值 |
| `as` | string | ❌ | 自动命名 `stream_<topic>_<N>` | 流名；case 内唯一（重名拒载）；后续 `wait`/`check` 用此引用 |

- 语义（req §5）：step 级显式开流，**开流后持续收集直到 case 结束**（不随 step 结束关闭）；命名流全程累积事件。
- 未声明任何 `sse.sub` 的 case → 无 SSE 面（不建 `GET /sse` 连接）。
- 首个 `sse.sub` 出现时 runner 惰性建立 `GET /sse` 单长连接 + 后台收集线程（见 sse_collector）。

## 5. `stub` 标记（审计 + 核对，非配置）

```yaml
stub: [llm]                # 本 step 声明会撞的桩点
```

- 元素 ∈ `{llm, web_search, web_fetch}`；标记语义（req §4）：
  - **record 轮核对**：本 step 若声明 `[llm]`，commit 时 server 核对该 step 期间是否真撞了 llm（标了没撞 → warn；撞了没标 → loud fail）。
  - **replay 轮防出网**：runner 在 step 开始通过 `/test/stub/step` 告知 server「当前 step 声明 = [llm]」；server 遇到**未声明桩点的出网** → fail loud（详见 design_stub_protocol §4）。
- 非动作类（可与任一动作类共存）；空/省略 = 声明「本 step 不撞任何桩点」。

## 6. 变量插值 + save

**插值 `{var}`**：出现在 `path` / `body`（值与嵌套字符串）/ `group` 里；从 ctx 取值替换。未定义变量 → 拒载（静态可检测的 `{var}` 在 case 内无对应 save/内建 → load 期报错）。

**内建变量**：无（sid 等一律由 save 显式提取，避免隐式魔法）。

**`save`（从主输出提变量）**：
```yaml
save: { sid: .id, run_id: .runId }
```
- key = 变量名（`^[a-z0-9_]+$`）；value = check path 语法的提取表达式（见 check_lang §1，对当前 step 主输出求值）。
- 提取失败（path 不存在）→ step fail（`save 'sid' path .id not found`）。
- save 在 check 之前执行（同 step 内 check 可引用刚 save 的变量）。

## 7. 完整示例（路径 A：新建会话 → 发消息 → 纯文本回复）

```yaml
case: chat_basic_reply
module: chat
timeout: 30
setup:
  - name: 建会话
    requests:
      - POST /session { "title": "at-v2" }
    save: { sid: .id }
steps:
  - name: 订阅 agent_loop 流
    sse:
      sub:
        - { topic: agent_loop, group: "session_id:{sid}_amt:current", as: main }
  - name: 发消息同步等终态
    run: { content: "用一句话回答：你好" }
    stub: [llm]
    check:
      - .state == "idle"
      - .stopReason == "no_tool_call"
      - main.count(type=run_start) == 1
      - main.count(type=run_end) == 1
      - main.order(run_start < run_end)
teardown:
  - name: 删会话
    requests:
      - DELETE /session/{sid}
```
