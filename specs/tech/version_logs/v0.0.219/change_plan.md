# v0.0.219 变更计划书 — Academy 视图优化（academy_opt）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 根因调查全部回填于 `states/v0.0.219/context.md`（7 个修复区的 method/符号级锚点）；本表行 = 一个函数/符号，8 列齐全。

## 列定义（8 列）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（academy-schema / academy-store / academy-handler / academy-version-dir / academy-api-type / academy-ui / academy-i18n） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置 / context.md finding / 项目原则 |
| 预计影响行 | +N / -M |

## 修复区 1b — 版本树过程版归属（按 label major 匹配父 formal）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-ui | app/web/src/components/academy-page/version-tree-nodes.ts | buildVersionNodes (process parent) | 修改 | process 节点 `parentVersionId` 改按 label major 段匹配 formal：`process.versionLabel.split('.')[0] === formal.versionLabel.split('.')[0]` 找父 formal.id；不再沿用 `p.parentFormalVersionId`（multi-turn round2+ base 是 process 不是 formal） | MUST 按 major 段匹配（spec §6 label 3 段规则保证同 major）；formal major 唯一（0/1/2…）保无歧义；MUST NOT 依赖 parentFormalVersionId 判父；orphanProc 分支保留兜底 | context.md 问题1b finding；[P0]data_model.md §6 label 3 段 | +6/-2 |

## 修复区 1c — 采纳自溯源（schema + adopt 写 + 前端徽章）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-schema | app/server/src/academy/schema_defs/student-version.ts | StudentVersionSchema.fields.adoptedFromProcessVersionId | 新增 | 加 `adoptedFromProcessVersionId: { type:'ulid', required:false }` — formal 由 adopt 产生时落源 process version id | MUST required=false（0.0 + 旧 record 无此字段）；无 enum 闭合问题 | [P0]data_model.md §3（架构期新增字段，本表落 spec） | +3 |
| academy-store | app/server/src/academy/academy-store-ops.ts | adoptToFormal | 修改 | 新 formal record putVersion 时加 `adoptedFromProcessVersionId: processVersionId` | MUST 在 putVersion `{ id: newFormalVersionId, ... }` 调用内落字段；MUST NOT 改 adopt 其他语义（nextMajor label 分配 / copyVersionDir / process.status='adopted' 不变） | context.md 问题1c finding；[P0]data_model.md §6 | +1 |
| academy-api-type | app/web/src/lib/academy-api.ts | StudentVersionEntity | 修改 | type 加 `adoptedFromProcessVersionId?: string`（meta 直返实体字段） | MUST 可选（旧 record 兼容）；与 schema 对齐 | specs/api/overall/18-academy.md §1.8（架构期 meta 加字段） | +1 |
| academy-ui | app/web/src/components/academy-page/version-tree-nodes.ts | buildVersionNodes (formal subtitle) | 修改 | formal 副标题：若 `f.adoptedFromProcessVersionId` 存在 → 在 versions 中查该 id 的 process versionLabel → 显 `t('versionTree.adoptedFromLabel',{label})`；0.0 / 无字段 / 查不到 label 维持原 `emptyFormal` / `adoptedFrom {n:seq}` 降级 | MUST 仅 formal 展示；0.0 不显；查不到 label 不崩（降级 undefined）；BuildArgs 已有 versions 可查 | context.md 问题1c；PRD §2.1；specs/ui/overall/12-academy.md §4 | +8/-3 |

