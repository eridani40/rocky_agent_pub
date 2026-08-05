# v0.0.127 — ET（E2E 测试）框架重构

> 引入版本：v0.0.127 · 类型：**内部测试基建重构**（用户无直接感知；产品功能不变）
> 需求来源：`reqs/[working] v0.0.127/req.md`（12 决策 + ET 定位变更）+ `specs/research/v0.0.127/`（4 项调研：overview / infrastructure-b-sse-stub / case-inventory / recording-format / server-stub-extension）
> 概念权威源（MANDATORY 已读，对齐引用，不发明新概念）：
> - `specs/tech/`（各子系统 OKF KB）— 产品组件/接口语义不变，本版本只重构测试侧
> - `specs/ui/components/` 组件 spec — testid 契约不变，ET case 引用的 testid 仍从此读
> - AT 新框架（v0.0.125 落地）：`tests/api/` 的 `case.yaml` DSL + record/replay 双关 + stub 通道（llm/web_search/web_fetch）— ET 复用并对齐
> doc-sync 备注：本 version_log 为权威；`tests/README.md` + `.claude/skills/e2e-testing*` + `.claude/agents/e2e-test-*` 由 coder/doc-modifier 阶段同步

---

## 1. 背景与目标

### 1.1 现状

- **v0.0.125 AT 重构落地**：`tests/api/` 已用纯静态 `case.yaml` DSL + record/replay 双关 + per-step 产物 + fail 自解释 + selftest + frame_checks + stub 出站帧审计（57/57 绿，翻车率 W3→W6 持续降）。
- **ET 仍用旧框架**：`tests/e2e/` 仍是 `checkpoint.json` + `runner.py` + `/test/llm-mode` 端点，与 AT 不一致、维护成本高、缺 per-step 产物 / fail 自解释 / selftest。
- **旧 ET 的 workaround**：部分 case 把 `fetch + while-loop 轮询 DOM` 塞进一个 `js:` action（如 `sse_channel/squad_chat_usage_live_tc1`、`chat/abort_run_finish_tc1`），绕开 SSE 等待难，case 难读且难维护。
- **ET 定位本身也在演化**：v0.0.100 翻转判定模型为「dom 主判定 + vision 按需」，ET 已不是「真端到端」全链路验证，实质偏向「前端在真实后端下的 UI 集成测试」。

### 1.2 目标

**把 ET 框架对齐 AT 的新模型**，让 AT/ET 共用同一套 DSL + codec + stub 协议 + selftest 体系；并按 ET 专属需求（浏览器动作、SSE 时序保真）做最小扩充。

**核心定位变化（产品级决策）**：
- **ET 从「真端到端」转成「前端集成测试」**——给定后端响应测 UI 行为：
  - **record 轮**：真跑（server + LLM + 浏览器），录浏览器↔server 全栈交互（API 请求→响应 + SSE 事件序列）
  - **replay 轮**：浏览器重放操作，API/SSE 用录制（mock 后端，不真调 server，不起真 LLM）
- **AT 测后端 API、ET 测前端 UI，分工互补不重叠**：ET **不再覆盖后端 bug**（那是 AT 的活）；ET 只验「给定这些后端响应，UI 表现对不对」。

### 1.3 本版本无新产品概念

本版本**不引入任何产品侧新概念**（组件、接口、布局、数据结构均不变）。所有改动落在测试基建层：
- `tests/e2e/` 框架代码重构（旧 runner.py + checkpoint.json → 新 case.yaml DSL + Playwright step 执行层）
- `app/server/src/testing/` 扩展（`record-replay-registry` 加 http/sse 两通道 + 新增入站拦截器）
- `tests/e2e/lib/selftest/` 新增（框架唯一测试层，只能 UT）
- `tests/README.md` + `.claude/skills/` + `.claude/agents/` 文档同步

用户（终端 AI 用户）无感知；本 PRD 的「用户」是**项目自身的开发流程 + designer/executor agent**。

---

## 2. 功能需求（测试基建）

> 注：本章节是 PRD §3 的等价物。因本版本是测试基建重构（无终端用户功能），集中在此陈述。

### 2.1 case.yaml DSL 统一 + ET 专属 step 词汇表 [v0.0.127]

