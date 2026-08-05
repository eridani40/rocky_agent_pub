# member-panel

> 层级: section
> 文件: app/web/src/components/studio-page/section-member-panel.tsx

## 职责
角色面板：编辑某 member 配置，**占用主区**（非弹层/抽屉），左上「返回」回**首页 seats**。section 纵向：姓名介绍（name + intro + **workStyle 多行**）/ **skills**（inherit/custom switch + 简化筛选器）。**当前任务占位区删除**。**心跳配置 section 移除**——心跳升级 squad 级统一调度。改动后**右下角悬浮保存**（PATCH member）；保存后悬浮消失（基线重置）。
>  **② skills 板块重构 + 删 model + ③ 删记忆 section**：
> - **② skills section**：`MultiCheck`(SKILL_OPTIONS 死占位) + `ModelPicker` **全删**；改为一个 `member-skills-mode-switch`（off=inherit 继承全局 / on=custom 自定义）+ off 收起、on 展开 `component-member-skill-filter`（简化筛选器）。旧 `member-skills-editor` / `member-model-input` testid 移除。overlay 语义见 `specs/tech/squad/[P1]session_config_studio.md §3.2` + PRD `2-member-skills-mechanism.md`。
>  tools 编辑已移除（static-by-type 查 tool-policy.ts）。
> `member.systemPrompt` 字段已从前端 Member 类型、后端 schema、UI 全部删除（phantom 字段清理）——`member-systemprompt-input` testid 已移除，PATCH body 也不含 systemPrompt。

## Props
- member: Member;                 // member.skillConfig: {mode, overrides}（非旧 s...
- onBack: () => void
- onSave: (memberId: string, patch: PatchMemberBody) => Promise<void>; // 仅传改动字段
- squadTimezone?: string;         // page-studio 实传（use-member-panel-handlers 转...
- squadEnableHeartBeat?: boolean; // 同上遗留可选 prop

## 状态 / 交互
- 本地编辑态（name / intro / **workStyle** / skillConfig）+ 基线（初始 member）。`dirty` = 任一字段 ≠ 基线。
- 保存仅传改动字段；`tools` accept-and-ignore）；成功后基线重置 → 悬浮保存消失。
- **workStyle 输入（MANDATORY）**：profile Card 内、intro input **下方**多行 `<textarea data-testid="member-workstyle-input">`。intro 保持单行 `input` 不改。**可空 = 保存时不 trim 判空**，允许提交空串（后端清空回写，无 400——区别 intro）。语义 = 成员工作方式，仅注入该成员自己个人 session prompt（不进 Team Roster）；仅用户可编辑（agent `team` 工具不暴露）。
- **skills switch 语义（②，MANDATORY）**：
  - on（custom）：展开 `component-member-skill-filter`；用户逐项 toggle 改本地 overrides；save 时 `skillConfig={mode:'custom', overrides: <补齐全量筛选器当前态>}`（R5：把筛选器每行当前 on/off 快照进 overrides）。
  - **布局稳定（MANDATORY）**：switch off↔on 切换、筛选器出现/收起**不得导致其他 section 位移**——用高度过渡/预留，禁 `display:none`+常规流跳动。

## 视觉基线
- **布局**：主区 flex column + `animate-[fadeIn]`；内容  居中，section 间 ，底部留白 。
- **skills section 标题**：图标 `wrench` + 文字「skills」（原「技能与模型」）。

## 复用关系
- 被组合: `page-studio`（主区态之一）
- **移除组合**: `component-placeholder-banner`（当前任务占位区删）
