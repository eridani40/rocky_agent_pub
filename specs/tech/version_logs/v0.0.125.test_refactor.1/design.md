# v0.0.125.test_refactor.1 — AT 全面重构（tests_v2 全新开发）设计总纲

> 需求权威源：`reqs/[working] v0.0.125.test_refactor.1/req.md`（定稿 v3）。已拍板项不可偏离。
> 现状基线：`specs/tech/testing/`（v0.0.120 record/replay KB）。v2 在其上**泛化**（多桩点 + step 边界通知 + 静态 DSL），不复用 tests/ 脚本代码。
> 本文件超 300 行按主题拆分——本页是目录 + 全局设计决策 + 概念模型；细节见分文件。

## 0. 分文件导航

| 文件 | 管什么 |
|---|---|
| 本页 `design.md` | 概念模型（三层 + 存储面）· 全局设计决策 · runner v2 模块划分 · 双关验收编排 · req 未覆盖处补充决策清单 |
| [`design_case_schema.md`](design_case_schema.md) | case.yaml 字段级 schema（类型/必填/默认/校验/拒载规则）· step 动作类互斥 · 变量插值语法 |
| [`design_check_lang.md`](design_check_lang.md) | check 表达式文法（path 语法 · op 集 · 事件流函数 · 原子性机器判定） |
| [`design_stub_protocol.md`](design_stub_protocol.md) | 桩控制协议（`/test/stub` + `/commit` schema）· 多桩点 registry 泛化 · step 边界通知 · stub 标记核对 |
| [`design_storage_runall.md`](design_storage_runall.md) | per-step 存储布局 · result.json/events.jsonl schema · run_all v2 · server 侧改动清单 |

## 1. 概念模型：三层 + 存储面

```
① 执行层 Runtime     每轮外部传入 MODE（record|replay|live），case 文件零改动
② case 描述层        case.yaml 纯静态声明 DSL（动作/订阅/标记/检查/提取）
③ 打桩层 Stub Plane  server 出站边界拦截（多桩点游标式帧消费）
   存储面            <case>/recordings/（桩帧，入 git）+ last_run/（per-step 运行产物，gitignore）
```

**输入面 / 输出面 二分**（req §1 拍板，v2 核心）：

| 面 | 内容 | record 轮 | replay 轮 |
|---|---|---|---|
| **输入面 = 打桩** | `llm` / `web_search` / `web_fetch` 出站 | 真调 + 记帧 | 无脑喂帧（零出网） |
| **输出面 = 观察** | HTTP response / SSE 事件序列 / langfuse trace | 真实产生 → 全收 → check | 真实产生 → 全收 → check（SSE 照跑照收；langfuse 跳过） |

**关键不变量**（贯穿全设计）：
1. **SSE 是被测物不是桩**——不录制、不回放；record/replay 两轮都真实开流真实收帧。
2. **框架不并行**——单活跃 case，SSE 流干净、DATA_DIR 独占、桩 registry 单槽。这是「进程内全局 registry + step 边界通知」成立的前提。
3. **等待 ≤10s 硬顶**——poll/wait/oracle 的 timeout 上限 10s，超限 case **拒载**（schema 校验失败，不执行）。
4. **无逃生舱**——无 custom.sh / 无 script 字段；DSL 不够 → 补原语或降级 UT。
5. **验证原子**——一条 check = 单 path + 单 op + 单期望值；每条独立出结果、fail 附 actual。
6. **帧唯一来源 = 机器录制**——无手写剧本；legacy mock 剧本在 v2 废除（computer_use 类改真录制或移出 AT）。

## 2. 全局设计决策（三段式）

### 2.1 语言：runner v2 用 Python（与现 runner 同栈）

**结论**：runner v2、run_all v2 用 Python 3（stdlib only + PyYAML），不换栈。
**理由**：现 `runner.py` 已是 Python；port_alloc/timeout_guard 惯例是 bash+python3 混编（timeout_guard 本体就是 python 子进程）。DSL 解析（YAML → check 表达式文法 → 事件流函数）在 Python 里天然（无需引第三方 parser，手写递归下降即可）；SSE 长连接后台收集用 Python `threading` + `requests`/`httpx` stream。换 TS/Node 会引入第二套运行时依赖且不复用现有 timeout_guard。
**反例**：若用 bash 解析 YAML + check 表达式，文法（`[field=value]` 过滤 / `count()` 事件函数 / 原子性判定）根本写不动——这正是旧框架 checkpoint.json 用 JSON 三元组 `{path,op,value}` 而非表达式的原因。v2 要表达式文法，必须有真 parser，Python 是最低成本选择。

### 2.2 桩 registry：从「单桩点单 buffer」泛化为「多桩点独立通道」