**描述**：ET case 从 `checkpoint.json` 迁到 `case.yaml`，与 AT 同源 DSL；在 AT 的 `requests`/`wait`/`poll`/`run`/`oracle` 基础上加 ET 专属 step（浏览器动作）。
**优先级**：P0
**用户故事**：作为 e2e-test-designer，我希望用一套与 AT 一致的 YAML DSL 写 ET case（浏览器动作 + 网络断言混用），以便降低学习成本、统一维护。

#### ET step 词汇表（与 AT step 共存于同一 case.yaml）

| step 类型 | 来源 | 语义 |
|---|---|---|
| `navigate: { url }` | ET 专属 | Playwright `page.goto(url)`，等 `domcontentloaded` |
| `click: { selector }` | ET 专属 | Playwright `page.click`，内置 auto-wait（可见/可点/稳定） |
| `type: { selector, text }` | ET 专属 | Playwright `page.fill`，内置 auto-wait |
| `press: { key }` | ET 专属 | Playwright `page.keyboard.press` |
| `hover: { selector }` | ET 专属 | Playwright `page.hover` |
| `drag: { src, dst }` | ET 专属 | HTML5 DnD（`page.dragAndDrop`） |
| `screenshot: { name }` | ET 专属 | 每 step 默认截图；显式 step 用于命名截图（vision_check/compare 用） |
| `requests: [...]` | AT 复用 | HTTP 请求 step（setup/teardown + 业务 API 触发） |
| `sse.sub: [...]` | AT 复用 | 订阅 SSE 通道（topic+group，全局唯一） |
| `wait` / `poll` | AT 复用 | 等待条件/轮询（timeout 上限 60s） |
| `check: [...]` | AT 复用 | 原子断言数组（`any`/`all` 谓词，fail 自解释） |
| `vision_check: { checks }` | ET 专属 | 按需，走 `vision_check.py` 单图判定 |
| `js_eval: { code }` | ET 兜底 | 仅当无法用上述 step 表达时（如复杂 DOM 派生计算），严格限制使用 |

#### step 混用规则

- `setup`/`teardown` 块**只用 AT 的 `requests`/`save`**（建/清数据，无浏览器）
- `steps` 块内可混用：浏览器动作 step + 网络 step + 断言 step
- 禁显式 `sleep`/`wait_ms`：所有等待由框架 auto-wait 或 `wait`/`poll` step 表达

#### dom_asserts 主判定不变（v0.0.100 模型）

- **`check` 数组主判定**（dom 断言：testid 存在/文本/count/状态），不 flaky、可调试
- **`vision_check` 按需**（仅视觉呈现无法 dom 断言或设计稿保真时）；纯功能 case 不写 vision
- **`compares[]` 顶层**（有设计稿时）：run_all 自动跑 `vision_check.py compare` 逐维度

---

### 2.2 基建方案 A：server 内 stub 扩展（退 A）[v0.0.127]

**描述**：req.md 决策 4 原优先 B（Playwright `page.route`/HAR 离线），前提「SSE 也能 stub」。researcher 调研结论（`infrastructure-b-sse-stub.md`）：**Playwright 原生不支持 SSE 流式响应**（`Route.fulfill` body 一次性 + HAR 规范不含流），自定义 route handler 工作量 ≈ 重写一套 record/replay，**触发 req §4「B 不行退 A」预案**。
**优先级**：P0
**用户故事**：作为框架维护者，我希望 ET replay 能 stub SSE 流（时序保真），以便 replay 轮不起真 LLM/真后端业务，但仍能验前端 SSE 订阅渲染。

#### 决策：退 A（server 内 stub 扩展）

扩展 AT 现有 `record-replay-registry.ts`（3 通道 llm/web_search/web_fetch）→ **5 通道**（加 http/sse 入站）：

| 通道 | 拦截点 | 用途 |
|---|---|---|
| `llm`（AT 复用）| server → LLM provider（出站 fetch） | LLM 调用录制/回放 |
| `web_search`（AT 复用）| server → search provider | 同上 |
| `web_fetch`（AT 复用）| server → URL fetcher | 同上 |
| **`http`（ET 新增）** | 浏览器 → server（入站 HTTP）| API 请求-响应录制/回放 |
| **`sse`（ET 新增）** | server → 浏览器（入站 SSE 响应）| SSE 事件序列录制/回放 |

#### 新增组件

1. **`app/server/src/testing/http-route-interceptor.ts`**（新文件）：在 `router.ts` 入口包装所有非 `/test/*` 路由
   - record 模式：透传真 handler，录请求+响应到 `http.jsonl`
   - replay 模式：命中录制 → 直接返回（不调真 handler）；未命中默认透传（白名单：静态资源 `/`、`/assets/*`、`/index.html` 不拦）
