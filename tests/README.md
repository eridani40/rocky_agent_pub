# tests — 测试框架（双轨：AT + ET）

**双轨说明**（v0.0.190 AT 重构 + v0.0.188 ET 重构，**两轨均不录制不回放真调 LLM**）：

| 轨 | 路径 | 框架 | 入口 |
|----|------|------|------|
| **AT**（API 测试） | `tests/api/` | 声明式 `case.yaml` DSL + 真实调 API（v0.0.190 去 record/replay，真调 minimax）+ 429 skip | `bash tests/api/lib/run_all.sh` |
| **ET**（E2E 测试） | `tests/e2e/` | **agent 玩 app 范式**（v0.0.188 重构）：case.md 纯自然语言 + executor agent + env.sh 启停 + 每步留证 + 自由心证（不录制不回放真调 LLM） | `bash tests/e2e/run.sh` + orchestrator 委派 e2e-test-executor |

**两轨范式不同**：AT 走 designer 设计 + executor 跑 run_all 两段；ET 走 orchestrator 顺次委派 executor agent 玩单 case（无 designer）。两轨端口段隔离（AT API 3700-3799 / WEB 8787-8887；ET API 3800-3899 / WEB 8900-8999 / CDP 9222-9299），可并行但建议串行。

本文档是 AT 框架的权威文档（DSL schema 全量 / 异步配方 / fail 自解释 / 429 skip / 已知限制）。ET 的范式与 case.md 写法见 `specs/tech/testing/et-framework.md` + `.claude/agents/e2e-test-executor.md` + `.claude/skills/playwright-cli/references/executor-workflow.md`。

## 部署（一次性）

**两类东西，别混：id（非机密）vs 凭证（机密）**：

| 用途 | 谁调用 | 接入方式 | 配置项 | 放哪 |
|------|--------|----------|--------|------|
| **App LLM 主**（被测 session 用） | server（被测程序） | provider id + model id 拼进 HTTP 请求体，server 读 provider 池凭证 | `TEST_PROVIDER_ID`/`TEST_MODEL_ID` = minimax/MiniMax-M3 | **test.env**（提交，非机密） |
| **App LLM 备选**（主用光时 fallback） | server（被测程序） | 同上，换一对 id | `TEST_FALLBACK_PROVIDER_ID`/`TEST_FALLBACK_MODEL_ID` = volcengine/glm-5.2 ⚠️ **该火山 CodingPlan 订阅已过期，出站直接 400，勿用** | **test.env**（提交，非机密） |
| **Test vision judge**（ET 视觉判定） | vision_check.py（测试脚本） | **脚本自己直连 HTTP**（base_url + token，不走 provider 池） | `VISION_BASE_URL`/`VISION_AUTH_TOKEN`/`VISION_MODEL` = MiniMax-M3 | **secrets**（gitignored，机密） |

**核心原则（用户定）**：
- **被测 session 用的 provider/model 绝不碰 secrets**——`providerId`/`modelId` 只是"指路的 id"，不是密钥。真密钥（provider 的 key）在 provider 池 `data.credentials.key`，**server 自己读，测试脚本永不碰**。
- **secrets 只装"测试脚本自己直连"要的凭证**——vision_check.py 直连视觉模型的 `VISION_AUTH_TOKEN`、langfuse/jina/zhipu 工具直连的 key。

**1. 全局 secrets**（所有 worktree 共享，不进 git）——**只装测试脚本自己直连要的凭证**：
```bash
mkdir -p ~/.rocky_agent
cat > ~/.rocky_agent/test.secrets.env <<'EOF'
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASE_URL=http://localhost:3000
JINA_API_KEY=jina_...
ZHIPU_SEARCH_API_KEY=...

# Test vision judge (ET 视觉判定用) — MiniMax-M3，vision_check.py 直接 HTTP（不走 provider 池）
VISION_BASE_URL=https://api.minimaxi.com/anthropic
VISION_AUTH_TOKEN=<minimax-key>
VISION_MODEL=MiniMax-M3
EOF
chmod 600 ~/.rocky_agent/test.secrets.env
```

**2. 框架 schema 已提交**（`tests/test.env`，无 secrets）——fresh worktree 零 cp。

