---
type: design
title: ET 框架架构（agent 玩 app 范式 — env.sh + executor + case.md + 留证 + 自由心证）
priority: P1
status: active
updated: 2026-07-29
since: v0.0.188
related: [index.md, at-framework.md]
---

# ET 框架架构（tests/e2e，v0.0.188 agent 玩 app 范式）

> 引入版本：v0.0.188。把 ET 从声明式断言脚本（`case.yaml` DSL + record/replay + run_all）重构为 **agent 用 playwright-cli 真实玩 app** 范式：case = 纯自然语言，executor 读 case.md + app-guide 玩 app，每步留证，自由心证 blocking/small/pass。
> **设计冻结**：`specs/tech/version_logs/v0.0.188/change_plan.md`。
> **需求权威**：`reqs/[working] v0.0.188.et-playwright-agent/req.md`。
> **AT**：v0.0.188 时不动（标技术债另版治本）；v0.0.190 已同向重构为真实调 API（`at-framework.md`，原名 record-replay.md）。
> **旧框架**：`case.yaml` DSL 框架归 `soft_deleted/v0.0.188/tests_e2e/`（v0.0.127 重构产物）；更早的 `checkpoint.json` 框架归 `tests_old_v1/` / `soft_deleted/tests_trim/`。

## 1. 定位

ET = **agent 模拟真用户玩 app**（不是声明式断言脚本）：
- executor agent 用 playwright-cli skill 按 `case.md`（自然语言操作目标）+ `app-guide.md`（导航底图）真实操作 app。
- 每步留证（screenshot + dom.html + snapshot.yml + meta.json 四件套），供 orchestrator / 人诊断。
- 判定走 executor **自由心证**：pass / small / blocking 三态（不再有 dom_asserts / hard_fail / conflict / recording_drift 等机械分类）。
- **不录制不回放**——每 case 真调 LLM（minimax 优先），不 stub。

**AT 测后端 API 契约（声明式断言 + record/replay）**，ET 测「真用户能不能在 app 里走通一个场景」（agent 模拟真用户）。两轨范式不同，互不重叠。

## 2. 组件模型（代码/文档路径精确）

| 组件 | 路径 | 职责 |
|---|---|---|
| env.sh | `tests/e2e/env.sh` | 单 case 环境一键启停：start `<case_id>` 起 server + web dev（+可选 electron 外壳）+ 派生独立 DATA_DIR + 分配隔离端口；stop `<case_id>` pidfile 精确 kill + 删 DATA_DIR |
| run.sh | `tests/e2e/run.sh` | 编排入口：顺序遍历 `tests/e2e/playground-*/case.md`（或命令行 case_id 列表），每 case env.sh start → 提示委派 executor → env.sh stop；不跑 playwright |
| vision_check.py | `tests/e2e/vision_check.py` | 视觉判定脚本（CLI 工具，不再绑框架）：单图功能判定 `python vision_check.py <shot> '<checks_json>'` + 视觉保真 compare `python vision_check.py compare <impl> <design> '<checks_json>'` |
| snapshot-with-keys.sh | `tests/e2e/snapshot-with-keys.sh` | **snapshot 增强（v0.0.218 起）**：snapshot 后逐交互节点 eval `dataset.actionKey`，在 `[ref=eN]` 后注入 `[action-key=X]`，让 executor 主信息源（snapshot.yml）可见 action-key（playwright a11y snapshot 本身丢 data-*） |
| case.md | `tests/e2e/<case_id>/case.md` | 纯自然语言 case：Use Case + 前置条件 + 编号操作目标 + 验收口径；零断言零录制零选择器预定义 |
| executor agent | `.claude/agents/e2e-test-executor.md` | 用 playwright-cli skill 真实玩 app 的 agent：唯一职责 = 按 case.md + app-guide 操作 → 每步留证 → 自由心证 |
| executor 详参 | `.claude/skills/playwright-cli/references/executor-workflow.md` | executor 工作流详参：环境坑 + 启停协议 + case 执行流程 + 留证 schema + 判定三态 + 命令组合范式 |
| app-guide | `specs/ui/overall/00-app-guide.md` | executor 的导航底图：照此手册能从 nav-rail 一路点到任意功能 |

