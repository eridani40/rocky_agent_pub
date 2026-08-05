# v0.0.188 变更计划书 — ET 重构：删旧 tests/e2e，建 playwright agent 真实跑范式（Playground 基线）

> **method/文件级 review 合同**。架构期冻结：planner/coder 按本表切 task，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 需求权威：`reqs/[working] v0.0.188.et-playwright-agent/req.md`。
> 导航底图：`specs/ui/overall/00-app-guide.md`（executor 照它玩 app）。
> 范式定义：`.claude/skills/playwright-cli/SKILL.md` + `references/app-e2e-real-run.md`（执行方法）。
> PRD 跳过（纯测试基建重构，无用户可感知变化 — req §PRD 参与边界）。

## 列定义（8 列，行 = 一个函数/符号/文件/章节）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（e2e-framework / e2e-infra / e2e-agent / e2e-skill-ref / e2e-case / claude-md / tech-spec） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名/类名/章节名/case_id；对整文件级改动标「(整文件)」 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号 / memory） |
| 预计影响行 | +N / -M |

---

## §1. D（删除 / soft-delete）— 旧 ET 框架 + designer agent

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| e2e-framework | tests/e2e/ | (旧框架全目录) | 删除 | soft_delete 整目录到 `soft_deleted/v0.0.188/tests_e2e/`：含 `env_start.sh` / `env_shutdown.sh` / `lib/*`（除 `vision_check.py` 先迁出再 soft-delete 其余）/ 所有 `<module>/<case>/`（academy approval chat i18n mention settings skill studio agent） | MUST 用 `mv` 到 `soft_deleted/v0.0.188/`（memory `soft-delete-instead-of-rm`，rm 触发审批中断自动化）；MUST 先把 `tests/e2e/lib/vision_check.py` 迁到 `tests/e2e/vision_check.py` 再 soft-delete lib/；MUST NOT 删除 `tests/api/`（AT 完全不动）；MUST NOT 删 `tests/lib/`（port_alloc/timeout_guard AT/ET 共用，ET 删除后 lib/ 仍属 AT） | req §IN；memory `soft-delete-instead-of-rm` | 0/-~3500 |
| e2e-agent | .claude/agents/e2e-test-designer.md | (整个 agent 定义) | 删除 | 新范式无 designer 角色（agent 玩 app，case = 纯自然语言无预定义 checkpoint） | MUST 用 `mv` 到 `soft_deleted/v0.0.188/agents/`；MUST 同步从 `.claude/agents/` 移除（避免 orchestrator 误委派）；MUST NOT 删 `e2e-test-executor.md`（重写不删） | req §IN；新范式定案 | 0/-104 |
| e2e-infra | tests/lib/{new_case.sh,gen_case_md.sh} | (两脚本整体) | 删除 | 整个无用：`new_case.sh` 生成 checkpoint.json 骨架 / `gen_case_md.sh` 从 checkpoint.json 渲染 test_case.md，均绑旧 checkpoint 格式；ET 删后 + AT 用 case.yaml 均无消费者；活引用仅 `.qoder/agents/e2e-test-designer.md` 镜像随 designer 删失效，历史 version_logs 是记录非执行 | MUST 用 `mv` 到 `soft_deleted/v0.0.188/tests_lib/`；MUST NOT 删 `tests/lib/{port_alloc.sh,timeout_guard.sh,seed_common.sh}`（AT 共用，保留） | 用户裁决 2026-07-22「查清删除」；grep 结果（2026-07-22） | 0/-160 |
| e2e-infra | tests/run_all.sh | (顶层 wrapper 整体) | 删除 | 顶层 AT+ET 合并 wrapper 新范式无用——AT 走 tests/api/lib/run_all.sh、ET 走 env.sh+executor；其调用的 3 个 ET 脚本（env_start.sh/env_shutdown.sh/lib/run_all.sh）已 soft-delete 致断链、执行必崩 | MUST `mv` 到 `soft_deleted/v0.0.188/`（禁 rm）；AT/ET 范式分离后无合并 wrapper 需求 | Q1 裁决 2026-07-22（coder 偏离汇报后 orchestrator 确认） | 0/-~200 |