env_start 启动时打印各 key 就位状态（脱敏长度）；缺只 warn 不挂（除非 case 声明需要）。

## 目录结构

```
tests/
├── test.env               # 提交 schema（无 secrets，AT/ET 共用）
├── README.md              # 本文件（AT 权威 + ET 入口）
├── RECORD_BATCH.sh        # 分波串行录制驱动（全量录制 / 按模块）
├── worktree_cleanup_check.sh  # 删 worktree 前检查 env 残留
├── lib/
│   ├── port_alloc.sh      # 全局端口注册表（alloc/read/free/cleanup_check）— AT 用
│   ├── timeout_guard.sh   # per-case 超时兜底
│   └── seed_common.sh     # AT/ET 共用 seed 数据
├── api/                   # AT 框架（v0.0.190 真实调 API，无 record/replay）
│   ├── env_start.sh / env_shutdown.sh   # copy dev 5 组技术配置 + post-boot seed contextWindow=300000
│   ├── lib/{run_case.py, case_loader.py, step_exec.py, check_engine.py, check_explain.py,
│   │      check_events.py, interp.py, artifacts.py, sse_collector.py,
│   │      files_action.py, run_all.sh, selftest/}        # selftest = 框架唯一测试层
│   └── {module}/{case_id}/{case.yaml, test_case.md [, last_run/]}
└── e2e/                   # ET 框架（v0.0.188 agent 玩 app 范式）
    ├── env.sh             # 单 case 环境启停：start <cid> [--mode=headless|electron] / stop <cid> / case-data-dir <cid>
    ├── run.sh             # 编排入口：list + 顺序遍历 playground-*/case.md，每 case env.sh start → 提示委派 executor → stop
    ├── vision_check.py    # 视觉判定 CLI 工具（单图 + compare），executor 按需调用
    └── playground-<case>/case.md   # 纯自然语言 case（Use Case + 编号操作目标 + 验收口径）
```

## 跑测试

### executor wrapper（仅 AT，v0.0.188 已删 tests/run_all.sh 顶层 wrapper）

```bash
# AT 单独跑（ET 走 tests/e2e/run.sh + 委派 executor agent，不再有顶层 wrapper）
bash tests/api/lib/run_all.sh
```

### 单独跑 AT

```bash
bash tests/api/lib/run_all.sh                              # 全量真实调 minimax（v0.0.190 默认，无 MODE）
CASES=chat_session_crud,chat_send_reply bash tests/api/lib/run_all.sh   # 白名单
MODULE=chat bash tests/api/lib/run_all.sh                  # 限定模块
LIST_ONLY=1 CASES=chat_send_reply bash tests/api/lib/run_all.sh          # dry-run 列匹配 case
BASE_URL=http://127.0.0.1:3700 python3 tests/api/lib/run_case.py tests/api/chat/chat_send_reply   # 单 case 直跑
```

结果落 `states/<version>/verify/[round-N/]api-test/run_all_result.json`。

### 单独跑 ET（v0.0.188 新范式）

ET 不再走 run_all.sh + CASES 白名单旋钮；改为「env.sh 起 case 环境 + orchestrator 委派 executor agent 玩」：

```bash
# 1. orchestrator 起 case 环境（headless 或 electron）
bash tests/e2e/env.sh start playground-send-message --mode=headless
# 输出：API_URL=http://127.0.0.1:38xx  WEB_URL=http://127.0.0.1:89xx  [CDP_URL=...]

# 2. orchestrator 委派 e2e-test-executor agent
#    executor 读 tests/e2e/playground-send-message/case.md + app-guide
#    用 playwright-cli 玩 app → 每步留证 → 自由心证 blocking/small/pass
#    留证落 states/<ver>/verify/e2e/<cid>/steps/NN-<action>/{screenshot.png,dom.html,snapshot.yml,meta.json}

# 3. orchestrator 关 case 环境（pidfile 精确 kill + 删 DATA_DIR）
bash tests/e2e/env.sh stop playground-send-message

# 编排入口（顺序遍历 playground-*/case.md，每 case start → 提示委派 → stop）
bash tests/e2e/run.sh
bash tests/e2e/run.sh list                  # 列出所有 case_id
bash tests/e2e/run.sh playground-send-message playground-tool-call   # 指定 case
bash tests/e2e/run.sh --mode=electron       # 切 electron 模式（真窗口）

# 视觉判定工具（按需）
python3 tests/e2e/vision_check.py path/shot.png '[{"id":1,"check":"..."}]'
python3 tests/e2e/vision_check.py compare path/impl.png path/design.png '[{"id":1,"dimension":"layout","check":"..."}]'
```