**结论**：`RecordReplayRegistry` 单例保留，但内部从「llm/web_search 共用一个 `pickFetch` + 一个 seq map + 一个 llm buffer」泛化为 **per-stub-point 独立通道**：`{llm, web_search, web_fetch}` 各持独立 buffer / cursor / seq / manifest 帧文件 / drift 判定。
**理由**：req §4「每桩点帧队列 + 游标独立化」「帧不够/用不完/指纹不符 → drift 每桩点独立」。现状 `pickFetch(registry)` 被 llm 和 web_search **共用同一函数**，共享 `recordSeqMap`/`llmBuffer`——若一个 case 既撞 llm 又撞 web_search，两者混录到同一 seq 序列、同一 `llm.jsonl`，回放时游标互串。v2 必须按桩点分道：`llm.jsonl` / `web_search.jsonl` / `web_fetch.jsonl` 各自 seq 从 0 起、各自 cursor、各自 drift。
**反例**：不分道则「web_fetch 桩点接线」（req 说已存在）落不了地——jina-fetcher 现调 `pickWebFetch` 与 llm 共用 registry 单槽，帧会写进 llm 序列。

### 2.3 stub 标记核对：靠「step 边界通知」而非请求体匹配

**结论**：runner 在**每个 step 开始前**调 `POST /test/stub/step { stub: [<本 step 声明的桩点>] }` 告知 server「当前 step 声明会撞哪些桩点」。server registry 据此：record 轮记录「本 step 实际撞了哪些桩点」用于核对（标了没撞 / 撞了没标 → commit 时报 loud）；replay 轮遇到**未声明桩点的出网**→ fail loud（不静默出网）。
**理由**：req §4「replay 中未标步骤出网 → fail loud」需要 server 知道「当前处于哪个 step、该 step 声明了什么」。出站函数（llm/web_fetch）在 server 内部异步发起，脚本层拿不到，唯一办法是 runner 主动在 step 边界推送声明给 registry（框架不并行 → 单槽 currentStep 无竞争）。
**反例**：若靠请求体匹配判断「该不该打桩」，等于回到 legacy 的脆弱匹配；游标模型的整个价值就是「不匹配请求体，按序消费」——所以「该不该打桩」这个正交判定必须由 step 声明显式给出。

## 3. runner v2 模块划分（每文件 ≤300 行）

runner v2 落 `tests_v2/api/lib/`，Python 包结构（`run_case.py` 入口 + 子模块）：

| 文件 | 职责 | 预估行 |
|---|---|---|
| `run_case.py` | case 入口：加载 → setup/steps/teardown 编排 → commit → 写 last_run。timeout_guard 包住（bash 层） | ~180 |
| `case_loader.py` | YAML 加载 + schema 校验（字段/类型/必填/默认/拒载规则）→ 结构化 Case 对象；校验失败 raise `CaseLoadError` | ~220 |
| `step_exec.py` | step 分发器：按动作类（requests/run/poll/wait/oracle）路由到 handler；每 handler 一函数 | ~260 |
| `sse_collector.py` | step 级 SSE 收集器：`GET /sse` 单长连接（后台线程）+ 多次 `POST /sse/subscribe`；命名流缓冲；case 结束关流 | ~200 |
| `check_engine.py` | check 表达式解析 + 求值（path/op/事件流函数）；per-check 独立结果 + actual | ~280 |
| `interp.py` | 变量插值（`{var}` / `.field` 提取 / save）+ HTTP 请求原语（method/path/body/status） | ~160 |
| `artifacts.py` | per-step 产物写入（steps/NN/{responses.json,events.jsonl,checks.json}）+ result.json 汇总 | ~150 |

> `check_engine.py` 逼近 280 行（表达式文法最复杂）——若实现时超 300，把「事件流函数 count/order/absent」抽 `check_events.py`。architect 预留此拆分点，coder 编码时定。

## 4. 双关验收编排（record PASS → replay PASS）

**决策**：双关编排放 **run_all v2 层**（不放 orchestrator 层）。

- **新增/重录 case**（`MODE=record` 或 replay 命中 recordings 缺失自动切 record）：run_all 对每个 record case **跑完 record 轮 PASS 后，自动紧接一轮 replay**，两轮都 PASS 才标该 case `pass`；record PASS 但 replay FAIL → 标 `fail`（录制不可离线回放，需查动态 marker/时序）。
- **纯 replay 轮**（MODE=replay，recordings 齐全）：单轮回放，不触发 record。
- **理由**：双关是「录制交付物合格」的机器判定（record 绿只证真 LLM 路径通，replay 绿才证离线可用），属**执行层机械编排**，不需人裁决——放 run_all 消除 orchestrator 手动「先 record 再 replay」的两次委派。orchestrator 只需 `MODE=record CASES=... run_all`，run_all 内部完成双关并在聚合里体现（见 `design_storage_runall.md §3`）。

## 5. req 未覆盖处的补充决策清单（供 orchestrator 审）

以下是 req 定稿 v3 未明确、我在设计中补的决策，逐条列出：