**接线**：orchestrator 委派 → executor 开工 → `run.sh start <cid> --mode=headless` → executor `playwright-cli open <web_url>`（或 attach `--cdp=<cdp_url>`）→ 按 case.md 留证跑 → verdict.json → executor `playwright-cli close` → orchestrator 调 `env.sh stop <cid>`。

## 3. case.md schema（纯自然语言）

```markdown
# <case_id> — <一句话场景>

> 纯自然语言 case。executor 照 case + app-guide 操作。

## Use Case
作为 <角色>，我想 <做什么>，验证 <期望行为>。

## 前置条件
- env.sh 已起好环境。
- LLM provider 可用（minimax 优先）。

## 操作目标（编号步骤）
1. **进入 <板块>**：照 app-guide §X.X，从 nav-rail 点 <板块名> 入口（按 snapshot 文案/位置定位）。
2. **<动作>**：<具体操作>。
3. **<动作>**：<具体操作>。
4. **验收 <目标>**：<观察什么>。

## 验收口径（executor 自由心证）
- **pass**：<完全走通条件>
- **small**：<走通但有瑕疵条件>
- **blocking**：<走不下去条件>

## 依赖
- specs/ui/overall/00-app-guide.md §X.X
- specs/ui/components/ 对应板块组件 spec
```

**约束**：
- **零断言**：不写选择器列表 / 不写 expected value（executor 按 snapshot 文案/位置自选定位方式）。
- **零录制**：不写 record/replay / 不写 compares[] / 不写 recordings（真调 LLM，不 stub）。
- **引用 app-guide 章节**：必须引用 `specs/ui/overall/00-app-guide.md` 对应章节作导航依据。
- **case_id 与目录名一致**：`tests/e2e/<case_id>/case.md`。
- **编号步骤**：每步是「用户视角的动作 + 意图」，不是「点击选择器 X」。

## 4. 环境管理（env.sh + 每 case 独立 DATA_DIR）

### 4.1 双模式

| 模式 | 起 | 场景 |
|---|---|---|
| `headless`（默认） | server + web dev（Vite） | CI / 快 / 默认。playwright 连 web dev |
| `electron` | server + web dev + electron 外壳 | 真窗口 / 环境对齐 / 展示给用户 |

两模式加载同 web，Playground 基本操作表现一致。

### 4.2 每 case 独立 DATA_DIR

- `~/.rocky_agent_et_<case_id>`（绝对路径，禁字面 `~` 拼接 — memory BUG-004）。
- 每 case 新建，stop 时一次性删除，不跨 case 复用。
- env.sh start 时 symlink 全局测试池三件到 `DATA_DIR/app_config/`（源 `$HOME/.rocky_agent_test/app_config/`，与 AT 共用同一物理配置）：`providers/`（LLM provider 凭证 + 配置，真调 LLM 必需）+ `web_search/`（web_search provider 配置）+ `default_models/`（应用级默认模型映射，缺它模型 picker 显示「未配置」）。三件都是只读复用源池，不在 case DATA_DIR 里独立维护。

### 4.3 端口段（与 AT 隔离）

**v0.0.215 起：版本号编码基址 + 独立千段**（详见 `at-framework.md §4.3`）——ET API 43xxx / WEB 45xxx / CDP 46xxx，基址 = `43000 + suffix`（suffix = worktree 目录名小版本号后三位，如 v0.0.215 → 43215）。不同版本 worktree 天然不同段，彻底切断跨会话互杀（旧固定段 3800-3899 等 + env_shutdown 裸杀端口会误杀兄弟 worktree 的 server）。

| 段 | 用途 | 基址公式 |
|---|---|---|
| ET API 43xxx | server 监听 | `43000 + suffix` |
| ET WEB 45xxx | web dev 监听 | `45000 + suffix` |
| ET CDP 46xxx | electron 外壳（仅 electron 模式分配） | `46000 + suffix` |

ET 与 AT（AT API 42xxx / WEB 44xxx）独立千段隔离——suffix 可达 999，43xxx 内偏移会撞 AT WEB 边缘，故每 kind 每信号独占一个千段。容错窗口 `+0 ~ +19`（基址被偶发占用时回退）。全局注册表 `~/.rocky_agent_test/_registry/<port>.json` 跨会话确权（pid + worktree + version），`env.sh stop` 清残留只杀自己注册 pid（cmdline marker 验证），禁 `lsof -ti:$port | xargs kill` 裸杀。

