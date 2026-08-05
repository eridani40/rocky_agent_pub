# v0.0.125.test_refactor.1 变更计划书 — AT 全面重构（tests_v2 全新开发）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 设计权威：`design.md` + `design_case_schema.md` + `design_check_lang.md` + `design_stub_protocol.md` + `design_storage_runall.md`（同目录）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | testing-server（server 侧桩基建） / runner-v2（Python runner） / runall-v2（bash 编排） / cases-v2（case.yaml） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 |
| 影响行 | +N / -M |

## A 组 — server 侧桩点泛化（只动 testing/ + 路由 + 3 处出站换名）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| testing-server | app/server/src/testing/types.ts | `StubPoint` | 新增 | `type StubPoint = 'llm'\|'web_search'\|'web_fetch'` | MUST 三值闭合 | design_stub_protocol §1 | +2 |
| testing-server | app/server/src/testing/types.ts | `StubChannel` | 新增 | interface：per-point `{seqMap,buffer,cursorMap,replaySet,driftEvents}` | MUST NOT 与旧 `LlmMode` 冲突 | design_stub_protocol §1 | +14 |
| testing-server | app/server/src/testing/types.ts | `StubAudit` / `UndeclaredHit` | 新增 | commit 核对结果类型（declared_not_hit/hit_not_declared/undeclared） | — | design_stub_protocol §3.3/§4 | +12 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `RecordReplayRegistry.channels` | 新增 | 私有字段 `channels: Record<StubPoint, StubChannel>`；setActiveCase 按 mode 初始化三通道 | MUST 每通道独立 seq/cursor/buffer；框架不并行前提单槽 | design_stub_protocol §1；testing/record-replay.md §3.1（不变量继承） | +40 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `setActiveCase()` | 修改 | 泛化：初始化三通道（replay 各 loadReplaySet(point)，record 各清 buffer）；auto record 决策沿用（manifest 缺失切 record） | MUST 复用现有 mode 决策；MUST NOT 破坏 replayFetchInstance 复用（suspend-resume 修复） | 现 registry setActiveCase；design_stub_protocol §3.1 | +30/-10 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `setCurrentStep()` | 新增 | 存 `currentStep={index,declared:Set<StubPoint>}`（step 边界通知落点） | MUST 单槽（框架不并行） | design_stub_protocol §3.2 | +8 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `getCurrentStep()` | 新增 | 返当前 step 声明（replay 出站检查用） | — | design_stub_protocol §4 | +3 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `recordStubHit()` | 新增 | record 轮记录「本 step 撞了哪个 point」→ actualHitByStep；replay 轮检查 declared 不含 → 累积 undeclaredHits | MUST replay 未声明出网抛 `UndeclaredStubError` 不放行真出网 | design_stub_protocol §4 | +18 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `getStubAudit()` | 新增 | 汇总 declared_not_hit/hit_not_declared/undeclaredHits（commit 响应用） | — | design_stub_protocol §3.3 | +14 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `commitIfPassed()` | 修改 | 泛化：PASS 各通道 flushRecordings(point)；FAIL 各通道 clearBuffer | MUST FAIL 绝不落盘（现状铁律继承） | 现 registry commitIfPassed；testing/record-replay.md §3.3 | +20/-8 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `getDriftEvents()` | 修改 | 聚合三通道 driftEvents | — | design_stub_protocol §5 | +6/-2 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `pickLlmFetch()` | 新增 | 选择器：绑定 channels.llm，按 mode 返 record/replay/undefined（取代旧 `pickFetchImpl` 语义，但走 llm 通道） | MUST NOT 进 prod 路径（非 test → null） | design_stub_protocol §2；testing/record-replay.md §④原则2 | +12 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `pickWebSearchFetch()` | 新增 | 选择器：绑定 channels.web_search | 同上 | design_stub_protocol §2 | +12 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `pickWebFetchFetch()` | 新增 | 选择器：绑定 channels.web_fetch | 同上 | design_stub_protocol §2 | +12 |
| testing-server | app/server/src/testing/recording-codec.ts | `appendRecording(point,rec)` | 新增 | 泛化 append：按 point 落对应 buffer（取代仅 `appendLlmRecording`/`appendWebSearchRecording`） | — | design_stub_protocol §1 | +14 |
| testing-server | app/server/src/testing/recording-codec.ts | `flushRecordings(point,dir,manifest)` | 修改 | 加 point 参数：落 `<point>.jsonl`；manifest 记多桩点帧数 | MUST 同步 writeFileSync（现状继承）；MUST NOT 混桩点帧 | 现 codec flushRecordings；design_storage_runall §1 | +20/-8 |
| testing-server | app/server/src/testing/recording-codec.ts | `loadReplaySet(point,dir)` | 修改 | 加 point 参数：读 `<point>.jsonl` | — | 现 codec loadReplaySet；design_stub_protocol §1 | +8/-3 |
| testing-server | app/server/src/testing/recording-codec.ts | `computeWebFetchFingerprint(init)` | 新增 | url_hash 指纹（web_fetch drift 判据） | MUST record/replay 两侧走同一构造（现状指纹收敛原则） | design_stub_protocol §5 | +12 |
| testing-server | app/server/src/testing/recording-codec.ts | `clearBuffer(point?)` | 修改 | 加可选 point：省略清全通道 buffer | — | 现 codec clearBuffer | +6/-2 |
| testing-server | app/server/src/testing/recording-fetch.ts | `createRecordingFetch(point,...)` | 修改 | 加 point 参数：录制落对应通道 + 调 registry.recordStubHit(point) | MUST tee 透传业务链路（现状不破坏 parseStream） | 现 recording-fetch；design_stub_protocol §2 | +14/-4 |
| testing-server | app/server/src/testing/replay-fetch.ts | `createReplayFetch(point,...)` | 修改 | 加 point 参数：取对应通道 replaySet；出站前查 currentStep.declared 不含 point → 抛 UndeclaredStubError；指纹按 point 维度 checkDrift | MUST replay 零出网；MUST NOT 未声明放行真 fetch | 现 replay-fetch；design_stub_protocol §4/§5 | +26/-6 |
| testing-server | app/server/src/testing/replay-fetch.ts | `UndeclaredStubError` | 新增 | class extends Error（携 step+point+url_hash） | — | design_stub_protocol §4 | +14 |
| testing-server | app/server/src/testing/stub-handler.ts | `handleTestStub()` | 新增 | `POST /test/stub`：二次 gate → setActiveCase(case,mode,dir) → 200 | MUST test-only 双重 gate（对齐 session-run.ts:117） | design_stub_protocol §3.1；04-agent-session §3.2 gate 范式 | +40 |
| testing-server | app/server/src/testing/stub-handler.ts | `handleTestStubStep()` | 新增 | `POST /test/stub/step`：setCurrentStep(index,declared) → 200 | MUST 校验 declared ⊆ StubPoint | design_stub_protocol §3.2 | +30 |
| testing-server | app/server/src/testing/stub-handler.ts | `handleTestStubCommit()` | 新增 | `POST /test/stub/commit`：读 audit+drift → commitIfPassed → 回传 frames/stub_audit/drift/undeclared | MUST FAIL 不落盘；drift/undeclared 不静默 | design_stub_protocol §3.3；testing/record-replay.md §3.2 drift 回调 | +50 |
| testing-server | app/server/src/router.ts | `/test/stub` 挂载 | 新增 | dispatch：`path.startsWith('/test/stub')` → gate → step/commit/base 三分支（对齐 :430 `/test/llm-mode` 挂载） | MUST NODE_ENV!=='test'→404 | 现 router.ts:430；design_stub_protocol §7 | +12 |
| testing-server | app/server/src/llm-client-factory.ts | `buildLlmClient()` 出站接线 | 修改 | `pickFetchImpl(getRegistry(),env)` → `pickLlmFetch(getRegistry())`（机械换名，逻辑零改） | MUST NOT 改 fetchImpl 注入点语义 | 现 factory:90；design_stub_protocol §2/D2 | +1/-1 |
| testing-server | app/server/src/tools/web-fetch/jina-fetcher.ts | `JinaFetcher.fetch()` 出站接线 | 修改 | `pickWebFetch(getRegistry())` → `pickWebFetchFetch(getRegistry())`（机械换名） | MUST NOT 改 proxyFetch 兜底逻辑 | 现 jina-fetcher:94；design_stub_protocol §2 | +1/-1 |
| testing-server | app/server/src/testing/record-replay-registry.ts | `pickFetchImpl` / `pickWebFetch` | 删除 | 旧共用选择器（被三专用选择器取代）；**coder 编码时 grep 确认无 tests/ 旧框架引用后删；有引用则保留并汇报** | MUST 删前确认无外部引用 | 现 registry:282/293；原则#2 死代码 | -35 |