结果落 `states/<version>/verify/e2e/<case_id>/{verdict.json, steps/NN-<action>/}`。

### 局部执行防呆 + 硬约束（AT 专属）

`CASES=` 是 AT 唯一 case 白名单旋钮（ET 不用 CASES，走 case.md 文件名 + orchestrator 委派）。子 run_all 对局部执行加了硬约束，fail-loud 防「静默 balloon 成全量」：

1. **CASES 必填**：无 `CASES` 且无 `FORCE_ALL=1` → **报错退出**。
2. **一次最多 20 个 case**（wrapper 层）。
3. **内置预算 900s（15min）**：`RUN_BUDGET_SECONDS` 默认 900s。
4. **fail-loud + dry-run**：写错白名单变量名 → 报错；`LIST_ONLY=1` 只列命中 case、不起 env。

### 端口文件（v0.0.69 解决跨 worktree 抢端口）

- **端口是全局资源**（lsof 查实际占用），**文件是 per-worktree**（在 worktree 的 DATA_DIR 里）。
- `env_start` lsof 找空端口 + 扫兄弟 worktree 的 `.env_port` → 启动 → 写自己 DATA_DIR 的 `.env_port`。
- `env_shutdown` 读自己 `.env_port` → 杀 pid + 清自己注册的端口 + 删 `.env_port`。
- run_case/run_all 读自己 `.env_port`（无文件报错"先 env_start"）。

### ROUND 轮次 + 已过 case 默认 skip（AT 专属）

- `ROUND=N` → 结果隔离到 `round-N/api-test/`（round-* 已 gitignored）。
- **已过 case 默认跳过**：开跑前扫 prior rounds 的 `result=pass` case_id 组 skip-set，本轮自动 skip。
- `CASES=a,b`（白名单，精确跑，**不受 skip-set 影响**）/ `FORCE=x,y`（强制重跑）/ `FORCE_ALL=1`（全跑）。
- **ET 无 ROUND 机制**（v0.0.188）：executor 一次跑一个 case，orchestrator 记录历史 verdict.json，不需要 round 隔离。

### worktree 清理（删 worktree 前必跑）

```bash
bash tests/worktree_cleanup_check.sh   # exit 0=可删；exit 1=先 env_shutdown
```

---

# AT 框架（tests/api）— 权威文档

声明式 `case.yaml` DSL 驱动、真实调 API（不录制不回放）、机械执行（LLM 不参与判定）、429 skip 不阻塞。

**v0.0.190 起 AT 改真实调 API**（对齐 ET v0.0.188 范式）：每 case 真调 minimax 等 provider + 契约断言；无 `MODE` / `stub` / `frame_checks` / `recordings/` 字段（全删）。429/529/503 → `skipped, reason=429`（不重试不阻塞）。dev config 5 组技术配置 copy（web_search/see_image/runtime/web/consolidation）。

## case.yaml DSL 速查

