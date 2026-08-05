# v0.0.212 change_plan — academy chat 布局修复 + usage 补齐

> 依据：reqs/[working] v0.0.212.academy_chat_fix/req.md（排查结论已固化）。
> 范式权威参照：chat-page/page-chat.tsx L153、studio-page/component-studio-chat-router.tsx L116-L118（BaseChatPage 须作 `h-full min-h-0` 高度受限容器的子项）、studio-page/section-squad-chat.tsx L107+L156-L164（usage 接法）。

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| academy-page | app/web/src/components/academy-page/section-classroom-detail.tsx | SectionClassroomDetail（JSX 行容器 + 班主任 400px 列） | 修改 | 行容器补 `min-h-0`；班主任列包装层补 `min-h-0 overflow-hidden`（或去掉多余 flex-col 包装，coder 定位选最干净方案） | 不改 chat-page 内核；列宽 400px 保持 | page-chat.tsx L153 | L168/L170 附近 |
| academy-page | app/web/src/components/academy-page/section-classroom-detail.tsx | SectionClassroomDetail（usage 接线） | 修改 | 补 `useUsage(headTeacherSessionId)` + 向 ComponentAcademyChatCol 传 `topbarRight={<ComponentChatTopbarRight …>}`（含 compact/clear） | 接法对齐 studio；import 自 chat-page | section-squad-chat.tsx L107, L156-L164 | 组件头 + L171 附近 |
| academy-page | app/web/src/components/academy-page/section-training-observe.tsx | SectionTrainingObserve（JSX 行容器 + 教练列） | 修改 | 行容器补 `min-h-0`；教练列包装层补 `min-h-0 overflow-hidden`（或去包装） | 同上 | 同上 | L210/L212 附近 |
| academy-page | app/web/src/components/academy-page/section-training-observe.tsx | SectionTrainingObserve（usage 接线） | 修改 | 补 `useUsage(coachSessionId)` + `topbarRight` ComponentChatTopbarRight | 同上 | 同上 | 组件头 + L213 附近 |
| academy-page | app/web/src/components/academy-page/section-version-chat.tsx | SectionVersionChat（chat 列包装） | 修改 | 列包装层补 `min-h-0 overflow-hidden`（已有 usage，核对不动） | usage 已接，勿重复 | — | L145 附近 |
| academy-page | app/web/src/components/academy-page/component-session-readonly.tsx | ComponentSessionReadonly（根容器） | 修改 | 根容器补 `min-h-0`，保证只读 transcript 可滚动 | 保持只读：不加输入区/usage | — | L17 附近 |
| ui-spec | specs/ui/components/academy-page/_overview.md | 复用声明章节 | 修改 | 补「宿主高度链约束」：BaseChatPage 宿主须保证 min-h-0 高度链；补交互/只读边界（班主任/教练/学生可交互+usage，subagent 只读） | 与代码一致 | chat-page/_overview.md §4.5 | — |
| ui-spec | specs/ui/components/academy-page/（涉及的 section spec） | section-training-observe.md 等 | 修改 | 同步 usage 区域（ComponentChatTopbarRight）描述 | — | — | — |

## 增补（用户确认纳入本版本）：BUG-001 训练不自动推进 + BUG-002 采纳 500（均为代码偏离 spec）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| academy/engine | app/server/src/academy/training-engine/messages.ts | buildTaskStartedMessage(task, coachSessionId) | 新增 | kickoff 消息（含 task.id、directive、base、mode/optimizeStyle 分支指引：训练式→调 train-student run_turn；学习式→按 skill 产出后 propose） | sender=system kind='academy-training-engine'，metadata.needReply=true（同现有 builder 模式 L93-105） | training_engine.md §7 场景 1 | L22-90 附近新增 |
| academy/handler | app/server/src/handlers/academy-training-task-create.ts | handleCreateTask | 修改 | putTask 后 `deps.agentManager.deliverTo(coachSessionId, buildTaskStartedMessage(...))`，fire-and-forget catch | 必须走 deliverTo（enqueue+activate），禁止 sessionStore.appendMessages（不激活） | 18-academy.md §6 表首行 | L148 前 |
| academy/engine | app/server/src/academy/training-engine.ts | runTurnInternal dataset-less 分支 | 修改 | 简单/无 dataset 模式：候选直接晋升 temporaryBaselineVersionId=candidateVersionId、turn.status='adopted'，不走 acceptGate | PRD §12.4 简单模式无评估；不影响 dataset 分支 gate 语义 | prd 12-academy UC-D | L152-161 |
| academy/engine | app/server/src/academy/training-engine/lifecycle.ts | acceptTask | 修改 | 前置守卫：临时基线===baseVersionId（或版本 type='formal'）→ throw「无提升，无可采纳的过程版本」 | 不放宽 adoptToFormal process-only INV（data_model §6） | — | L48-53 |
| academy/handler | app/server/src/handlers/academy-training-task-shared.ts | mapEngineError | 修改 | 新增「无可采纳」pattern → 409（invalid_task_state 或新码 nothing_to_adopt，如用新码同步 18-academy.md §7） | 不再落 500 兜底 | — | L34 |
| plugins/context | app/plugins/builtins/rocky_context/prompt/academy-iteration-state.ts | map | 修改 | coach prompt 防御性补「任务 ID：${taskId}」 | taskId 从 readTrainingTaskId 可得 | — | L32 后 |
| web/academy | app/web/src/components/academy-page/section-training-result.tsx | verdict/foot 区 | 修改 | 无提升（temporaryBaselineVersionId===baseVersionId）时禁用/隐藏「✓ 采纳」、verdict 改「无提升」态；i18n 补 zh/en key | — | academy.json L195 | L143/L176-207 |
| tech-spec | specs/tech/academy/（training_engine.md / 18-academy.md 等） | — | 修改 | 如引入 nothing_to_adopt 错误码补 §7；其余按实现核对同步 | 与代码一致 | — | — |