---

## §2. A（新增）— ET 基建 + executor 重写 + case + skill ref

### §2.1 新 ET 框架基建（`tests/e2e/env.sh` + `tests/e2e/run.sh` + `tests/e2e/vision_check.py`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| e2e-infra | tests/e2e/env.sh | `start` 子命令 | 新增 | 起 test 环境（headless 模式只起 server+web dev；electron 模式起 server+web+electron 外壳调 `scripts/run-test.sh` 路径模式）；分配独立 `DATA_DIR=~/.rocky_agent_et_<case_id>` | MUST 每次调用分配独立 DATA_DIR（req §每 case 独立环境）；MUST 支持端口冲突自动换号（端口注册表 `tests/lib/port_alloc.sh` 复用，**与 AT 共享 `_port_pick_free` 机制**）；MUST NOT 与 AT 抢同一端口段（AT 用 3700-3799/8787-8887，ET 用 3800-3899/8900-8999）；MUST NOT 与 packaged app 残留进程混淆（启动前 `lsof -ti:<port>` 清理孤儿）；MUST 用绝对路径展开 DATA_DIR，禁字面 `~` 拼接 | req §设计要点-双模式 + §每 case 独立环境；`scripts/run-test.sh` 蓝本；memory BUG-004 路径展开；`tests/e2e/env_start.sh`（旧）作端口/seed 参考 | +90/0 |
| e2e-infra | tests/e2e/env.sh | `stop` 子命令 | 新增 | 关 env.sh start 起的进程（pidfile 精确 kill）+ 删本 case DATA_DIR | MUST 用 pidfile 精确 kill（禁 `pkill -f` 宽匹配，memory `pkill-wide-match-kills-other-worktrees` 误杀其他 worktree/server）；MUST 清理本 case DATA_DIR（一次性，不跨 case 复用）；MUST NOT 删全局 `~/.rocky_agent_test/app_config/providers` 符链源（只删 case DATA_DIR 内符号链） | req §每 case 独立环境；memory `pkill-wide-match-kills-other-worktrees` | +35/0 |
| e2e-infra | tests/e2e/env.sh | `case-data-dir` 工具函数 | 新增 | `(case_id) => ~/.rocky_agent_et_<case_id>` 派生 + export | MUST case_id 作入参（禁硬编码）；MUST 展开为绝对路径（`$HOME` 展开，不字面 `~`）；MUST 校验 case_id 合法字符（`[a-z0-9-]+`） | memory BUG-004；req §每 case 独立环境 | +10/0 |
| e2e-infra | tests/e2e/run.sh | (main 入口) | 新增 | 顺序遍历 `tests/e2e/playground-*/case.md`（或命令行入参 case_id 列表），每 case：`env.sh start <case_id> --mode=<headless\|electron>` → 打印「请委派 executor 跑 case.md」→ `env.sh stop <case_id>` | MUST 顺序跑（req 决策：case 顺序跑，不并行）；MUST NOT 直接跑 playwright（executor agent 才是玩家，run.sh 只管 env 生命周期 + case 调度）；MUST exit 非 0 当任一 case 的 env 启停失败 | req §决策记录-case 顺序跑；req §范式-agent 玩 app | +60/0 |
| e2e-infra | tests/e2e/run.sh | `list` 子命令 | 新增 | 列出 `tests/e2e/playground-*/case.md` 所有 case_id | 用于 orchestrator 看 ET 范围 | — | +8/0 |
| e2e-infra | tests/e2e/vision_check.py | (脚本整体) | 新增 | 从 `tests/e2e/lib/vision_check.py` 迁移到 `tests/e2e/vision_check.py`（**mv 不复制**），保留 CLI 接口 `python vision_check.py <screenshot> '<checks_json>'`（单图）+ `python vision_check.py compare <impl> <design> '<checks_json>'`（比对）；删与 `_run_compares.py`/`compares[]` 框架的耦合引用 | MUST `mv`（禁 cp + rm 双源）；MUST 保留两 CLI 接口签名不变；MUST NOT 保留对 `tests/e2e/lib/_run_compares.py` 的 import（框架已删）；MUST 可独立调用（executor 按需 `Bash python tests/e2e/vision_check.py ...`） | req §IN-vision_check.py 作为工具；现有 `tests/e2e/lib/vision_check.py` 282 行 | mv / +0/-0 |

