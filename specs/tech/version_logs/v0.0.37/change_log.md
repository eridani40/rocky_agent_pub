# v0.0.37 Tech Change Log — squad 工具 inputSchema 补全 + leader 三层 wiring 对齐 + OKF 双轨心智模型入 prompt

> version: 1.0 · 2026-07-01
> 范围红线：squad 工具契约 / leader 工具可见性 / leader·mate system prompt 三块**对齐性修复**——无新端点、无新 UI、无概念新增。AgentLoop 本体零改。
> 权威输入：`reqs/v0.0.37.okf_mgmt/{req,bug}.md` + `states/v0.0.37.okf_mgmt/design/part-a-tool-schema.md` + `part-b-okf-prompt.md` + `states/v0.0.35/design/goal-req-task-management-scheme.md`。
> 父版本地基：v0.0.33.3（OKF 双轨 + 工作项三层 + system prompt 不落库，已合并）+ v0.0.36（model 选择器）。

---

## 1. 改动总览（3 块）

| # | 子系统 | 改动核心 | 权威 spec |
|---|---|---|---|
| **A** | 工具层 | task/goal/requirement/team 四工具 `inputSchema.properties` 从只声明 `action`（team 多 `query`）**补全为含所有 action 专属参数**（flat 顶层 property）；新增 `squad-tool-schema.test.ts` 静态扫源码断言「handler 实读字段 ⊆ schema properties」防回归 | `[P1]squad_tools.md §0` |
| **B** | 工具可见性 | leader 三层门控对齐到单一权威 `LEADER_DEFAULT_TOOL_NAMES`（5 工作项 + 6 文件 + skill，共 12）——v0.0.33.3 只改 config 层，漏改 schema 层（`filterToolDefinitionsBySessionType`）+ exec 层（`deriveAllowedTools`），两层都把 leader 剥成 5 工作项 → file 工具假可见 → OKF 双轨失效 | `[P1]agent_leader.md §3` |
| **C** | prompt 层 | leader.md / mate.md 加「## 团队工作结构（goal·requirement·task）」段 + 替换「## 双份数据一致性」→「## 怎么管理：OKF=工作目录，store=汇报PPT」（两层模型 + 同步方向按信息来源不按角色）；teamwork-{leader,mate} SKILL.md §2 注脚从「方向相反因为角色不同」改情境式 | `[P1]squad_okf.md §1` + `[P1]prompt_sections.md §8` |

**核心不变量**（MUST NOT violate）：
1. 工具行为零改——Part A 只补 `inputSchema.properties` 声明，handler 逻辑 / 强约束 / 错误码不动（保留 `task.create: title is required` 等运行时校验）。
2. AgentLoop 本体零改——三层 wiring 修在 `scope-allowed-tools.ts` 纯函数 + 常量，不动 loop。
3. squad/mate/subagent 工具集未动——仅 leader 三层对齐。

---

## 2. 根因

### 2.A 工具 inputSchema 漏声明（Part A）

`protocol-encode.ts:encodeTools()` 把工具 `inputSchema` **原样透传**给 LLM provider（无 strict / 无 `additionalProperties:false`）→ `properties` 里声明的字段 = LLM 会发的参数契约。四个工作项工具的 `definition.inputSchema.properties` 只声明了 `action`（team 多一个 `query`），但 handler 实读 `input.title` / `input.source` / `input.goalId` 等 action 专属字段全没声明 → LLM 只发 `action` → 每个 write action 必崩（`task.create: title is required` 是首发症状）。

**description 文案本身准确**（与 req9 spec 一致，列举了各 action 的参数），纯 schema 漏声明。范本：`agent-tool.ts`（action + 每个 action 专属参数做顶层 property）。

### 2.B leader 三层 wiring 残缺（v0.0.33.3 遗留）

v0.0.33.3 OKF 双轨制要求 leader 能写 OKF md（charter / reports / board），故 config 层 `LEADER_DEFAULT_TOOL_NAMES` 含 6 文件工具。但仅 config 层（`squad-service` 建 leader member.tools 默认 + `session-config` 保底）改了；**schema 层**（`filterToolDefinitionsBySessionType` 旧 `LEADER_SCHEMA_TOOL_NAMES` 仅 5 工作项）+ **exec 层**（`deriveAllowedTools` leader 分支旧字面量 5 个）都没改 → LLM 看不到 write/bash（schema 层先剥），即便 config 层有、调通也被执行层 not-allowed（exec 层再剥）→ leader 写不了 OKF md（Part B OKF 双轨失效）。

配置层"看起来有"是假象——三层有一层剥就不可用。

### 2.C 心智模型未进 prompt + 注脚框架错误（Part B）

v0.0.33.3 落了 OKF 双轨**结构**（md 主面 + store 投影）+ 工具只管 store 的强约束，但 leader.md / mate.md 的 system prompt 没把「OKF 是什么、store 是什么、先写哪个」的**心智模型**写清楚——旧段「双份数据一致性」只讲自检机制，没给 agent 可操作的同步方向。