| # | 决策点 | 我的补充决策 | 理由 |
|---|---|---|---|
| D1 | golden transcript 是否保留 | **v2 不做 golden**（废弃 golden-recorder 在 v2 的角色）。结构断言改由 case.yaml 的 check（response/SSE 断言）显式表达 | req 明确「验证原子 + check 三类同一语言」；golden 是隐式结构快照，与「显式原子 check」哲学冲突。coder 在 case.yaml 里写 `check: .messages[role=tool].count == 1` 比 golden 黑盒 deep-equal 更可读可调 |
| D2 | web_fetch 是否真已接线 | **本期只泛化 registry + 端点**；web_fetch 桩点接线现状 = jina-fetcher 走 `pickWebFetch`（与 llm 共用）。泛化后 jina/zhipu 出站改经 **web_fetch/web_search 专用决策点**（registry 分道），业务代码零改动仅换决策点函数名 | req §4「新桩点接线 = 出站调用改经决策点，llm/web_fetch/web_search 已有接线模式」。现状是共用一个 pickFetch，v2 拆成 `pickLlmFetch`/`pickWebSearchFetch`/`pickWebFetchFetch` 三选择器 |
| D3 | `POST /session/:id/run` 复用 | `run` 原语直接打 `POST /session/:id/run`（test-only sync wrapper，返 200 + `{state,stopReason,error,messages}`），不自己 poll | 该端点已存在且正是「同步等 agent loop 终态」，消除 poll flaky。req §3 `run: {content}` 语义即此 |
| D4 | 桩控制端点命名 | 新端点 `POST /test/stub` + `POST /test/stub/commit` + `POST /test/stub/step`（req §4 只给前两个，step 边界通知是我补的第三个）。**旧 `/test/llm-mode` 保留**（tests/ 旧框架仍用），v2 用新 `/test/stub` 前缀，二者共存不冲突 | tests_v2 全新目录，旧 tests/ 原样运行（req §7）；端点也隔离，`/test/stub` 泛化多桩点，`/test/llm-mode` 冻结在 llm 单桩点 |
| D5 | drift 在双关/纯 replay 的处置 | drift 独立分类（不算 fail、单列计数、不翻 overall）沿用 v0.0.120。**record 轮不会 drift**（录制不比对）；replay 轮 drift = 录制过时信号 → run_all 标 `drift`，orchestrator 安排重录 | req §4「drift 独立分类 ≠fail」+ CLAUDE.md record/replay 判定规则 3 |
| D6 | SSE 订阅的 topic 合法集 | v2 `sse.sub` 的 topic 必须 ∈ server `ALLOWED_TOPICS`（`agent_loop`/`session_panel`/`session_meta`）；group 按 §4.2 契约（`session_id:<sid>_amt:current` 等）。runner 不校验 topic 白名单（server 会 400），但 schema 校验 `sub` 结构完整性 | 对齐 `04-agent-session.md §4.2` 现有 SSE 契约，不发明新 topic |
| D7 | live 轮 langfuse/网络 | `requires: live` case 只在 `MODE=live` 跑；其它 MODE 下 **skip（not_run，原因 requires_live）**。langfuse oracle 仅 record/live 轮生效，replay 轮 oracle step 自动跳过（不算 fail） | req §2/§5「live smoke 白名单」「langfuse 仅 record/live 轮」 |
| D8 | teardown 失败处置 | teardown 必执行（即使 steps fail）；teardown 内 step 的 check fail 记入 result 但**不影响 case 主判定**（case 判定只看 steps）。teardown 是清理，其断言仅诊断用 | req §3「teardown 必执行（fail 也跑）」；清理断言不该反过来判 case 失败 |
| D9 | tests_v2 env 脚本 | tests_v2 复用 port_alloc 的**同一 `.env_port` 文件**（per-worktree 端口全局唯一，AT/ET/v2 共享），但 tests_v2 有独立 `env_start.sh`/`env_shutdown.sh`（起同一 server，NODE_ENV=test）。**v2 与旧 tests/ 不可并发**（共享 DATA_DIR + 端口，框架不并行铁律） | req §7 全新目录 + 框架不并行；端口注册表是全局资源不能双份 |
| D10 | 输出目录 | run_all v2 聚合落 `states/<version>/verify/api-test-v2/`（与旧 `api-test/` 隔离），支持 ROUND 隔离 | req 指定 `api-test-v2/`；沿用旧 run_all 的 ROUND 机制 |

## 6. 与现状 spec 的对齐/偏离说明

- **对齐**：桩点拦截仍在 fetchImpl 注入口（`specs/tech/testing/record-replay.md §3.1`，全链路真实）；FAIL 绝不落盘（§3.3）；脱敏硬约束（§ redact）；drift ≠ fail（§3.2）。这些不变量 v2 全部继承。
- **偏离（v2 泛化，doc-modifier 阶段 5 需同步 testing KB）**：
  - 单桩点 → 多桩点（registry 内部结构变）。
  - `/test/llm-mode` → v2 用 `/test/stub`（新端点，旧保留）。
  - 新增「step 边界通知」概念（`/test/stub/step` + registry `currentStepStubs`）。
  - golden 在 v2 退役（D1）。
  - ALS session 分道现状（`_default` 单道）在 v2 单 session case 无碍；多 session case 归 live 白名单（沿用 v0.0.120 已知债，不在本期解锁）。