## 修复区 2/C — coach 持续可达：实时性轮询 + 渲染门 + coach 入口

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-handler | app/server/src/handlers/academy-student.ts | handleGetStudent | 修改 | Response 加 `tasks: TrainingTaskEntity[]`（该学生的任务，由 listTasksByClassroom(cid) filter studentId 得） — 使前端 useStudentDetail 自足检测 active task 驱动轮询 | MUST 只返该 student 的 tasks；MUST NOT 改 student/versions 字段；复用 listTasksByClassroom | context.md 问题2 finding；specs/api/overall/18-academy.md §1.7（架构期 response 加 tasks） | +5/-1 |
| academy-api-type | app/web/src/lib/academy-api.ts | StudentDetail | 修改 | type 加 `tasks: TrainingTaskEntity[]` | MUST 与后端 §1.7 对齐 | specs/api/overall/18-academy.md §1.7 | +1 |
| academy-ui | app/web/src/components/academy-page/use-academy-data.ts | useStudentDetail | 修改 | onInit 拉到 detail 后若 `detail.tasks` 含活跃态（running/pending/awaiting_confirm）→ startTimer({intervalMs:5000})；onTick 软刷新重读（mutateCtx 写回新 detail，不 setCtx(null)） | MUST 复用 useLifecycle.startTimer（不变量⑤自动回收 timer）+ onTick mutateCtx 软刷新（参考 use-training-task.ts:35-73）；MUST NOT 自拼 setInterval；MUST NOT 调 r.reload（runInit 会重建 onInit 堆叠 timer）；deps=[classroomId,studentId] 变时自动停；无活跃态不轮询 | context.md 问题2 finding；PRD §2.3；use-training-task.ts polling 模式 | +22/-2 |
| academy-ui | app/web/src/components/academy-page/use-academy-data.ts | useClassroomDetail | 修改 | 同 useStudentDetail：detail.tasks 含活跃态时 startTimer(5000ms) + onTick 软刷新 | MUST 同上约束；与 useStudentDetail 独立各自轮询（不同 cid/sid 不互相影响） | 同上 | +16/-1 |
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | activeTask 渲染门 | 修改 | 把 `activeTask`（活跃态单条 find）改为 `recentTasks = [...tasks].sort(by createdAt desc).slice(0,3)` 渲染**多张** ComponentTrainingStatusBar 卡（每张保留 onOpenObserve 入口）；含终态 done/rejected/aborted（aborted 亦保留，复盘价值） | MUST N=3（coder 可微调，须文档化）；MUST 含 aborted；MUST NOT 渲染全量历史（限最近 N）；version tree / 四元组卡渲染不受影响；selectedVersion 派生不变 | context.md 问题2 finding；PRD §2.3（代决含 aborted） | +14/-5 |
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | tasks 数据源 | 修改 | `tasks` 从 `classroomDetail?.tasks filter studentId` 改为 `detail.tasks`（§1.7 已返该学生任务）；classroomDetail prop 保留兼容（其它派生如 datasets/graders 仍用） | MUST 用 detail.tasks（自足）；MUST NOT 同时读两源（避免重复） | context.md 问题2；specs/api/overall/18-academy.md §1.7 | +1/-2 |