### 4.4 进程管理

- **pidfile 精确 kill**（禁 `pkill -f` 宽匹配 — memory `pkill-wide-match-kills-other-worktrees`）。
- start 前 `_kill_port_orphans` 清端口孤儿：v0.0.215 起只杀 cmdline 含本 worktree marker 的 pid（防 pid reuse 误杀），非裸 `lsof|xargs kill`。
- stop 倒序 kill（electron → web → server，避免父进程早死孤儿化子进程）。

## 5. executor 工作流（详参 `playwright-cli/references/executor-workflow.md`）

```
1. orchestrator 委派 + env.sh start <cid> --mode=<m>
2. executor 读 tests/e2e/<cid>/case.md
3. executor 读 specs/ui/overall/00-app-guide.md 相关章节
4. executor: playwright-cli open <web_url> 或 attach --cdp=<cdp_url>
5. executor: playwright-cli snapshot 看初始页结构
6. 一步一留证循环：
   按 case.md 操作目标 + app-guide 路径执行
   每步落 4 件套到 states/<ver>/verify/e2e/<cid>/steps/NN-<action>/
7. executor 心证 blocking/small/pass → verdict.json
8. executor: playwright-cli close 关 browser
9. orchestrator: env.sh stop <cid>
```

**executor 铁律**：
- 只用 Read + Bash（无 Write/Edit）。
- **不 Read screenshot.png**（守 CLAUDE.md 禁截图，靠 snapshot.yml 文本导航）。
- 不改 case.md / env.sh / run.sh。
- 不下 bug 结论（如实汇报事实，裁决交 orchestrator）。
- 不自主延长预算 / 续跑。
- 元素定位以 **snapshot（role + 可见文案 + ref）** 为主：`getByText` / `getByRole` 优先，ref 编号辅助；文案来源 = 组件 spec「状态 / 交互」中的可见文案描述。**增强 snapshot（§5.1）可见 action-key 时，优先按 action-key 锁定元素**（机器稳定标识，不随文案/i18n 变）。不扒 `app/` 代码。
- LLM 真调用（minimax 优先，不 stub 不 mock）。

## 5.1 snapshot 增强（action-key 注入，v0.0.218 起）

### 为什么需要

playwright snapshot = a11y tree，**故意丢所有 `data-*`**（含 `data-action-key`）。v0.0.211 铺的 action-key 住 DOM 但对 executor 不可见——`data-action-key` 是给机器读的稳定标识（不随文案/i18n/实现标签变，详见 `specs/ui/components/_conventions.md §12`），但 a11y 口子（aria-label→name / title→tooltip）承载机器标识会污染无障碍，所以不能搭便车。**解法 = eval 增强**：snapshot 后逐交互节点 eval 读 `dataset.actionKey` 注入 snapshot 文本，不改二进制不污染 a11y。

### 机制（snapshot-with-keys.sh）

`tests/e2e/snapshot-with-keys.sh` 把 `playwright-cli snapshot` 的输出增强后吐出：

1. `playwright-cli snapshot --filename=<tmp>` 存盘基线 a11y snapshot
2. 逐行扫描，**只对交互节点**（button/link/menuitem/tab/checkbox/radio/textbox/combobox/slider/treeitem 等 ARIA role）提 `[ref=e<N>]` —— 纯文本 generic 节点跳过（性能优化）
3. 对每个交互 ref 调 `playwright-cli --raw eval "el => el.dataset.actionKey || ''" eN`
4. **三层校验** eval 返回（防 `--raw eval` 错误时 exit=0 + stdout 污染）：单行 + JSON 字符串字面量 `^"..."$` + 符合 action-key 命名规范 `[a-z0-9][a-z0-9.-]*`
5. 校验通过：在该行的 `[ref=eN]` 后注入 `[action-key=X]`；校验失败 / 无值：原行透传（降级正常 a11y 节点）

**结果**：增强 snapshot 里交互节点同时带 `[ref=eN] role "name" [action-key=X]`，executor 一眼定位。

### session 复用（per-cwd + 透传）

脚本的 `playwright-cli eval` 要连 executor 已 open 的 session。spike 实测确认复用机制：