### §2.2 executor agent 重写（`.claude/agents/e2e-test-executor.md`）— 新范式 + 内嵌上手手册

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| e2e-agent | .claude/agents/e2e-test-executor.md | (agent 整体重写) | 修改 | 新范式 executor：① 唯一职责 = 用 playwright-cli skill 按 case.md 操作目标 + app-guide 路径真实玩 app，每步留证，自由心证 blocking/small；② tools = Read+Bash+playwright-cli skill（已含）；③ 内嵌「上手手册」4 段：环境坑（端口冲突/CDP 端口被占换号/packaged app 残留混淆/切换模型路径/每 case 独立 DATA_DIR 清理）、启停协议（env.sh start\|stop）、case 怎么跑（读 case.md → 照 app-guide → snapshot 导航 → 留证）、留证规范（每步 `states/<ver>/verify/e2e/<case_id>/steps/NN-<action>/{screenshot.png,dom.html,snapshot.yml,meta.json}`）；④ 判定标准（走不通=blocking / 有瑕疵=small）；⑤ 依赖 playwright-cli skill 命令清单 | MUST 单文件 ≤300 行；MUST 工具集守 Read+Bash（无 Write/Edit）；MUST NOT 用 Read 加载 screenshot.png（守 CLAUDE.md 禁截图，靠 snapshot.yml 文本导航）；MUST 留证每步（4 件套缺一不可）；MUST 顺序跑单 case（一次一个，不批量）；MUST NOT 自主延长/续跑（预算 hard-stop 交 orchestrator）；MUST NOT 下 bug 结论（如实汇报，orchestrator 裁决）；MUST 模型走 minimax 优先（req 决策） | req §范式 + §留证规范；`.claude/skills/playwright-cli/SKILL.md`；`references/app-e2e-real-run.md`；CLAUDE.md 原则 #7 禁截图；memory `agent-timebox-20min` | +270/-80 |

### §2.3 playwright-cli skill ref（`.claude/skills/playwright-cli/references/executor-workflow.md`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| e2e-skill-ref | .claude/skills/playwright-cli/references/executor-workflow.md | (参考文档整体) | 新增 | ET executor 工作流详参：① 环境坑清单（5 条，每条含现象+成因+绕行）；② 启停协议（env.sh start/stop 调用契约 + 端口段约定）；③ case 执行流程（snapshot 导航 → getByTestId 定位 → 每步留证 4 件套）；④ 留证规范（目录结构 + 文件名约定 + meta.json schema）；⑤ 判定标准（blocking / small / pass 三态定义 + 例子）；⑥ 依赖 playwright-cli 命令清单（open/snapshot/click/fill/find/eval/console/screenshot 等使用范式）；⑦ 不看截图原则的落地（snapshot.yml 是主信息源） | MUST 单文件 ≤300 行；MUST 引用 `SKILL.md` 命令清单不重复列举；MUST 与 `app-e2e-real-run.md` 互补（real-run 是用户层验收方法，本文是 executor agent 层工作流）；MUST 与 `.claude/agents/e2e-test-executor.md` 不重复（agent 定义是「我是谁/铁律」，本文是「我怎么干」详参） | `SKILL.md`；`app-e2e-real-run.md`；req §留证规范 | +280/0 |

