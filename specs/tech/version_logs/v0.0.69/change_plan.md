# v0.0.69.test_refactor change_plan — 测试框架重构（tests）

> 输入：`reqs/[working] v0.0.69.test_refactor/issues.md`（P1–P9 九坑）
> 目标：**worktree add → bun install → 一条命令跑 AT，零坑可复现**
> 策略：建 `tests/` 并行实验 → 迁 3 个代表 case 验证 → 稳了整体替换 `tests/`
> 范围：本计划**含代码 + prompt/skill + agent 定义 + 约定**四层（非纯代码）

---

## 0. 核心判断

九坑里只有 P5（run_all CASES 匹配）、P6（note 文案）、P7（不自动 collect）是**纯代码 bug**；其余 P1/P2/P4/P8/P9 都有「约定/skill 没定死」的成分，P3 几乎全靠 skill 落地。所以本重构 = 代码改造 + SKILL.md 重写 + agent 定义对齐，三者缺一不可。

---

## 1. 架构决策（拍板，D1–D10）

### D1（P1+P2）test.env 拆「提交 schema」+「全局 secrets」
- `tests/test.env` **提交入库**：端口/结构/默认值/runner 桥接/MOCK_LLM=0，**无 secrets**。这是唯一 schema 权威源，杀掉 test.env.example 漂移。
- Secrets 从全局 `~/.rocky_agent/test.secrets.env` 读（一处，所有 worktree 共享）。env_start source 提交 schema 后叠加 source 全局 secrets（存在才 source）。
- env_start 启动前**校验必要 var**（SERVER_PORT/BASE_URL/DATA_ROOT/MOCK_LLM/各 key），缺了 fail-fast 指明缺哪个。
- **效果**：fresh worktree 零 cp。

**Key 审计**（grep app/+tests/ 真实消费点）：

| Key | 消费 | 处置 |
|-----|------|------|
| `ANTHROPIC/MINIMAX/GLM_API_KEY` | **0** | **DROP** — 死代码；LLM 凭证走 provider config，不经 env |
| `LANGFUSE_SECRET_KEY/PUBLIC_KEY/BASE_URL` | 98–125 | KEEP（observability） |
| `JINA_API_KEY` | 9 | KEEP（web_fetch/reader） |
| `ZHIPU_SEARCH_API_KEY` | 15 | KEEP（web_search） |
| `LLM_TEST_PROVIDER_ID/MODEL_ID` | **0** | **DROP** — 死别名；真实 override = `TEST_PROVIDER_ID/MINIMAX_PROVIDER_ID`（72/96，case 级） |
| `ROCKY_TEST_MOCK_LLM` | 143 | KEEP（committed schema，=0） |

**关键事实**：LLM 真凭证不在 env——在 `DATA_DIR/app_config/providers/*.json` 的 `credentials.key`（server 读 provider config）。部署只需 **5 个 secret**。

**部署文档（`tests/README.md`）**：
```
~/.rocky_agent/test.secrets.env:   # 一处配，所有 worktree 共享
  LANGFUSE_SECRET_KEY / PUBLIC_KEY / BASE_URL
  JINA_API_KEY
  ZHIPU_SEARCH_API_KEY
```
LLM 真服务：在 `DATA_DIR` 配 provider config（凭证进 provider 文件，不进 env）。env_start 启动打印各 key 就位状态（脱敏），缺只 warn 不挂。

### D2（P3）per-case `llm_mode` 字段
- checkpoint.json 新增 `"llm_mode": "real" | "none" | "any"`（缺省=`any`）。
  - `none`：不触 LLM（counter/config/session 字段）——任意 server 模式都跑
  - `real`：必须真 LLM——server=mock 时 SKIP（带原因）
  - `any`：mock/真都行
- server 默认 real（项目原则）。`none` case 本就不调 LLM，real server 下也是秒过。
- run_all 按 `llm_mode` 分组报告；`real` case 在 mock server 下 SKIP 不计 fail。

### D3（P4）杀 run.sh 样板，统一入口
- 唯一入口 `tests/api/lib/run_case.py <case_dir>`：source env → 跑 checkpoint → 写 last_run。
- 标准 case 只需 `checkpoint.json`（零样板）。
- 需要命令式逻辑（SSE/多轮/state 轮询）的 case：写 `custom.sh`，由 run_case.py source。**统一在入口 source test.env**，custom.sh 不再各写各的。
- 单 case 可直跑：`python3 tests/api/lib/run_case.py tests/api/counter/get_tc1`。