> **A 组开放点（coder 定位 + 汇报，MUST 报 orchestrator）**：**web_search 桩点接线现状缺失**——web_search 走 `WebSearchProviderPoint` ext plugin（`provider.search`），出站在**外部 plugin 实现**里，主代码 `app/server/src/tools/web-search/tool.ts` 无 fetch、无 `pickWebFetch` 接线（现状只 web_fetch/jina 接了）。`pickWebSearchFetch` 选择器可建，但**实际接线点在 ext plugin 内**，本期主代码可能无法接线。coder 需 grep 确认 web_search provider 出站 fetch 的真实位置：若在主代码可接，接之；若在 ext plugin，标注「web_search 桩点接线本期不落地，需后续版本在 plugin 侧接」并汇报。**不阻塞 llm/web_fetch 两桩点交付**（req 主目标是 AT 重构，web_search case 少）。

## B 组 — runner v2（Python，全新 tests_v2/api/lib/）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| runner-v2 | tests_v2/api/lib/run_case.py | `main()` | 新增 | case 入口：load → setup/steps/teardown 编排 → /test/stub commit → 写 result.json；每 phase step 调 /test/stub/step | MUST 单文件 ≤300；MUST teardown 必跑（steps fail 也跑） | design.md §3；design_case_schema §1 | +180 |
| runner-v2 | tests_v2/api/lib/case_loader.py | `load_case(path)` | 新增 | YAML 加载 + schema 校验 → Case 对象；拒载 raise CaseLoadError | MUST 拒载：timeout>10 的 wait/poll/oracle、未知字段、多动作类、非原子 check、重名流 | design_case_schema §1-§6；req 硬规则 | +220 |
| runner-v2 | tests_v2/api/lib/case_loader.py | `CaseLoadError` | 新增 | 加载校验异常（case 标 not_run(load_error)） | — | design_case_schema §1 | +6 |
| runner-v2 | tests_v2/api/lib/step_exec.py | `exec_step(step,ctx)` | 新增 | 动作类分发器（requests/run/poll/wait/oracle 路由）+ save + check | MUST 至多一动作类；wait/oracle ≤10s | design_case_schema §3；design.md §3 | +60 |
| runner-v2 | tests_v2/api/lib/step_exec.py | `_do_requests(step,ctx)` | 新增 | HTTP 请求（含简写文法解析 + 插值 + status 校验） | — | design_case_schema §3.1 | +40 |
| runner-v2 | tests_v2/api/lib/step_exec.py | `_do_run(step,ctx)` | 新增 | 打 `POST /session/{sid}/run` 同步等终态；返 {state,stopReason,error,messages} 作主输出 | MUST 复用 /run（不自 poll）；sid 缺失报错 | design_case_schema §3.2；04-agent-session §3.2 /run 契约 | +30 |
| runner-v2 | tests_v2/api/lib/step_exec.py | `_do_poll(step,ctx)` | 新增 | 轮询 request until check，every 间隔，≤10s 超时 fail | MUST timeout≤10（load 已校验） | design_case_schema §3.3 | +36 |
| runner-v2 | tests_v2/api/lib/step_exec.py | `_do_wait(step,ctx,streams)` | 新增 | 对命名流缓冲每 100ms 求 until，≤10s | MUST stream 须已声明 | design_case_schema §3.4 | +30 |
| runner-v2 | tests_v2/api/lib/step_exec.py | `_do_oracle(step,ctx)` | 新增 | langfuse 有界轮询 ready_when；replay 轮 skip | MUST replay 轮跳过不算 fail；仅 record/live | design_case_schema §3.5；langfuse-sdk-gotchas memory | +40 |
| runner-v2 | tests_v2/api/lib/sse_collector.py | `SseCollector` | 新增 | class：`GET /sse` 单长连接（后台线程）+ subscribe(topic,group,as) + 命名流缓冲 + close | MUST case 结束才关流；不录不回放（被测物） | design.md §1 不变量1；design_case_schema §4；04-agent-session §4 | +200 |
| runner-v2 | tests_v2/api/lib/check_engine.py | `parse_atomic(expr)` | 新增 | 表达式 tokenize + 原子性判定 → AtomicCheck AST；非原子 raise | MUST 顶层 op≤1 + 无布尔连接词 + 括号仅函数 | design_check_lang §0/§4 | +90 |
| runner-v2 | tests_v2/api/lib/check_engine.py | `eval_check(ast,ctx,streams)` | 新增 | 按 source 分派（response/stream/trace）求值 → {expr,pass,actual,note} | MUST fail 附 actual | design_check_lang §1/§2/§5 | +70 |
| runner-v2 | tests_v2/api/lib/check_engine.py | `eval_path(obj,path)` | 新增 | path 求值（.field/[N]/[-1]/[field=value]） | — | design_check_lang §1 | +60 |
| runner-v2 | tests_v2/api/lib/check_engine.py | `eval_stream_fn(stream,fn)` | 新增 | 事件流函数 count/order/absent | MUST count 配 op；order/absent 一元 | design_check_lang §3 | +50 |
| runner-v2 | tests_v2/api/lib/interp.py | `interpolate(val,ctx)` | 新增 | `{var}` 插值（path/body/group） | MUST 未定义变量 load 期已拒载 | design_case_schema §6 | +40 |
| runner-v2 | tests_v2/api/lib/interp.py | `http_request(method,path,body,ctx)` | 新增 | HTTP 原语（拼 BASE_URL + 插值 + 返 {status,body}） | — | design_case_schema §3.1 | +40 |
| runner-v2 | tests_v2/api/lib/interp.py | `apply_save(step,main_output,ctx)` | 新增 | save 提取变量（path 求值失败 step fail） | MUST save 在 check 前 | design_case_schema §6 | +24 |
| runner-v2 | tests_v2/api/lib/artifacts.py | `write_step(dir,n,resp,events,checks)` | 新增 | 落 steps/NN/{responses.json,events.jsonl,checks.json} | MUST per-step 独立 | design_storage_runall §2 | +50 |
| runner-v2 | tests_v2/api/lib/artifacts.py | `write_result(dir,case_result)` | 新增 | 落 result.json（five-class + double_gate + stub/drift/undeclared） | — | design_storage_runall §2.4 | +50 |