```yaml
case: my_case          # case id（必填）
module: chat           # 模块分组（必填）
timeout: 60            # 单 case 超时秒（默认 60，上限 300）
                       # wait/poll/oracle 的 step 级 timeout 上限 60
requires: live         # 可选（v0.0.190 起恒 live 真调，多数 case 省略）

setup:                 # 前置步骤（任一 fail → steps 不跑，teardown 必跑）
  - name: 建会话
    requests:
      - 'POST /session {"title": "test"}'  # 简写：METHOD PATH [JSON]
    save: { sid: .id }                     # 从响应提取变量
    check:
      - .id exists
      - .state == "idle"
      - .title == "test"

steps:                 # 核心步骤
  - name: 发消息同步等终态
    run: { content: "说 hello" }           # POST /session/{sid}/run（同步等 idle）
    check:
      - .state == "idle"
      - .stopReason == "no_tool_call"

  - name: 订阅 SSE 流
    sse:
      sub:
        - { topic: agent_loop, group: "session_id:{sid}_amt:current", as: main }

  - name: 等待流事件
    wait:
      stream: main
      until: "main.count(type=run_end) == 1"
      timeout: 10
    check:
      - main.count(type=run_start) == 1
      - main.count(type=run_end) == 1
      - main.order(run_start < run_end)

  - name: 轮询等状态
    poll:
      request: GET /session/{sid}
      until: .state == "idle"
      every: 0.5
      timeout: 8

teardown:              # 清理步骤（无论 steps 结果必执行）
  - name: 删除会话
    requests:
      - DELETE /session/{sid}
```

### check 表达式语法

| 表达式 | 含义 |
|--------|------|
| `.field exists` | 字段存在且非空 |
| `.field == "value"` | 等值比较 |
| `.field != "value"` | 不等 |
| `.field ~= "substr"` | 包含子串 |
| `.items[0].id exists` | 数组索引 |
| `stream.count(type=run_end) == 1` | 流事件计数 |
| `stream.order(run_start < run_end)` | 流事件顺序 |
| `stream.absent(type=error)` | 流事件不存在 |
| `.providers[] any .id == "builtin"` | 数组谓词：至少一个元素满足（any） |
| `.items[] all .enabled == true` | 数组谓词：所有元素满足（all） |

**数组谓词语法**：`<array_path>[] any/all <sub_path> <op> <rhs>`

- `array_path`：导航到数组的 jq 风路径（如 `.providers`、`.result.groups`）；空路径时根对象即数组，写 `[]`
- 量词 `any`：至少一个元素满足子谓词（空数组→false）
- 量词 `all`：所有元素满足子谓词（空数组→true，标准量词语义）
- 子谓词格式与普通 check 路径比较相同；不支持 exists/absent 一元 op、布尔连接词、嵌套谓词（违反原子性→拒载）

### 动作类型

| 动作键 | 功能 |
|--------|------|
| `requests` | 发 HTTP 请求列表 |
| `run` | POST /session/{sid}/run（同步等终态） |
| `poll` | 轮询 until 满足或超时 |
| `wait` | 等 SSE 命名流条件满足 |
| `sse.sub` | 订阅 SSE 命名流（配合 wait 使用） |
| `oracle` | Langfuse trace 有界轮询（未配置 langfuse 时自动 skip，不算 fail） |

**`requests` 步骤级可选 `timeout` 字段**（v0.0.151 起）：单次 HTTP 请求超时秒数，
int，范围 `[1, 240]`。**默认 30**（真 LLM 长同步调用才需要显式声明更长值，如
test-only 整理端点单请求可能 >30s），上限 240。仅 `requests`/`request` 动作类适用，
出现在其他动作类的 step 上直接拒载（poll/wait/oracle 各自已有独立超时字段）。
```yaml
steps:
  - name: 触发长耗时同步整理
    requests:
      - POST /test/consolidation/run
    timeout: 120          # 单请求超时 120s，覆盖默认 30s
```

### multipart/form-data 上传

`requests` 动作的 object-form 支持 `multipart` 字段，用于文件上传端点（如 `POST /skill/upload`）。
有 `multipart` 时忽略 `body` 字段，请求以 `multipart/form-data` 编码发送。

```yaml
steps:
  - name: 安装 skill zip
    requests:
      - method: POST
        path: /skill/upload
        status: [200, 201]
        multipart:
          name: my_skill
          file:
            filename: my_skill.zip
            content: "PK\x03\x04..."
            content_type: application/zip
            # encoding: base64          # 可选；值为 base64 字符串时先解码
    save: { skillId: .id }
```

**注意**：multipart 仅支持 object-form，不支持简写 `METHOD PATH [JSON]`。变量插值（`{var}`）在 multipart 的所有字符串值中生效。

### files 原语（写入 DATA_DIR 内的 fixture 文件）