### §2.4 Playground 基线 5 个 case（`tests/e2e/playground-*/case.md`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| e2e-case | tests/e2e/playground-send-message/case.md | (case 整体) | 新增 | Playground 基线 case 1：进 `nav-playground` → 建会话/选已有 → 发一条简单消息（如"你好"）→ 验收到纯文本回复（消息出现在对话区） | MUST 纯自然语言（use case 描述 + 操作目标），零断言零录制；MUST 引用 app-guide §3.1 路径；MUST NOT 含具体 testid 列表（testid 由 executor 读组件 spec 自选）；MUST 模型走 minimax；MUST case_id 与目录名一致 | app-guide §3.1；req §Playground 基线 | +25/0 |
| e2e-case | tests/e2e/playground-tool-call/case.md | (case 整体) | 新增 | case 2：发一条触发工具调用的消息（如询问天气/时间/计算，诱导 LLM 调 tool）→ 看工具执行卡/结果出现 → 看 LLM 后续回复 | 同上；MUST 不指定具体工具名（依赖当前 plugin 配置，由 executor 在环境中观察） | app-guide §3.1 | +30/0 |
| e2e-case | tests/e2e/playground-multi-turn/case.md | (case 整体) | 新增 | case 3：在同一会话多轮对话（≥3 轮），每轮提及相关上下文（如先说"我叫 Alice"，后问"我叫什么"）→ 验上下文保持 | 同 case 1 | app-guide §3.1 | +30/0 |
| e2e-case | tests/e2e/playground-session-switch/case.md | (case 整体) | 新增 | case 4：建 2 个会话（如"会话 A"/"会话 B"）→ 在 A 中说一件事 → 切到 B 说另一件事 → 切回 A → 验 A 的上下文不串到 B（对话隔离） | 同 case 1 | app-guide §3.1 | +30/0 |
| e2e-case | tests/e2e/playground-model-switch/case.md | (case 整体) | 新增 | case 5：nav-settings-app → 应用设置 → 模型 tab → 切 LLM provider/模型（如换为 deepseek 或另一个可用模型）→ 回 Playground 发消息 → 验新模型生效（回复风格/内容不同） | 同 case 1；MUST 走 nav-settings-app 路径（app-guide §3.3）；MUST 不指定具体模型名（环境相关，executor 看可用列表选） | app-guide §3.3 | +35/0 |

---

## §3. M（修改）— CLAUDE.md ET 相关章节 + testing KB 同步

