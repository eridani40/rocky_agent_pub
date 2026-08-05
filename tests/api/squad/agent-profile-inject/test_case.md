# agent-profile-inject — squad session system prompt 含「定义你的 agent」section + 两级 AGENTS.md 注入

> PRD `specs/prd/overall/13-agent-definition.md` §13.3 路径 1/2/3/4 的端到端集成验证点。
> 用例库纪律：本版本核心逻辑（prompt 组装 = 确定性文本渲染）以 UT 为主；本 AT 是 test-plan §三
> 唯一新增 AT case，覆盖「session 真创建后 prompt 真含 section」这一 UT 无法触达的集成点。

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /squad` | 11a §1.1 | 建队事务（record + leader member/session + squadChat + 目录骨架 `squads/{sid}/`）；响应 SquadDetail 含 `members[0].sessionId`（leader session id） |
| `POST /squad/:id/member` | 11a §2.1 | hire fresh mate → 建 mate session；响应直连 `{member, sessionId}` |
| `GET /session/:id/debug/system-prompt` | 06-skill §11（test-only） | 按需组装该 session 的完整 system prompt（走真实 mapper/reducer 链 + scope），`200 {sessionId, systemPrompt}`；PRD §13.5 验收标准 1 指定路径 |
| files 原语 | tests/README.md | 植团队 `squads/{sid}/AGENTS.md` + 个人 `squads/{sid}/.rocky/agents/apx-mate-{mid}.md`（base64 文本，含独特 marker） |
| `DELETE /squad/:id` | 11a §1.5 | teardown 级联删 leader/mate/squadChat session |

## 断言面（基于 spec 契约文本，不断言实现细节）

**section 结构（agent_profile §3 骨架 + §4 squad kind 路径表 + v0.0.238 PRD §14.2.1 d) 段）**
- leader + mate 的 `systemPrompt` 均含 `# 定义你的 agent` + `## a) System Prompt（AGENTS.md）` + `## b) Memories（长期记忆）` + `## c) Skills（技能）` + `## d) 自律治理`（标题逐字断言；v0.0.238 起新增 d) 自律治理段：4 条质量标准 + 按 biz 渲染的 scope 可用表 + scope 必填规则）
- b) 条含 `memory_manage`（工具说明）

**a) 条状态标注（agent_profile §3 + §6 决策 3/4；PRD §13.2.1 路径表 + UC-4）**
- leader：团队行 `已配置`（团队 AGENTS.md 已植）+ 个人行 `未配置·可选`（leader 无个人差异文件 = 兜底态，PRD 路径 4）+ 引导路径 `.rocky/agents/apx-leader-`
- mate：团队 + 个人均 `已配置` → prompt `!~= "未配置·可选"`（双文件存在 → 两行都渲染已配置）

**正文两级注入（PRD §13.2.2；prompt_content_files §7.7；UC-5/6）**
- mate prompt 含团队 marker `TEAM_AGENTS_MD_MARKER_V0_0_232` + 个人 marker `MATE_DELTA_FILE_MARKER_V0_0_232`
- leader prompt 含团队 marker、`!~= MATE_DELTA_FILE_MARKER_V0_0_232`（个人文件按需注入、不串人 = 隔离性）

**skills L0 来源层标注（change_plan D 行；PRD §13.2.4 / UC-11）**
- leader + mate prompt 的 skills L0 含 `[scope=builtin]`（4 层 resolver 之一；test env 必有 builtin 插件 skill 如 teamwork-leader/teamwork-mate）

## DSL 表达不了、由 UT 兜底的断言

以下断言 check DSL 无法表达（无子串位置/邻近谓词、`stream.order` 仅适用 SSE 帧），由
change_plan H 节 UT 全覆盖：

- **「团队在前、个人在后」叠加顺序**（prompt_content_files §7.7 拼接顺序）→ UT `prompt-mappers-reducers.test.ts` context_files 两级读取 case。
- **来源标注精确文案与「标注↔正文」邻近关系**：标注样式「来自…：{绝对路径}」（PRD §13.2.4 /
  change_plan C 行）的子串 `来自` 与 c) 条模板文本「你的 skills 来自 N 个位置」冲突，AT 无法
  区分性断言；标注存在性 + 两段各自标注 + 邻近关系 = UT 覆盖。AT 侧以 `.rocky/agents/apx-mate-`
  断言个人文件路径在 prompt 中浮现（a) 条路径行与正文来源标注均含此前缀），作为路径机制存在的
  可观测代理。
- **正文截断 / budget floor** → UT（change_plan E + finding ② floor 共存 case）。

## 不调 LLM

纯 HTTP 事务（建 squad + hire + debug system-prompt 直查）+ files 原语，全确定性，无 429/flaky。
prompt 组装是确定性文本渲染（test-plan §一 界定），debug 端点按需 `buildSystemPrompt()` 读盘，
无需真 run session；`modelDefault=MiniMax-M3` 仅过建队写入校验（test pool 已启用模型）。

## 前置依赖

v0.0.232 **T1**（squad session workspaceDir = `squads/{sid}/`）+ **T2**（agent_profile mapper 挂链 +
context_files 两级读取 + skills `[scope=]` 标注）落地。未落地时本 case 的 section / 标注断言 fail =
正确暴露缺失（post-fix 契约，同 dissolve-preserve 范式）。冒烟自检阶段（编码并行）期望：case 载入
无拒载、`POST /squad` / `POST /member` / debug GET 返预期 status；section 与 marker 断言 fail 是
「功能未实现」的正常信号，非 wiring 缺陷。

## spec 文案保真度提示（首跑后核对）

section 标题与 a/b/c 子标题逐字取自 agent_profile §3 骨架（含全角（））；若实现用半角括号或文案
微调，按 陷阱 13（spec 偏差按代码实际写 + 记 doc-sync 待办）调整 case 断言并向 orchestrator 汇报。