2. **`app/server/src/testing/sse-interceptor.ts`**（新文件）：包装 SSE 端点 `/sse/:topic/:group`
   - record 模式：包装 `stream.writeSSE`，录帧序列（type/data/delay_ms）到 `sse.jsonl`
   - replay 模式：读录制帧序列，按 `delay_ms` 增量 `writeSSE`（保真回放）
3. **`router.ts` 接线**：test 模式下在所有业务路由注册前装拦截器；`/test/*` 路由排除（避免 stub 协议自被拦）
4. **stub 协议不新增端点**：现有 `/test/stub` + `/test/stub/step` + `/test/stub/commit` 已支持 `declared: ['http','sse']`（StubPoint 扩展后值域自动接受）

#### SSE 时序还原

- **默认保真回放**：按 `events[].delay_ms` 还原时序（前端 EventSource onmessage 触发多次，UI 渲染行为与真跑一致）
- **`ET_REPLAY_FAST=1` 即时模式**：全部帧一次性 write（毫秒级，用于快速 smoke）
- **时序漂移容忍**：`delay = min(event.delay_ms, MAX_DELAY_MS=5000)`（避免单帧异常 delay 拖垮整个 case）

#### audit 语义对齐 AT

- `declared_not_hit`（声明了未命中）：record 轮提示不 fail（UI 分支未走到可容忍）
- `hit_not_declared`（命中了未声明 = 录制盲点）：record 轮 fail（强制补全 stub 声明）

### 2.3 录制格式（recordings/）[v0.0.127]

**描述**：ET recordings/ 在 AT 格式上加 `http.jsonl` + `sse.jsonl`，与 AT 共用 codec 库（`recording-codec.ts`）。
**优先级**：P0

#### 目录结构

```
recordings/
├── manifest.json    # 扩展：加 http_calls / sse_streams / et_fingerprint 字段
├── llm.jsonl        # AT 已有（server 出站 LLM）
├── http.jsonl       # 新增：浏览器→server API 请求-响应
└── sse.jsonl        # 新增：浏览器←server SSE 事件流
```

详见 `specs/research/v0.0.127/recording-format.md`（本 PRD 引用其格式定义，不重复）。

#### replay 匹配（req 决策 5：api + seq）

- **匹配键**：`api_normalized + seq` 双键
  - `api_normalized`：路径模板（`POST /session/*/messages`）—— 同一 API 多次调用归一组
  - `seq`：组内第几次调用 —— 区分同 API 不同响应
- **SSE 匹配**：订阅建立（`GET /sse/:topic/:group`）为一次「调用」；topic 是路径一部分，seq 按 topic+group 分组

### 2.4 case 全量迁移 [v0.0.127]

**描述**：`tests/e2e/` 全部 46 case 迁到新框架（req 决策 2「全盘重构，不做试点」）。
**优先级**：P0

#### 迁移汇总（来自 `case-inventory.md`）

| 动作 | 数量 | 说明 |
|---|---|---|
| **迁** | 39 | 1:1 迁到 case.yaml，step 拆分（`js:fetch+轮询` → `requests` + `wait`/`poll`；dom 断言保留） |
| **并** | 5 → ~3 | 语义重叠 case 合一（approval 3→2：allow+deny 双路径合一；enqueue 2→1：同队列渲染） |
| **弃** | 2 | 纯视觉对齐类（`studio_sidebar_visual_align_tc1`）转 `compares[]` 或 selftest |

#### 旧 checkpoint.json → 新 case.yaml step 映射

| 旧字段 | 新 step | 备注 |
|---|---|---|
| `action: goto:URL` | `navigate: { url }` | |
| `action: click:SEL` | `click: { selector }` | 内置 auto-wait 替代 `wait_ms` |
| `action: type:SEL TEXT` | `type: { selector, text }` | |
| `action: press:KEY` | `press: { key }` | |
| `action: hover:SEL` | `hover: { selector }` | |
| `action: drag:SRC DST` | `drag: { src, dst }` | |
| `action: js:CODE` | 拆为 `requests`/`click`/`type`/`wait`/`poll`；无法拆的保 `js_eval` | **关键工作量** |
| `wait_ms: N` | （框架内置 auto-wait） | 禁显式 sleep |
| `dom_asserts` | `check: [...]` | 对齐 AT check_engine 原子断言 |
| `vision_checks` | `vision_check: { checks }` step（按需） | dom 主判定不变 |
| `compares[]` | `compares: [...]`（顶层） | 视觉保真声明 |
| 顶层 `llm: replay/record/off/mock` | `MODE=record|replay|live` 外部传（对齐 AT） | MODE 归执行层 |