### D4（P5）case_id 权威源 = checkpoint.json 字段
- runner 从 checkpoint.json 读 `case_id`，**不再用 dir basename**。
- 约定 `case_id = <module>_<dir>`（现有 checkpoint 已如此，胜出）。
- CASES 过滤匹配 case_id；找不到 → warn + 列出可用 case_id（不静默 0）。

### D5（P6）runner note 模板修正
- pass：`"<actual> <op> <expected> ✓"`；fail：`"<actual> <op> <expected> ✗ (got X, want Y)"`。

### D6（P7）run_all + collect 合并
- 单脚本 `tests/api/lib/run_all.sh`：env → 跑 case → 聚合 → 写 run_all_result.json。一条命令出结果。

### D7（P8）DATA_DIR 按 worktree 隔离
- DATA_DIR = `~/.rocky_agent_test/<worktree-basename>/`（env_start 从 git worktree 名自动派生）。
- 多 worktree 并发不互踩；port 也按 worktree 哈希派生（配合 memory `e2e-cross-worktree-port-collision`）。

### D8（P9）VERSION 显式 or 从 worktree 派生
- 从 worktree dir 名解析 `v\d+\.\d+`；解析不出 → fail 报错。禁止静默写错版本目录。

### D9（PROMPT 核心）重写 `.claude/skills/api-testing/SKILL.md`
编码全部新约定（designer agent 的权威指令）：
- checkpoint.json schema **必须含 `llm_mode`**（不标 = any，但 LLM 触达 case 必须显式 real）
- case_id 命名 `<module>_<dir>`
- **不再写 run.sh 样板**——标准 case 只写 checkpoint.json；命令式逻辑落 custom.sh
- 单 case 必须可直跑（run_case.py 入口）
- secrets 走全局 `~/.rocky_agent/test.secrets.env`，case 内禁止硬编码 key

### D10 agent 定义对齐
- `api-test-designer.md` / `api-test-executor.md` / `e2e-test-designer.md` / `e2e-test-executor.md`：路径 `tests/` → `tests/`（迁移期共存，验收后切回）、入口改 run_case.py、强调 `llm_mode` 标注责任在 designer。

---

## 2. 变更清单

| # | 文件 / 符号 | 层 | 变更 | 约束 |
|---|------------|-----|------|------|
| C1 | `tests/test.env`（新建） | config | 提交 schema：端口/MOCK_LLM=0/runner 桥接，无 secrets | 单一 schema 源；杀 example 漂移 |
| C2 | `tests/api/env_start.sh`（新） | code | source schema + 全局 secrets；校验必要 var；DATA_DIR/VERSION 派生 | 缺 var fail-fast；不写/清 policy（memory runtime-no-ext-policy-write） |
| C3 | `tests/api/env_shutdown.sh`（新） | code | 按 worktree pidfile/port 清理 | 不误杀兄弟 worktree（memory e2e-cross-worktree-port-collision） |
| C4 | `tests/api/lib/run_case.py`（新） | code | 统一入口：source env→跑 checkpoint/custom→写 last_run | 读 case_id 自 checkpoint；note 模板 D5 |
| C5 | `tests/api/lib/runner.py`（新，fork 现有） | code | case_id 取 checkpoint 字段；note 模板修正；llm_mode 透传 | 与 run_all 共用 case_id 源 |
| C6 | `tests/api/lib/run_all.sh`（新） | code | env→跑→聚合一条龙；CASES 匹配 case_id；llm_mode 分组；VERSION 派生 | 合并 collect；找不到 case warn |
| C7 | `tests/api/counter/get_tc1/`、`inc_tc1/`（迁） | data | 迁入 tests，checkpoint 加 `llm_mode:"none"` | 验 D1-D6 |
| C8 | `tests/api/session/state_tc1/`（迁，custom） | data | 迁入 tests 作 custom.sh 范例，`llm_mode:"real"` | 验 D3 custom.sh 路径 + D2 real 分组 |
| C9 | `.claude/skills/api-testing/SKILL.md` | prompt | 重写：schema 含 llm_mode / case_id 约定 / 不写 run.sh 样板 / 单 case 可跑 / secrets 全局 | designer 权威指令 |
| C10 | `.claude/agents/api-test-designer.md` 等 4 个 agent def | prompt | 路径 tests、入口 run_case.py、llm_mode 责任 | 与 C9 对齐 |
| C11 | `tests/README.md`（新） | doc | 一条命令跑通说明 + worktree 零坑演示 | 验收依据 |

---

## 3. tests 目录

```
tests/
├── test.env                    # 提交（schema，无 secrets）
├── README.md                   # 一条命令跑通
└── api/
    ├── env_start.sh / env_shutdown.sh
    ├── lib/
    │   ├── run_case.py         # 统一入口
    │   ├── runner.py           # checkpoint 引擎（fork+修）
    │   └── run_all.sh          # env→跑→聚合
    └── counter/{get_tc1,inc_tc1}/   # none 桩
        session/state_tc1/           # real+custom 桩
```