`setup`/`steps`/`teardown` 支持 `files` 动作，把 fixture 写入 `DATA_DIR/<path>`（相对路径，禁绝对路径/`../` 逃逸），供后续步骤读取（如会话 workspace 内的图片）。写入的文件在 case 结束（无论 pass/fail）自动清理。

```yaml
setup:
  - name: 植入图片 fixture 到会话 workspace
    files:
      - path: "workspaces/{sid}/photo.png"
        content: "iVBORw0KGgoAAAANSUhEUgAA..."   # base64 字符串
        encoding: base64                          # 二进制内容：解码后原始字节写入
      - path: "notes.json"
        content: { hello: "world" }                # 默认（无 encoding）：dict，JSON 序列化文本写入
```

- 默认（无 `encoding`）：`content` 必须是 dict，序列化为 JSON 文本写入。
- `encoding: base64`：`content` 必须是非空 base64 字符串，解码为原始二进制字节写入（用于图片等真实二进制 fixture，`[v0.0.141]` D2 扩展，比照 multipart 文件字段既有约定）。

## AT 结果产物

```
states/<version>/verify/api-test/
├── run_all_result.json    # 聚合结果（overall/pass_count/fail_count + cases[]）
└── progress.jsonl         # 运行日志（start/case_start/case/done 事件）

tests/api/{module}/{case_id}/last_run/
├── result.json            # 最后一次 case 结果
└── steps/{NN}/            # 各步骤产物
    ├── checks.json        # check 结果
    ├── responses.json     # HTTP 请求/响应
    └── events.jsonl       # 本步骤增量 SSE 事件
```

## AT 异步场景断言配方

可直接抄到 `case.yaml`，每条含场景描述、可复用片段、一行陷阱注记。

### 配方 1：等异步任务完成

```yaml
steps:
  - name: 启动任务
    requests:
      - POST /session/{sid}/run {"content": "hello"}
        status: [200]
    check:
      - .status == "completed"          # /run 同步返回终态

  - name: 验证任务结束 SSE 帧
    check:
      - main.count(type=run_end,status=done) >= 1
```

> 陷阱：`running` 帧也算一帧，需带 status 过滤 `type=run_end,status=done` 才能精确等完成。

### 配方 2：fire-and-forget 触发验证（202 受理 ≠ 完成）

```yaml
steps:
  - name: 触发操作
    requests:
      - POST /job/start
        status: [202]
    save: { jobId: .id }

  - name: 轮询等完成
    poll:
      request: GET /job/{jobId}
      until: .status == "done"
      timeout: 60
    check:
      - .status == "done"
      - .result exists
```

> 陷阱：202 只证明任务被受理，不证明完成；必须 poll until 非终态字段变化。

### 配方 3：SSE 事件序列断言

```yaml
steps:
  - name: 订阅 SSE 流（先订阅后触发）
    sse:
      sub:
        - topic: session
          group: "{sid}"
          as: main

  - name: 触发 run
    run:
      content: "hello"

  - name: 等待 run 结束
    wait:
      stream: main
      until: main.count(type=run_end) >= 1
      timeout: 30

  - name: 断言事件序列
    check:
      - main.order(run_start < run_end)
      - main.count(type=run_end) == 1
      - main.absent(type=error)
```

> 陷阱：每个 step 的 `sse.sub` 只订阅自己 step 声明的 topic+group 组合；先订阅后触发才能捕获到全部事件。

### 配方 4：动态实体唯一化

```yaml
  - name: 创建会话
    requests:
      - POST /session {"title": "test-{case_id}"}
    save: { sid: .id }

  - name: 断言会话存在
    requests:
      - GET /session/{sid}
    check:
      - .id == "{sid}"        # 用 id 精确匹配，不用 name
      - .title exists
```

> 陷阱：`check` 中字符串字面量不做变量插值，需靠 save 后用 id 比对而非 name。

### 配方 5：错误路径断言

```yaml
steps:
  - name: 无效请求 → 400
    requests:
      - POST /session {}
        status: [400]
    check:
      - .error exists
      - .error ~= "required"

  - name: 越权 → 403 或 404
    requests:
      - GET /session/nonexistent-id
        status: [403, 404]
```