- **playwright-cli session = per-cwd**（metadata 存 `<cwd>/.playwright-cli/`），脚本作为 executor 子进程继承 cwd → 自然复用同 session
- **executor 若用命名 session**（`-s=et-<cid>`）→ 脚本须透传 `--session=<name>`（脚本构造 `playwright-cli -s=<name> ...` 调用）
- 不在同一 cwd / 不传 session → snapshot 报 "browser not open"

### executor 约定

详 `playwright-cli/references/executor-workflow.md §3 snapshot 双层 + 定位优先级`：

- **snapshot 双层**：a11y 基线（`playwright-cli snapshot`，全节点 role/name/state）+ action-key 增强（`bash snapshot-with-keys.sh`，交互节点额外带 `[action-key=X]`）
- **留证 snapshot.yml 推荐用增强版**（带 action-key，给人/executor 复核都更清晰）：`bash tests/e2e/snapshot-with-keys.sh --session=et-<cid> --out=steps/NN-post/snapshot.yml`
- **定位优先级**：`[action-key=X]`（首选，机器稳定）> ref 编号 > 文案 name（降级，未铺 action-key 的节点兜底）

## 6. 留证规范（每步 4 件套缺一不可）

目录结构：
```
states/<ver>/verify/e2e/<case_id>/
├── verdict.json              # 最终判定（case 级汇总）
└── steps/
    ├── 01-open-app/
    │   ├── screenshot.png        # playwright-cli screenshot --filename=...
    │   ├── dom.html              # playwright-cli eval "document.documentElement.outerHTML" >
    │   ├── snapshot.yml          # playwright-cli --raw snapshot >
    │   └── meta.json             # cat <<EOF 写
    ├── 02-click-nav-playground/
    │   └── ... (4 files)
    └── 03-send-message/
        └── ... (4 files)
```

`<action>` = 人类可读动作名（kebab-case，如 `01-open-app` / `02-click-nav-playground` / `03-send-message` / `04-verify-reply`）。

`meta.json` schema：
```json
{
  "step": 1,
  "action": "open-app",
  "intent": "进入 app，看 nav-rail 可见 + 默认进 Playground",
  "playwright_cmd": "playwright-cli goto http://127.0.0.1:8900",
  "console_errors": [],
  "console_warnings": [],
  "dom_anchors": ["nav-rail", "chat-page"],
  "my_observation": "页面加载成功，看到 nav-rail 7 个图标，默认进 Playground",
  "verdict": "pass"
}
```

`verdict.json`（case 级汇总，跑完写）：
```json
{
  "case_id": "playground-send-message",
  "verdict": "pass",
  "steps_total": 4,
  "steps_pass": 4,
  "steps_small": 0,
  "steps_blocking": 0,
  "summary": "成功发消息并收到 LLM 回复，主路径贯通",
  "key_artifacts": ["02-click-nav-playground/screenshot.png", "04-verify-reply/snapshot.yml"]
}
```

## 7. 判定模型（executor 自由心证三态）

| 态 | 定义 | 例子 |
|----|------|------|
| **pass** | 完全走通，无瑕疵 | 发消息→收到合理回复；切会话→上下文隔离生效 |
| **small** | 走通了但有瑕疵，不阻塞合并 | 文案微差、视觉小问题、偶发 console warning 但不影响主路径 |
| **blocking** | 走不下去，阻塞性问题，退 coder | 关键元素找不到、click 报错、关键 API 500、LLM 一直空回、链路断 |

### 判定原则
- 走得通 + 主功能 OK = pass（不追求像素完美）。
- 走得通 + 有瑕疵但不影响主路径 = small（留证供人判断）。
- 走不下去 / 关键功能失效 = blocking（必附现象 + executor 归因事实描述，不猜 bug）。
- **LLM 实际返回质量由人判**：executor 只判「有没有回复 + 回复链路通不通」，不判「这个回复好不好」。

**不再有的旧分类**：dom_asserts / hard_fail / conflict / recording_drift（旧框架概念，新范式无 designer 预定义断言 + 无 record/replay，故无此分类）。

## 8. 不看截图原则（落地）

**核心**：snapshot.yml 是 executor 的主信息源，screenshot.png 只是留证给人看。