#### 13 模块分布（46 case）：chat 12 / studio 13 / config 5 / sse_channel 5 / approval 3 / 其他 8

详见 `specs/research/v0.0.127/case-inventory.md`（本 PRD 引用其逐 case 迁移映射，不重复）。

### 2.5 ET selftest [v0.0.127]

**描述**：ET 框架加 selftest（req 决策 12，对齐 AT selftest 150）。
**优先级**：P0
**用户故事**：作为框架维护者，我希望 ET 框架有自己的 selftest（只能 UT，不进 AT/ET 白名单），以便框架自身改动有兜底验证。

- 位置：`tests/e2e/lib/selftest/`
- 范围：case.yaml DSL 解析、check_engine 求值、record/replay 匹配、step 执行层（mock Playwright）
- 命令：`python3 tests/e2e/lib/selftest/run_selftest.py`（与 AT 同款，只能 UT，用户裁决）

### 2.6 AT/ET 共用纯逻辑 lib [v0.0.127]

**描述**：req 决策 11，AT/ET 共用纯逻辑 lib，step 执行层各自。
**优先级**：P1

| lib | 共用 | 各自 |
|---|---|---|
| `check_engine`（原子断言求值）| ✅ | |
| `check_explain`（fail 自解释）| ✅ | |
| `interp`（变量插值 `{sid}` 等）| ✅ | |
| `artifacts`（per-step 产物）| ✅ | |
| `recording-codec`（jsonl 编解码）| ✅ | |
| step 执行层 | | AT=HTTP curl；ET=Playwright |
| stub_client | ✅（同 `/test/stub` 协议） | |

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖要求）

> 因本版本是测试基建重构，「用户路径」= **e2e-test-designer 写 case 时的核心场景类型**，每类至少 1 个 ET case 覆盖。case 编号待 designer 阶段从 `case-inventory.md` 逐 case 对齐确认。

| 路径 # | 场景类型 | 代表 case（迁移后） | 覆盖要点 |
|---|---|---|---|
| **P1** | 纯 UI click + dom 断言（无网络） | `chat/ws_panel_collapse_tc1` | step 词汇表：navigate/click + check；auto-wait 替代 wait_ms |
| **P2** | 发消息 + LLM 回复（API + SSE） | `chat/chat_basic_tc1` | requests POST /messages + sse.sub agent_loop + check run_stop；stub `[llm,http,sse]` 三通道 |
| **P3** | 多步 SSE 事件序列渲染 | `sse_channel/studio_member_messages_render` | sse 时序保真（events[].delay_ms）+ dom 验渲染 |
| **P4** | session usage live 更新（SSE 推送） | `sse_channel/squad_chat_usage_live_tc1` | 旧 `js:fetch+轮询` 拆为 requests + wait/poll；stub replay 验 budget 渲染 |
| **P5** | abort 中断 run | `chat/abort_run_finish_tc1` | requests POST /messages → wait running → requests POST /abort → wait interrupted |
| **P6** | 工具调用 card 渲染（ask_question） | `chat/ask_question_card` | 复杂 SSE 事件 + card 渲染；stub 多通道 |
| **P7** | studio board 编辑链 | `studio/board_edit_tc1` | setup POST /squad → navigate → click board → edit → dom |
| **P8** | config 保存 + 设计稿保真 | `config/appearance_merged` | requests PUT + check + `compares[]` 视觉保真 |
| **P9** | approval allow + deny 双路径 | `approval/approval_card_allow_deny`（合并） | setup 建 2 session + 并行断言；stub `[llm,http,sse]` |
| **P10** | approval recover（deny 后重审） | `approval/approval_card_recover_tc1` | 独立路径（语义不同于 allow/deny） |
| **P11** | 多语言切换视觉对比 | `i18n/locale_switch_tc1` | `vision_check` step（8 个）；dom 主判定 + vision 按需 |
| **P12** | 跨 squad member 点击 | `studio/cross_squad_member_click_tc1` | setup 多 squad + navigate + click + dom |