> 陷阱：`status` 支持数组，用于同一端点对不同违规返回不同状态码。

### 配方 6：snake_case 字段与归零态字段

```yaml
  check:
    - .usage.total_tokens >= 1       # 正确（snake_case）
    - .usage.input_cache_read >= 0   # 正确
    # 错误：<missing>（camelCase 不命中）

    - .status == "completed"         # 稳定存在
    - .id exists                     # 稳定存在
    # 避免：.retryCount == 0（首次执行时字段可能不在响应中）
```

> 陷阱：归零态字段整个省略导致断言 `== 0` 因 `<missing>` 而 fail，改用 `exists` 或 `absent`。

## AT runner 框架自测

```bash
python3 tests/api/lib/selftest/run_selftest.py
```

纯逻辑自测（不依赖 server），覆盖 check_engine / case_loader / sse_collector / multipart 等核心模块。框架代码不写自动化测试（套娃），质量靠 selftest + 真实跑 case 闭环验证。

## 429 skip 机制（v0.0.190 新增）

**保守谓词**（避免正常 fail 误判为 skip 导致假绿）：
- HTTP status ∈ {429, 503, 529}（覆盖 anthropic 529 overloaded + 通用 429/503）
- body `error.type` 或 `error.code` 字面量 ∈ {`rate_limit`, `overloaded`, `rate_limit_error`}（小写精确匹配）

**触发点**：
- `_do_requests`（step_exec.py）：HTTP 响应检测
- `_do_run`（step_exec.py）：`POST /session/:id/run` 同步响应检测；另检查 `stopReason == 'error' && lastError.type` 命中（异步 run 内部限流）

**流程**：step_exec 抛 RateLimitedError → run_case 捕获 → result='skipped', reason='429' → cleanup_written_files（finally 必跑）→ write_result → _run_all_exec 聚合 skipped_count++ → overall 不翻（仅 fail/timeout 翻 overall）。

## dev config 内容 copy（v0.0.190 新增）

env_start.sh 在 server 启动前 cp -rL 5 组 dev config 到 test DATA_DIR到 test DATA_DIR：

| 配置组 | 用途 |
|---|---|
| `web_search` | zhipu 真实 key（web_search 工具） |
| `see_image` | minimax_m3 真实 key（image 理解，`si1_minimax_multi_image` 硬前置） |
| `runtime` | langfuse 本地配置（oracle 用，可选） |
| `web` | jina 真实 key（web_fetch 工具） |
| `consolidation` | MiniMax-M3 daily 04:00（`t2_daily_consolidation` 用；case 内 step 也显式 PUT 覆写 `modelId`） |

幂等范式：`[ -d SRC ] && [ ! -e DEST ] && ln -s`；dev 不存在回退 test pool。**不 reuse**：`providers`（case 硬编码 test pool ULID `01KVJMPG2EZ1078MCT9JH4J5HG` 等）+ `default_models`（dev=deepseek，与 minimax 优先冲突）。

## 5 分类聚合（v0.0.190）

`run_all_result.json` schema：
```json
{
  "version": "v0.0.190", "overall": "pass",
  "total_count": 5, "pass_count": 3, "fail_count": 0, "timeout_count": 0,
  "not_run_count": 0, "skipped_count": 2,
  "wall_time_seconds": 45.2, "budget_hit": false,
  "cases": [
    {"case": "...", "result": "skipped", "skip_reason": "429", "detail": "..."},
    ...
  ]
}
```

**overall 判定**：`pass` iff `fail==0 && timeout==0`（skipped/not_run 不翻 overall）。

## 已知限制

**SSE case 当前失败（sse_dedup / sse_message_stream / sse_multi_subscriber）**：根因是 Bun 的 `ReadableStream` body 在队列空时不刷新 HTTP 响应头，导致 `urllib.request.urlopen` 无法在连接建立时立即返回。SSE 订阅成功后，事件在 run 完成时发出，但 sink 尚未加入 server 的 sinks 集合，事件被丢弃。需要 server 在 `openConnection()` 时主动推送初始注释帧（`:ping\n\n`）触发 HTTP 头立即刷新。框架层问题，不在 case 层修复范围。