## 修复区 3 — Memory 读侧 + 卡 + modal

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-version-dir | app/server/src/academy/academy-version-dir.ts | ResolvedVersionContent (type) | 修改 | 接口加 `memoryEntries: MemoryEntrySummary[]` 字段 | MUST 与 §1.8 MemoryEntrySummary 对齐（name/size/preview） | specs/api/overall/18-academy.md §1.8（架构期定义） | +3 |
| academy-version-dir | app/server/src/academy/academy-version-dir.ts | MemoryEntrySummary (type) | 新增 | `{ name: string; size: number; preview: string }` — memory md 文件摘要 | MUST 字段闭合（前端 type 对齐） | specs/api/overall/18-academy.md §1.8 | +3 |
| academy-version-dir | app/server/src/academy/academy-version-dir.ts | resolveVersionContent | 修改 | 扩读 `<wsDir>/.rocky/memory/` 下 md 文件（readdir + 每文件前 200 字符 preview + size），填 `memoryEntries`；缺目录返 `[]` | MUST 复用 memoryRoot(wsDir)；缺目录/文件 graceful 返 [];MUST NOT 写 memory（本版只读）；二进制/非 md 跳过；IO 须 try/catch | context.md 问题3 finding；[P0]data_model.md §3.1（c memory 路径） | +22/-1 |
| academy-handler | app/server/src/handlers/academy-student.ts | handleGetVersionContent | 修改 | content.memory 从硬编 `[]` 改返 `content.memoryEntries`（resolveVersionContent 已读） | MUST 返 MemoryEntrySummary[]；MUST NOT 改 skills/agentsMd/versionJson 字段 | context.md 问题3；specs/api/overall/18-academy.md §1.8 | +1/-1 |
| academy-api-type | app/web/src/lib/academy-api.ts | VersionContent.content.memory + MemoryEntrySummary | 修改 | memory 从 `never[]` 改 `MemoryEntrySummary[]`；export MemoryEntrySummary type | MUST 与后端 ResolvedVersionContent.memoryEntries 对齐 | specs/api/overall/18-academy.md §1.8 | +6 |
| academy-ui | app/web/src/components/academy-page/component-tuple-cards.tsx | Memory TupleCard | 修改 | 从死占位（`tuple.memoryPending`）改为显条目数 + 「查看」按钮（onAction 触发新 onOpenMemoryModal 回调）；空 memory 显「暂无」 | MUST 新增 onOpenMemoryModal 回调 prop；MUST NOT 走 md 编辑器通道；不崩 | context.md 问题3；PRD §2.4；specs/ui/overall/12-academy.md §4 | +8/-3 |
| academy-ui | app/web/src/components/academy-page/component-tuple-cards.tsx | Props (onOpenMemoryModal) | 修改 | Props 加 `onOpenMemoryModal: () => void` | MUST 由 section 组 target 上抛（modal state 归 page-academy） | 同上 | +1 |
| academy-ui | app/web/src/components/academy-page/component-version-memory-modal.tsx | ComponentVersionMemoryModal | 新增 | 版本 memory modal：读 VersionContent.content.memory 列表展示（复用 chat-page component-memory-entry-card 渲染样式，**只读**）；Portal + 关闭回调 | MUST 只读（版本资产，非 session 级）；MUST NOT 复用 useMemoryCrud（那是 session 级读写）；样式对齐 chat-page/component-memory-modal.tsx；单文件 ≤300 行 | context.md 问题3；specs/ui/components/chat-page/component-memory-modal.md（样式源） | +85 |

## 修复区 4 — 移除 Tools 卡（五元组 → 四元组）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-ui | app/web/src/components/academy-page/component-tuple-cards.tsx | Tools TupleCard | 删除 | 删 Tools TupleCard 块（L77-97） | MUST 仅删 UI 入口；MUST NOT 删 versionJson.tools 类型字段 / MdEditorTarget.saveKind='tools' union（dead 但无害，本版不清，doc-modifier 标注）；装配链 resolveToolSet 不受影响；grid 自适应不引入位移 | context.md 问题4；PRD §2.2 | +0/-21 |

## 修复区 5 — baseline picker 可切任一 formal

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-ui | app/web/src/components/academy-page/component-training-create-modal.tsx | Props + baseline PickerRow + state | 修改 | Props 改：删 `baseVersion: {id,label}` 单值，加 `formalVersions: {id,label}[]` + `defaultBaseVersionId: string`；state `baseVersionId` 默认 defaultBaseVersionId；baseline PickerRow 加 onClick cycle（复用 dataset/grader cycle 模式 L96-105）切 formalVersions | MUST cycle 全 formal 列表（不只 currentFormal）；MUST 保留 dataset/grader cycle 不变；hint 文案用选中 baseVersion label | context.md 问题5；specs/ui/overall/12-academy.md §9 | +20/-4 |
| academy-ui | app/web/src/components/academy-page/component-training-create-modal.tsx | toCreateTaskBody | 修改 | 调用方传选中 baseVersionId（不再硬 currentFormal）；函数签名不变（`(baseVersionId, config)`） | MUST 用 modal 内选中 baseVersionId | 同上 | +1/-1 |
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | onStartTraining Props + button onClick | 修改 | Props `onStartTraining: (baseVersionIdHint?: string) => void`（可选 hint，默认不传）；训练按钮 onClick 改 `() => onStartTraining()`（不预锁 currentFormal.id） | MUST NOT 在 section 预锁 baseVersionId；默认由 page-academy 从 formalVersions 取 currentFormal | context.md 问题5 | +2/-2 |
| academy-ui | app/web/src/components/academy-page/page-academy.tsx | handleStartTraining | 修改 | 签名 `(defaultBaseId?: string)`；组 modal 时传 `formalVersions = studentDetail.versions.filter(v=>v.type==='formal').map(({id,versionLabel})=>({id,label:versionLabel}))` + `defaultBaseVersionId = defaultBaseId ?? currentFormalId` | MUST 传全 formal 列表；MUST NOT 只传单条 currentFormal | context.md 问题5 | +9/-3 |