> **B 组开放点**：`check_engine.py` 逼近 280 行——coder 实现时若超 300，把事件流函数（`eval_stream_fn` + parse）抽 `check_events.py`（design.md §3 预留）。

## C 组 — run_all v2 + env（bash，全新 tests_v2/api/）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| runall-v2 | tests_v2/api/lib/run_all.sh | run_all 主流程 | 新增 | MODE/CASES/MODULE/ROUND/BUDGET → env → 逐 case 串行 run_case.py → 双关编排 → 聚合 | MUST 全串行（框架不并行）；CASES 唯一白名单（无 AT_CASES）；progress.jsonl 三事件 | design_storage_runall §3；test-runall-cases-knob memory | +200 |
| runall-v2 | tests_v2/api/lib/run_all.sh | `_double_gate()` | 新增 | record PASS → 自动紧接 replay 轮；两轮全绿才 pass | MUST record FAIL 不触发 replay | design_storage_runall §3.4；CLAUDE.md record/replay 判定1 | (含上行) |
| runall-v2 | tests_v2/api/lib/run_all.sh | 聚合 five-class | 新增 | pass/fail/drift/timeout/not_run 分列 → api-test-v2/run_all_result.json | MUST drift 不算 fail 不翻 overall | design_storage_runall §3.3 | (含上行) |
| runall-v2 | tests_v2/api/env_start.sh | env_start | 新增 | 起 server NODE_ENV=test；端口复用 tests/lib/port_alloc.sh；DATA_DIR per-worktree | MUST 与旧 tests/ 不并发（共享端口+DATA_DIR） | design_storage_runall §5；D9 | +60 |
| runall-v2 | tests_v2/api/env_shutdown.sh | env_shutdown | 新增 | 读 .env_port 杀 pid + 清端口 + 删文件 | — | design_storage_runall §5 | +30 |
| runall-v2 | .gitignore | tests_v2 last_run | 修改 | 加 `tests_v2/**/last_run/` + `tests_v2/**/last_run.json`（recordings 入 git 不 ignore） | MUST recordings 不 ignore | design_storage_runall §6 | +2 |