- **禁**：`Read screenshot.png`（CLAUDE.md 铁律）。
- **禁**：调 `mcp__*__understand_image` 类 MCP。
- **正解**：
  - 看页面状态用 `playwright-cli snapshot`（文本 accessibility tree，可 grep）。
  - 留证用 `playwright-cli screenshot --filename=...`（直接落盘，不 Read）。
  - 真需要视觉判定（视觉保真 compare / 几何/配色验证）按需 `python3 tests/e2e/vision_check.py ...`，脚本吐 JSON，executor 读 JSON。

**理由**：snapshot 是结构化的（ref / role / text），可机器对比；截图靠人眼 / vision model，慢且 flaky。功能验证一律走 snapshot，视觉保真才上 vision_check。

## 9. vision_check.py 作工具（不绑框架）

旧框架的 `compares[]`（designer 在 checkpoint.json 预定义视觉保真声明 + run_all 自动跑）已废除——新范式 executor 按需调 `vision_check.py`：

```bash
# 单图功能复核（按需）
python3 tests/e2e/vision_check.py path/screenshot.png '[{"id":1,"check":"页面有 nav-rail"}]'

# 视觉保真比对（有设计稿时，executor 按需调）
python3 tests/e2e/vision_check.py compare path/impl.png path/design.png '[{"id":1,"dimension":"layout","check":"三栏布局"}]'
```

两 CLI 签名从旧框架迁移保留（v0.0.127 实现），删去与 `_run_compares.py` / `compares[]` 的框架耦合。凭证依赖：`VISION_AUTH_TOKEN` / `VISION_BASE_URL` / `VISION_MODEL`（详见 `tests/README.md` 部署章）。

## 10. Playground 基线 5 case（v0.0.188）

| case_id | 场景 |
|---|---|
| `playground-send-message` | 发一条简单消息，收到 LLM 回复（主链路冒烟） |
| `playground-tool-call` | 诱导 LLM 调工具，看工具卡 + 结果 + LLM 后续回复（agent loop 冒烟） |
| `playground-multi-turn` | 多轮对话，验证上下文保持 |
| `playground-session-switch` | 多会话切换，验证隔离 |
| `playground-model-switch` | 应用设置切模型，回 Playground 验证生效 |

**send-message 是 case.md 样例模板**（后续版本 PRD「关键用户路径」照此写 case）。

## 11. 边界（零件唯一归属）

| 零件 | 归属 |
|---|---|
| ET env.sh + run.sh + case.md schema + 留证规范 + 判定三态 | 本 KB ✅ |
| snapshot 增强（snapshot-with-keys.sh 机制 + session 复用 + action-key 注入约定） | 本 KB §5.1 ✅（脚本实现在 `tests/e2e/snapshot-with-keys.sh`） |
| executor agent 定义 + 工作流详参 | `.claude/agents/e2e-test-executor.md` + `.claude/skills/playwright-cli/references/executor-workflow.md` |
| action-key 命名规范 + 铺设范围 | `specs/ui/components/_conventions.md §12`（UI 契约层） |
| app-guide（导航底图） | `specs/ui/overall/00-app-guide.md` |
| AT 真实调 API 框架（case.yaml DSL + 429 skip + dev config copy） | `at-framework.md`（AT 范式，不在本 KB） |
| tests/ README（双轨入口） | `tests/README.md` |
| 逐 case 用法 | `tests/e2e/<case_id>/case.md` + `test_case.md` |

## 12. 已知债 / 后续改进

- **AT 仍是旧范式**（`tests/api` case.yaml DSL + record/replay + run_all）：本版只重构 ET，AT 标技术债「AT 重构待议」另版治本。
- **非 Playground 板块 ET case 暂未建**：v0.0.188 只建 Playground 5 个基线 case，后续版本扩 Studio / Skill 等板块。
- **executor agent 一次跑单 case**：不批量跑，不并行。orchestrator 顺序委派。
- **每 case 真调 LLM**：消耗 token，但避免 record/replay 维护成本（req 决策）。
- **无 CASES= 白名单机制**（旧框架有）：新范式 orchestrator 直接顺序委派 executor 跑 case.md，不需要白名单旋钮。
- **无 ROUND 轮次 / skip-passed 机制**：新范式 executor 跑一遍即汇报 verdict，orchestrator 记录历史，不需要 round 隔离。