## 修复区 6b — 任务名版本挂钩（后端反规范化 + 前端文案 + i18n）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-handler | app/server/src/handlers/academy-classroom.ts | handleGetClassroom | 修改 | tasks 数组每条反规范化 `baseVersionLabel`：Promise.all 读 `getVersion(cid, task.baseVersionId).versionLabel` 挂字段；读不到留 undefined | MUST 用 academyStore.getVersion 读 label（教室详情无 versions 上下文）；MUST NOT 改 task 其他字段；并发读 Promise.all | context.md 问题6b；specs/api/overall/18-academy.md §1.3/§2.2（架构期 task DTO 加 baseVersionLabel） | +12/-1 |
| academy-handler | app/server/src/handlers/academy-training-task.ts | handleGetTask | 修改 | Response 加 `baseVersionLabel`：getVersion(cid, task.baseVersionId).versionLabel | MUST 同 classroom handler 一致；MUST NOT 改 task/turns 结构 | context.md 问题6b；specs/api/overall/18-academy.md §2.2 | +4/-1 |
| academy-handler | app/server/src/handlers/academy-training-task-create.ts | handleCreateTask response | 修改 | Response 201 的 task 字段加 `baseVersionLabel`（建后立即可显版本前缀名） | MUST 与 GET 一致；MUST NOT 改 response 其他字段（candidateVersionId/workspaceDir 等不变） | specs/api/overall/18-academy.md §2.1 | +3 |
| academy-api-type | app/web/src/lib/academy-api.ts | TrainingTaskEntity | 修改 | 加 `baseVersionLabel?: string` | MUST 可选（旧任务兼容）；与后端 DTO 对齐 | specs/api/overall/18-academy.md §2.2 | +1 |
| academy-ui | app/web/src/components/academy-page/version-tree-nodes.ts | buildVersionNodes (process node name) | 修改 | process 节点 name 从 `t('versionTree.taskN',{n:taskSeq})` 改用 `t('versionTree.procName',{label:p.versionLabel})`（3 段 versionLabel 已含 major.taskSeq.round） | MUST 用 versionLabel（context.md 问题6 代决）；MUST NOT 用裸 taskSeq | context.md 问题6b；PRD §2.5 | +1/-1 |
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | 任务卡 name | 修改 | ComponentTrainingStatusBar name 从 `t('tasks.nameWithMode',{seq,...})` 改 `t('tasks.nameWithVersion',{label: task.baseVersionLabel ? \`v${task.baseVersionLabel.split('.')[0]}.${task.taskSeq}\` : \`v?.${task.taskSeq}\`, mode})` | MUST 用 baseVersionLabel 拼「v{major}.{seq}」；baseVersionLabel 缺失降级 v?.{seq}；mode 维持 | context.md 问题6b；PRD §2.5 | +3/-1 |
| academy-ui | app/web/src/components/academy-page/section-training-observe.tsx | 任务标题文案 | 修改 | 改版本前缀「v{major}.{seq} 训练任务」（用 task.baseVersionLabel） | MUST 与 student-detail 一致 | 同上 | +2/-1 |
| academy-ui | app/web/src/components/academy-page/section-training-result.tsx | 任务标题文案 | 修改 | 同上 | MUST 一致 | 同上 | +2/-1 |
| academy-ui | app/web/src/components/academy-page/component-classroom-tab-panels.tsx | TaskRow name | 修改 | 同上（教室训练 tab，用 task.baseVersionLabel） | MUST 一致 | 同上 | +2/-1 |
| academy-ui | app/web/src/components/academy-page/component-training-create-modal.tsx | hint 文案 | 修改 | hint「创建训练任务 #N」改「v{baseMajor}.{nextSeq} 训练任务」（baseMajor 从选中 baseVersion.label split[0]，nextSeq=nextTaskSeq） | MUST 与新命名一致 | 同上 | +2/-1 |
| academy-i18n | app/web/src/i18n/locales/zh-CN/academy.json | 新增 key | 新增 | `tasks.nameWithVersion` / `versionTree.adoptedFromLabel` / `versionTree.procName` / `tuple.memoryView` / `tuple.memoryEmpty` / `tuple.memoryCount`（memory 卡新 key） | MUST zh-CN + en 两份 key 一一对应；MUST NOT 删旧 key `tasks.nameWithMode` / `versionTree.taskN` / `versionTree.adoptedFrom`（过渡期保留，doc-modifier 阶段5 评估清理） | context.md 问题6b i18n | +10 |
| academy-i18n | app/web/src/i18n/locales/en/academy.json | 同上 en key | 新增 | 英文翻译，与 zh-CN 一一对应 | MUST key 闭合对应 | 同上 | +10 |