## D 组 — 示例 case（cases-v2，本期建 1 个 smoke 骨架，129 case 重审是独立任务）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| cases-v2 | tests_v2/api/chat/chat_basic_reply/case.yaml | case DSL | 新增 | 路径 A smoke（建会话→run→纯文本回复）验证框架端到端 + 双关 | MUST 覆盖 requests/run/sse.sub/wait/check/stub 全原语 | design_case_schema §7；04-agent-session §10 路径 A | +40 |
| cases-v2 | tests_v2/api/chat/chat_basic_reply/recordings/ | llm.jsonl+manifest | 新增 | 首次 record 落盘（coder 跑 record 轮产出，双关验收后 commit） | MUST record PASS + replay PASS 才 commit | CLAUDE.md record/replay 判定1 | (机器产出) |
| cases-v2 | tests_v2/README.md | v2 框架文档 | 新增 | tests_v2 权威文档：部署 + MODE + 全命令 + DSL 速查 + 与旧 tests/ 边界 | — | design.md 全篇 | +120 |

## 影响面评估

- **跨模块**：testing-server（TS，8 文件）+ runner-v2（Python，7 文件）+ runall-v2（bash，3 文件）+ cases-v2（示例 1 case + README）。
- **破坏性**：A 组对**业务代码零逻辑侵入**——仅 3 处出站决策点机械换名（`pickFetchImpl`→`pickLlmFetch`、`pickWebFetch`→`pickWebFetchFetch`、web_search 待定）。旧 `/test/llm-mode` + tests/ 旧框架**原样保留**，二者共存。删旧共用选择器须先确认无引用。
- **依赖顺序**：A 组（server 桩基建）先于 B/C（runner 依赖 `/test/stub` 端点契约）；B 组 check_engine/sse_collector 是 run_case 依赖，先于 run_case.py 联调；D 组示例 case 最后（依赖 A+B+C 全就绪跑双关）。
- **风险点**：
  1. **web_search 桩点接线现状缺失**（A 组开放点）——现状主代码只 web_fetch 接了 `pickWebFetch`，web_search 走 ext plugin。coder 需确认真实接线点，本期可能只落 llm+web_fetch 两桩点，web_search 标待后续。**必须汇报 orchestrator**。
  2. **SSE 长连接后台收集 flaky 风险**（bun+python）——sse_collector 用 python requests/httpx stream + threading，须验证 SSE 帧不丢（对齐 performance-resource-timing memory：SSE 是长连接特性）。
  3. **双关 record→replay 自动编排**在 run_all 层——record 轮 flush 后立即 replay 读刚落盘 recordings，须确保同步 writeFileSync 完成（现状 flush 同步，无 sleep 需求）。
  4. **check_engine 表达式文法**是最复杂新增——原子性机器判定须严格（顶层 op 计数 + 布尔连接词扫描 + 括号仅函数），否则复合 check 漏网违反 req 硬规则。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