---

## 4. 增量里程碑（一小步一确认，避免浪费 token）

每个里程碑结束 → 跑验证 → 报你确认 → 再进下一个。可随时停/调。

**M1 — 框架骨架 + 1 个 none case 端到端**
- C1 `test.env`（audited schema，无死 key）+ C2/C3 env_start/shutdown（校验+全局 secrets+DATA_DIR/VERSION 派生）
- C4 `run_case.py` + C5 `runner.py`（fork+修 note/case_id）+ C6 `run_all.sh`（合并 collect）
- 迁 `counter/get_tc1`（none）+ C11 README 部署说明
- **验证**：删 tests/test.env、清 DATA_DIR 模拟 fresh worktree → 一条命令 `bash tests/api/lib/run_all.sh` → get_tc1 PASS
- 验 D1/D3/D5/D6

**M2 — 第 2 个 none case + CASES/VERSION**
- 迁 `counter/inc_tc1`
- 验 D4（`CASES=counter_inc_tc1` 能匹配，不再静默 0）+ D8（VERSION 派生落对目录）

**M3 — real + custom.sh 路径**
- 迁 `session/state_tc1`（real + custom.sh）
- 验 D2（llm_mode real 分组 / mock 下 SKIP）+ D3 custom.sh + D7（DATA_DIR worktree 隔离）

**M4 — prompt 层**
- C9 重写 `api-testing/SKILL.md` + C10 对齐 4 个 agent def
- 用新 skill 让 designer 产 1 个全新 case 验证 skill 可执行

**M5 — E2E 镜像**
- `tests/e2e/` 复用 D1/D3/D4/D7（env 共享 AT，run_case.py 截图变体）
- 迁 1 个 ET case 验证

**最终门槛**：M1–M5 全绿后，后续版本再做 `tests/` 全量迁移替换。

## 4.x 单 case 直跑验收（贯穿 M1–M3）

每迁一个 case 必须能脱离 run_all 单跑（验 D3）：
`python3 tests/api/lib/run_case.py tests/api/<module>/<case>` → last_run.json 出 result

---

## 5. 风险与回退

- **隔离**：全部新代码在 `tests/`，不动 `tests/`。回退 = `rm -rf tests/`，零影响现有版本。
- **secrets 全局化**：迁移期 `tests/` 仍读旧 `test.env`，两套并存到验收。
- **skill 改动**：C9 改 SKILL.md 会影响 designer 后续产 case 方式——迁移期 designer 仍按旧 skill 写 tests/，新 case 才用 tests/；验收替换时统一切。
- **custom.sh 兼容**：现有 custom_shell case（cache_hit/state_tc1 等）的 run.sh 逻辑要转成 custom.sh，工作量大头在这里（非桩代码，逐 case 迁）。

---

## 6. 不在本版做

- 现有 `tests/` 全量迁移替换（M1–M5 全绿后另起版本做）
- 视觉/compare 流程改造（与框架低效无关；E2E 的 vision_check 流程 M5 原样保留）

---

## 7. D11 共享 helper（custom.sh 降难度核心）

custom.sh 里 SSE listener / 状态轮询 / langfuse oracle 是重复样板。抽到 `tests/api/lib/`：
- `sse.sh`：`sse_listen <sid> <outfile> <timeout>`（subscribe agent_loop+session_panel + 后台 listener）+ `sse_kill` + `sse_events_json <outfile>`
- `poll.sh`：`poll_state <sid> <accept_states_csv> <iters>`（轮询 GET /session state 直到命中集合）
- `langfuse.sh`：`langfuse_query <path>`（GET langfuse API，basic auth，oracle 用）

custom.sh 只写 case 特有逻辑（~20-30 行），不重复样板。

## 8. 迁移纪律（用户 MANDATORY）

- **每批 ≤ 10 case**，逐个验证通过
- fail **triage 三类**：① 测试框架 bug（我修）② 系统存量 bug（标理由，不修，记 BUG）③ case 设计 bug（标理由，可修 case）。不硬磕非测试问题
- **本质纯回归**（只重构测试、不改系统）——fail 多半是存量问题或 case 问题，不是我引入
- 进度记 `reqs/[working] v0.0.69.test_refactor/migration_log.md`（每 case：状态/结果/理由）→ 终态产出保留 case 清单 + 回归报告
- scope：AT 保留 ~50（30 标准 + 20 custom）/ ET smoke ~15