### §3.1 CLAUDE.md ET 相关章节重写（用户授权本版改 CLAUDE.md — 越过 .claude/ 写入限制）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| claude-md | .claude/CLAUDE.md | 「持久化测试用例库」章节 ET 子节 | 修改 | ET 子节重写：删旧 checkpoint.json/case.yaml DSL + record/replay 框架描述；改为 agent 玩 app 范式（case.md 纯自然语言 + executor + env.sh + run.sh）；规模上限仍 3-5 条；目录结构示例对齐新方案 | MUST AT 子节不动（req §OUT AT 不动）；MUST 保留「双轨 AT+ET」「冒烟集」「一进一出」精神；MUST NOT 改 AT 相关条款；**改 CLAUDE.md 需用户授权（harness `.claude/` 写入限制 — 本版用户已明示授权）** | req §决策记录-AT 不动 | +25/-35 |
| claude-md | .claude/CLAUDE.md | 「测试计划+用例创建」章节 ET 部分 | 修改 | 删「e2e-test-designer 创建 checkpoint.json」；改为「designer 角色已删，case.md 由 orchestrator 或委派 coder 创建（与编码可并行）」；门槛条款（test-plan 确认、case 文件就绪）保留但对 ET 简化（case.md 纯文本无 record） | MUST AT 部分不动 | 同上 | +8/-12 |
| claude-md | .claude/CLAUDE.md | 「验证体系」章节 ET 子节 | 修改 | 删「e2e-test-designer 设计 checkpoint + e2e-test-executor 跑 run_all」；改为「executor 用 playwright-cli 真实玩 app + 自由心证 blocking/small」；删 dom 主判定 / vision 按需 / recording_drift 等旧机制（这些仅在 AT 仍适用）；vision_check.py 仍存在作为 executor 按需工具 | MUST AT 的 designer+executor 模型不动 | req §决策记录 | +20/-45 |
| claude-md | .claude/CLAUDE.md | 「LLM record/replay」章节 ET 子节 | 修改 | 删 ET 走 `/test/llm-mode` 旧端点描述（旧框架已删）；保留 AT 部分；新范式 ET 真调 LLM 不 stub（req §决策记录） | MUST AT 部分不动 | 同上 | +3/-15 |
| claude-md | .claude/CLAUDE.md | 「测试迭代与阈值门禁」章节 ET 部分 | 修改 | ET 阈值改为「blocking case 数 = 0」为门槛（新范式无 pass_count/fail_count 聚合）；已通过 case 不重跑原则保留；删 hard_fail / recording_drift / conflict 旧分类；版本白名单 = playground-*/case.md | MUST AT 阈值不动（API ≥ 90%） | req §决策记录 | +10/-20 |
| claude-md | .claude/CLAUDE.md | 「合并前门禁」条款 3（ET） | 修改 | 改为「ET 已执行 + blocking case = 0」；删 hard_fail=0 / PRD 关键用户路径 case 全 pass 旧口径（对 ET 不再适用）；AT 条款 2 不动；视觉保真度条款 7 保留但走新范式（compares[] 不存在，改 executor 按需调 `tests/e2e/vision_check.py compare`） | MUST AT 条款不动；MUST 条款 6 doc-modifier 仍 MANDATORY | 同上 | +8/-12 |
| claude-md | .claude/CLAUDE.md | 「文档产出链路」章节 ET 行 | 修改 | 删 `e2e-test-designer` + `e2e-test-executor 跑 run_all` 旧链路；改为「executor 用 playwright-cli 真实玩 app，按 case.md + app-guide」 | MUST AT 链路不动 | 同上 | +3/-5 |
| claude-md | .claude/CLAUDE.md | 「测试运行规范」表格 ET 行 | 修改 | 删 `CASES=<> bash tests/e2e/lib/run_all.sh`；改为 `bash tests/e2e/run.sh [case_id...]` + orchestrator 委派 executor 跑单 case | MUST AT 命令行不动 | 同上 | +2/-2 |
| claude-md | .claude/CLAUDE.md | 「E2E 判定模型」「e2e 注意」「视觉判定」ET 专属段 | 修改 | 删旧 dom 主判定 / vision 按需 / hard_fail / conflict 模型；改为「ET blocking = agent 走不下去 / small = 有瑕疵但不阻塞」；vision_check.py 仍存在作为 executor 工具（不再走 designer 预定义 compares） | MUST 视觉保真走 vision_check.py 原则保留；MUST AT 部分不动 | req §范式；CLAUDE.md 原则 #15 视觉契约 | +12/-30 |
| claude-md | .claude/CLAUDE.md | 「重要原则」条款 6（质量三关）+ 条款 9（禁跳过测试） | 修改 | 对齐新范式：ET 改为「executor 玩 app」一关（不再 designer 设计 + executor 跑 run_all 两段） | MUST AT 仍是 designer+executor 两段 | 同上 | +3/-3 |

### §3.2 testing KB 同步（`specs/tech/testing/`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tech-spec | specs/tech/testing/et-framework.md | (整篇重写) | 修改 | 重写：旧框架组件表（CaseLoader/StepExec/CheckEngineEtExt/SseAutowait/VisionAction/EtValidators/RunCase/RunAll/Selftest/RunCompares）全删；改为新范式组件（env.sh / run.sh / executor agent / case.md / vision_check 工具）+ 数据流图 + 不变量（每 case 独立 DATA_DIR / 顺序跑 / 不看截图 / 留证四件套） | MUST 单文件 ≤300 行；MUST frontmatter `updated: 2026-07-22` + `since: v0.0.188`（版本断代）；MUST 不动 record-replay.md（AT 部分）；MUST 与 index.md 一致 | req §设计要点；index.md | +180/-200 |
| tech-spec | specs/tech/testing/index.md | ET 部分 | 修改 | 子系统总起对齐：ET 改为 agent 玩 app 范式（一句话表 + 边界表 + ASCII 关系图更新）；AT 部分不动；frontmatter updated 同步 | — | 同上 | +12/-18 |
| tech-spec | specs/tech/testing/log.md | v0.0.188 条目 | 新增 | log 追加：v0.0.188 重构 ET 为 agent 真实玩 app 范式，删旧 checkpoint/case.yaml DSL 框架，改 case.md + executor + env.sh + run.sh，Playground 基线 5 case | MUST 单条 ≤12 行；MUST 含「代码-spec 一致核实」字段（doc-modifier 阶段 5 填） | — | +10/0 |