## 影响面评估

**跨模块**：academy 域 7 个修复区集中在 `app/server/src/academy/` + `app/server/src/handlers/academy-*.ts`（后端）与 `app/web/src/components/academy-page/` + `app/web/src/i18n/locales/{zh-CN,en}/academy.json` + `app/web/src/lib/academy-api.ts`（前端）。无跨域（context/llm/squad）影响。

**破坏性变更**：① StudentDetail response 加 tasks（additive，前端旧消费方 `classroomDetail?.tasks` 兼容）；② task DTO 加 baseVersionLabel（additive 可选）；③ StudentVersionSchema 加 adoptedFromProcessVersionId（additive 可选）；④ resolveVersionContent 返回加 memoryEntries（additive）；⑤ memory API 字段从恒 [] 改真实条目（前端原死占位改卡片，契约升级）。均为**additive**，旧客户端不破。

**依赖顺序**：后端 schema/原语（1c schema + 3 resolveVersionContent）→ 后端 handler（1c adopt 写 + 1.7 tasks + 3 content + 6b 反规范化）→ 前端 type + UI。无 SDK/protocol 底层先决。

**风险点**：① 轮询 timer 生命周期（MUST 复用 startTimer + mutateCtx 软刷新，禁止 runInit 堆叠 — 见 use-training-task.ts 既有坑）；② 1b label-major 匹配若 versions 含异常 label（非数字 major）需兜底（formal 版本由系统分配 major 递增，理论安全，但 orphanProc 分支保留）；③ memory IO 须 graceful（0.0 版本无 .rocky/memory/）。

**spec↔code 已知漂移**（doc-modifier 阶段5 统一修，coder 按代码实际 + 汇报偏离）：
- `[P0]data_model.md §6` adoptToFormal 签名 spec 写 `(store, processVersionId)` 2 参，**实际 `(store, root, classroomId, processVersionId)` 4 参**（academy-store-ops.ts:117）。
- `specs/api/overall/18-academy.md §6` SSE 章节：spec 声明 training.\* SSE，**代码零 SSE**（走 a2a inbox + 前端轮询）。本版前端轮询兜底，spec 标「SSE 后置」。
- `specs/api/overall/18-academy.md §1.8` memory 字段：spec 注「恒 []」，本版实现真实条目。
- `specs/ui/overall/12-academy.md §4` tuple-grid：spec 五元组，本版四元组（Tools 删）。
- `specs/ui/overall/12-academy.md §4/§5`：任务卡渲染门 + 训练观察入口扩终态，spec 由 doc-modifier 同步。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec↔code 漂移（如 adoptToFormal 签名）→ coder 按代码实际实现 + 汇报偏离 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段5 统一修 spec