**12 条关键路径 = ET case 迁移后的最低覆盖要求**（test-plan 阶段逐条核对有对应 case）。

---

## 4. 验收门槛

来源：`reqs/[working] v0.0.127/req.md` §验收门槛，本 PRD 完整对齐：

1. **ET 框架 selftest 全绿**（`tests/e2e/lib/selftest/run_selftest.py`）
2. **全盘迁移后 ET case 双关通过率 ≥ 70%**（口径：版本白名单 case 范围内 `pass_count / total_count`，含历史 pass；沿用 CLAUDE.md 阈值）
3. **基建方案 A 落地 + SSE stub 验证通过**：`http-route-interceptor.ts` + `sse-interceptor.ts` 跑通；SSE 保真回放（按 delay_ms）+ FAST 模式均可
4. **PRD 关键用户路径 P1-P12 全部有对应 case** 且无阻塞 fail（hard_fail=0）
5. **无阻塞性 issue**（定义见 CLAUDE.md「阻塞性 issue」节）
6. **文档同步**：`tests/README.md` 更新（ET 新框架）+ `.claude/skills/e2e-testing*` + `.claude/agents/e2e-test-designer` / `e2e-test-executor` 适配新 DSL

---

## 5. 设计决策（来自 req.md 12 决策，PRD 落地确认）

| # | 决策 | 本 PRD 落地 |
|---|---|---|
| 1 | DSL 统一 case.yaml + ET 专属 step 语法 | §2.1 step 词汇表 |
| 2 | 全盘重构（非试点） | §2.4 全 46 case 迁移 |
| 3 | ET stub = API/SSE 级（非 LLM 级） | §2.2 5 通道（llm 复用 + http/sse 新增） |
| 4 | 基建 B 优先 / SSE 不行退 A | **触发退 A**（§2.2，researcher 已证 B 不可行） |
| 5 | replay 匹配 = api + seq | §2.3 双键匹配 |
| 6 | 截图每 step 默认（auto-wait / networkidle / 断言后） | §2.1 `screenshot` step + 框架默认 |
| 7 | setup/teardown 只 record 轮跑 | §2.2 replay 不真处理数据 |
| 8 | 内置 Playwright auto-wait，禁显式 sleep | §2.1 step 词汇表规则 |
| 9 | dom 主判定 / vision 按需 / compares 保留 | §2.1 dom_asserts 主判定不变 |
| 10 | step 词汇表标准化 | §2.1 |
| 11 | AT/ET 共用纯逻辑 lib | §2.6 lib 共用表 |
| 12 | ET selftest | §2.5 |

---

## 6. 非功能需求

- **一致性**：ET case.yaml schema 与 AT 同源（除 ET 专属 step），designer 学一套语法
- **可测试性**：框架 selftest + case 双关验收
- **运行成本**：replay 轮毫秒级（不起真 LLM、不起真后端业务）；record 轮与 AT 同档（真 LLM 费用）
- **加性扩展**：http/sse 通道对 AT 透明（AT 不走浏览器，无入站要 stub），AT selftest 不受影响
- **debug 体验**：per-step 产物（`last_run/steps/NN/{responses,events,checks,screenshot}.json`）+ fail 自解释

---

## 7. 范围边界（IN / OUT）

### IN（v0.0.127 范围）

- `tests/e2e/` 框架重构（runner.py → 新 case.yaml 执行层）
- `app/server/src/testing/` 扩展（5 通道 + 入站拦截器）
- `tests/e2e/lib/selftest/` 新增
- 46 case 全量迁移（迁 39 / 并 5→3 / 弃 2）
- 文档同步（tests/README.md + .claude/skills + .claude/agents）

### OUT（非本版本范围）

- **后端业务代码改动**（产品功能不变，只动测试侧 + testing/ 扩展）
- **UI 组件变更**（testid 契约不变）
- **req backlog**：
  - heartbeat budget cache（PATCH budget 应 invalidate cache，当前 30s 异步刷新致 budget gate 不可即时测）—— 产品侧 backlog
  - POST /run test wrapper 缺 auto-naming hook（naming 只挂 POST /messages 生产路径）—— 产品侧 backlog
- **websocket stub**：项目有 ws 端点（`ws_panel_collapse_tc1` 测 ws），ws 不在 HTTP stub 范围；该 case 走 live 模式或不 stub ws 帧

---

## 8. E2E Use Cases

详见 `use-cases.md`（本目录）。