---

## §4. 明确不做（OUT）

- ❌ 无 `tests/e2e/README.md` / `RUNNER_MANUAL.md`（手册内嵌 executor agent 定义）
- ❌ 无 `.claude/agents/e2e-test-runner.md`（用现有 executor，不另起 runner）
- ❌ 不动 `tests/api/`（AT 完全不动，标技术债「AT 重构待议」在 task-board 记一笔）
- ❌ 不动 `tests/lib/{port_alloc.sh,timeout_guard.sh,seed_common.sh}`（AT/ET 共用，ET 删除后归 AT）
- ✅ 删 `tests/lib/{new_case.sh,gen_case_md.sh}`（用户裁决「查清删除」：整个无用——绑 checkpoint.json 旧格式，ET 删后 + AT 用 case.yaml 无消费者；活引用仅 `.qoder/agents/e2e-test-designer.md` 镜像随 designer 删失效）
- ❌ 不扩非 Playground 板块 case（后续版本）
- ❌ 不动 `scripts/run-test.sh`（只作 env.sh 的 electron 模式蓝本参考，不改其内容）
- ❌ 不改 `app/electron/` / `app/server/` / `app/web/`（零产品代码改动）

---

## §5. 影响面评估

**跨模块影响**：
- 本版只动 **测试基建 + 测试文档 + CLAUDE.md ET 章节**，零产品代码改动。
- ET 重构后，**所有引用旧 ET 框架的文档/章节** 需同步：`.claude/CLAUDE.md`（10+ 章节提及 ET）、`specs/tech/testing/`（3 KB）。
- **AT 完全隔离不动**，AT 双关 record/replay 范式延续。

**破坏性变更**：
- `tests/e2e/` 旧 case 全删（soft_delete）→ 历史录制 / ET 回归基线归零（用户已接受，新范式重建基线 Playground 5 case）。
- `.claude/agents/e2e-test-designer.md` 删除 → orchestrator 不可再委派 designer 跑 ET（CLAUDE.md 同步删引用）。
- `tests/e2e/lib/` 全删 → 任何外部引用 `tests/e2e/lib/*` 的脚本需更新（扫描结果：仅 `tests/e2e/env_start.sh`/`env_shutdown.sh`/`run_all.sh` 引用，全部随 lib/ 一起 soft_delete，无外部依赖）。

**依赖顺序**：
1. 先迁 `vision_check.py` 出来（避免 soft_delete 时一并删掉）
2. soft_delete `tests/e2e/` 旧框架（env_*.sh + lib/* + module/case/）
3. 建新基建：`env.sh` + `run.sh` + `vision_check.py`（迁后位置）
4. 重写 executor agent + 写 playwright-cli ref
5. 写 5 个 case.md
6. 改 CLAUDE.md + testing KB

**风险点**：
- **executor agent 内嵌手册体量**（约束 ≤300 行）— 把详参拆到 `playwright-cli/references/executor-workflow.md`，executor 定义只放骨架 + 链接。
- **CLAUDE.md 改动需越过 `.claude/` 写入限制** — 用户已明示授权（本版任务描述），但 coder 默认无权改 CLAUDE.md，需 orchestrator 阶段处理或委派 doc-modifier 用显式权限。
- **CLAUDE.md 章节 ET 引用扫描完整性** — coder 需 `grep -n e2e\|ET\|playground\|designer` 扫全 CLAUDE.md，遗漏的引用会让文档自相矛盾。

---

## §6. 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 CLAUDE.md ET 引用扫描有遗漏章节 → 汇报偏离 + 补章节行入 change_log.md（不必退 architect）
- 如运行时发现 `tests/e2e/env.sh` 端口段与 AT 实际占用冲突 → 汇报 + 调整端口段（architect 预留弹性）