teamwork-{leader,mate} SKILL.md §2 末尾注脚「方向相反因为角色不同」把情境规则（user 交代→store 先 vs 自己推进→OKF 先）硬编码成角色规则（leader 总 store 先 / mate 总 OKF 先），错误——leader 自己拆 OKR 时应 OKF 先，mate 接 user 交代时应 store 先。

---

## 3. 设计决策

- **Part A 补全原则**：handler 读啥 flat 字段（`input.title`），schema 就声明啥 flat 顶层 property。所有 action 专属参数均 optional（仅 `action` required）——具体必填由 handler 按 action 运行时校验（保留既有错误码）。不改 handler、不改工具行为。
- **Part A 防回归 UT**：`__tests__/squad-tool-schema.test.ts` 对 4 工具静态扫 handler 源码抽 `input.XXX` 字段名，断言每个 ∈ `definition.inputSchema.properties`（白名单：`action` + 嵌套子对象内部字段如 `krs[].title` 不要求顶层）。字段增删时此测试卡住 → 强制同步 schema。UT 直接调 `run()`（带全参）永远绿，只有「schema 声明 vs handler 实读」一致性测试能抓到 LLM 发不出字段的病。
- **Part B 三层单一权威**：抽 `LEADER_DEFAULT_TOOL_NAMES` 常量（= `LEADER_SCHEMA_TOOL_NAMES` ∪ `FILE_TOOL_NAMES` ∪ `SKILL_TOOL_NAME`），config / schema / exec 三处引用同一常量，杜绝再次漂移。mate 不引入类似常量（mate 走 `FULL` + config.tools 白名单收窄，无三层漂移风险）。
- **Part B 心智模型 D-shared**：leader.md / mate.md 各自内嵌共享段（不改 squad_role mapper 产品码），角色差异留各自红线段 + teamwork 技能。同步方向改情境式（按信息来源：user 交代→store 先 / 自己产生→OKF 先），不再按角色硬编码。
- **leader「不直接编码」红线不动**：给 file 工具是为写 OKF md/charter/reports，与编码无关；红线段是 prompt 软约束，与工具可用性正交。`squad-role-mapper.test.ts` 关键词（leader: `不直接编码`/`charter`；mate: `不创建 task`/`不改 charter`/`reports`）保不动。

---

## 4. 影响的 specs

- `[P1]squad_tools.md`：§0 加核心设计原则「`inputSchema.properties` = LLM 参数契约」（encoder 原样透传，handler 实读字段必须声明，否则 LLM 不发）。
- `[P1]agent_leader.md`：§3 tools 表拆分 file/web 行（file ✅ 写 OKF / web ❌）+ 加 skill ✅ + 加三层门控一致段（v0.0.37 修 v0.0.33.3 残留）。
- `[P1]squad_okf.md`：§1 加双轨心智模型（OKF=工作目录/过程层，store=汇报PPT/交流层）+ 同步方向按信息来源不按角色。
- `[P1]prompt_sections.md`：§8 重写——加两层模型 + 同步方向情境式 + 注 leader.md/mate.md 新增「团队工作结构」段 + teamwork 技能注脚改情境式。

---

## 5. 测试

- **全量 UT**：`bun run test` zero fail（含新增 `squad-tool-schema.test.ts` 4 工具 schema-handler 一致性断言）+ `bun run typecheck` EXIT 0。
- **code-review**：PASSED（文件全 ≤300 行；`scope-allowed-tools.ts` 抽常量无冗余；三层引用单一权威）。
- **真 LLM AT**：**parked**——真 LLM（MiniMax-M3）抽风，leader/mate 接 user 需求时回纯文本「你好」`no_tool_call`，无法验证「先工具后 OKF」行为序列。**Part A schema 修复由 UT 兜底**（schema-handler 一致性断言 + 既有 handler 全参 UT），行为 AT 留后续版本（换 LLM provider 或 MiniMax 修复后补跑）。决议见 `states/v0.0.37.okf_mgmt/task-board.md`。

---

## 6. 交付文件（A/M）

**Part A — 工具 schema 补全**：
- 修改：`app/server/src/agent/tools/{task,goal,requirement,team}-tool.ts` 的 `definition.inputSchema.properties`（补 action 专属参数为 flat 顶层 property）。
- 新增：`app/server/src/agent/tools/__tests__/squad-tool-schema.test.ts`（schema-handler 一致性防回归）。

**Part B — leader 三层 wiring**：
- 修改：`app/server/src/agent/scope-allowed-tools.ts`（抽 `LEADER_DEFAULT_TOOL_NAMES` / `FILE_TOOL_NAMES` / `SKILL_TOOL_NAME` / `LEADER_SCHEMA_TOOL_NAMES` 常量；schema 层 + exec 层 leader 分支引用同一常量）。

**Part C — prompt + skill**：
- 修改：`app/server/src/prompts/content/squad/{leader,mate}.md`（加「团队工作结构」段 + 替换「双份数据一致性」→「怎么管理：OKF=工作目录，store=汇报PPT」）。
- 修改：`app/plugins/builtins/skills/teamwork-{leader,mate}/SKILL.md`（§2 末尾注脚改情境式）。
