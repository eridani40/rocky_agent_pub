---
type: spec
title: Session Kind 扩展 — 3 新 academy kind + profile/scope 矩阵
priority: P0
status: active
updated: 2026-07-31
since: v0.0.210
---

# Session Kind 扩展 — 3 新 academy kind

> 定位：扩展现有 SessionKind 枚举（biz/role/derivation）+ SessionContext + profile/scope yaml 矩阵，承载 head_teacher/coach/student 三种 academy 身份。
> 原则：复用现有机制（profile.toolBound 单源 + scopeId 纯拼接 + SessionTypePolicy.resolveToolSet 三层一致），不发明新概念。
>
> **[v0.0.221] 两工具拆分**：三工具（train-student / manage-student / manage-classroom）→ **两工具**（manage-student 9 action 并入 manage-classroom；train-student 改名 manage-task 变 coach 专属）。head profile.toolBound 去 train-student/manage-student，保留 manage-classroom（扩 20 action）；coach profile.toolBound 改 train-student→manage-task。新增 mapper `academy_head_role`。详见 design.md §3。

## 1. 枚举扩展（`app/shared/src/types/session-kind.ts`）

```typescript
// [v0.0.210] academy 板块身份扩展
export type BizType = 'playground' | 'studio' | 'academy';           // 新增 academy
export type Role = 'rocky' | 'leader' | 'mate' | 'squad'
  | 'head_teacher' | 'coach' | 'student';                             // 新增 3 academy 角色
// Derivation 不变（parent/subagent）
// RunKind 不变（main/summary/consolidate）
```

### 1.1 校验规则扩展

`validateSessionKind` 新增：
- **K4** role ∈ {head_teacher, coach, student} ⇒ biz='academy'
- 原有 K1/K2/K3 不变。

`validateSessionContext` 新增：
- **C4** biz='academy' && derivation='parent' ⇒ classroomId 必填（所有 academy parent session 都归属教室）
- **C5** role='head_teacher' && derivation='parent' ⇒ 不要求 memberId/studentId（head 不绑定 student）
- **C6** role='coach' && derivation='parent' ⇒ trainingTaskId 必填（coach 一定绑定一个训练任务）
- **C7** role='student' && derivation='parent' ⇒ studentId + versionId 必填（student session 绑定具体版本）

### 1.2 SessionContext 扩展

```typescript
export interface SessionContext {
  squadId?: string;
  memberId?: string;
  parentSessionId?: string;
  // [v0.0.210] academy 实例上下文 ID
  classroomId?: string;        // academy 所有 session 必填
  studentId?: string;          // student session 必填
  versionId?: string;          // student session 必填（具体版本）
  trainingTaskId?: string;     // coach session 必填
}
```

## 2. canonical id 与文件命名

```
id = ${biz}-${role}:${derivation}:${runKind}

新 9 个组合（3 role × 3 runKind）：
  academy-head_teacher:parent:main       / :summary       / :consolidate
  academy-coach:parent:main              / :summary       / :consolidate
  academy-student:parent:main            / :summary       / :consolidate
```

- 文件名 = id 中 `:` 换 `.`：`academy-head_teacher.parent.main.yaml`。
- summary/consolidate 的 biz/role/derivation = host session 的 kind（旁路 run 不另立身份）。

## 3. profile yaml 矩阵（9 文件）

### 3.1 head_teacher.main（head 工具集 — 教室资产管理 + 训练发起）

```yaml
# app/plugins/session-types/academy-head_teacher.parent.main.yaml
id: academy-head_teacher:parent:main
extends: default
autoNaming: false                  # head 有固定名（教室名 + "班主任"）
toolBound:
  # 文件基础
  - read
  - write
  - edit
  - glob
  - grep
  - bash
  # self-evolution
  - skill
  - skill_manage
  - memory
  - memory_manage
  # 网络学习
  - web_search
  - web_fetch
  - browser
  - see_image
  # multi-agent（可派生 explorer subagent 做调研）
  - agent
  - send_message
  # 任务调度
  - cron
  - ask-question
  # 历史召回
  - history_search
  - history_get_context
  # ── academy 专属 ──
  - manage-classroom        # [v0.0.221] 扩 20 action：原 dataset/grader/skill + 学生 CRUD 7 + 任务监督 4（start_task/list_tasks/get_task/update_task）
  # [v0.0.221] 已去除：- train-student（head 不再有 task lifecycle 权限；改 manage-classroom 监督级）
  #                   - manage-student（9 action 全部并入 manage-classroom）
runShape:
  drainMode: eager
  maxIterDefault: 25
  touchesStateMachine: true
  persistsRun: true
  usagePartition: current
eventChannel:
  emitDefault: true
skillSource: global-enabled
preloadContext: none
userReachable: true                # head 可与用户直接对话
```

### 3.2 coach.main（coach 工具集 — 训练执行容错层）

```yaml
# app/plugins/session-types/academy-coach.parent.main.yaml
id: academy-coach:parent:main
extends: default
autoNaming: false                  # coach 名 = "教练·任务#N"（建任务时自动命名）
toolBound:
  - read
  - write                 # 基础文件写（candidate 版本 AGENTS.md/skill/memory 修订刚需；edit 管改已有、write 管建新）
  - edit
  - glob
  - grep
  - bash
  - skill
  - skill_manage
  - memory
  - memory_manage
  - web_search
  - web_fetch
  - browser
  - see_image
  - agent                  # 派生 explorer/knowledge_learning_trainer subagent（优化/评估辅助）
  - send_message           # 与 head / subagent 沟通
  - history_search
  - history_get_context
  - ask-question
  # ── academy 专属 ──
  - manage-task             # [v0.0.221] 原 train-student 改名 + 重构：coach 专属 task 推进 + adopt 旁路 + pause/resume（去 start/stop/accept/reject/propose）
userReachable: true                # coach 可与用户直接对话（design.md §8.7）
```

> **关键 [v0.0.221]**：coach 只绑 `manage-task` 工具（task 全权推进 + adopt 旁路 + pause/resume）；不绑 `manage-classroom`（教室资产/学生 CRUD/任务监督是 head 专属）。工具层无 action 级权限矩阵（旧 train-student 的 head/coach 分权已废弃——head profile.toolBound 直接不含 manage-task，从根上隔离）。
>
> **基础文件工具给全**（write+edit）：coach 在任务内推进修订 candidate 版本的 AGENTS.md / skill / memory 等刚需写文件；旧版只给 edit 是基于「教练只改已有文件」的假设，实际 coach 也会建新文件（新 skill 目录、新 memory 片段），缺 write 时被工具权限层 `tool_not_allowed` 拦截只能绕 bash 写盘（v0.0.215 实证），故与 head 一致给全 write+edit。

### 3.3 student.main（student 工具集 — 学习工具子集）

```yaml
# app/plugins/session-types/academy-student.parent.main.yaml
id: academy-student:parent:main
extends: default
autoNaming: false                  # 学生 session 名 = 学生名 + 版本号
toolBound:
  - read
  - write                 # 基础文件写（默认给；version.json.tools 可作 instanceOverride 进一步收窄）
  - edit                  # 基础文件改（同上）
  - glob
  - grep
  - bash
  - skill
  - memory
  - web_search
  - web_fetch
  - see_image
  # 无 skill_manage/memory_manage（学生不自改 skill/memory；优化由训练链路写新版本目录）
  # 无 agent/send_message（不与外部沟通；只产出 answer）
  # 无 train-student（学生不操纵训练）
userReachable: true                # 用户可与版本 agent 直接对话（design.md §8.g 每个正式版可发起会话）
```

> **基础文件工具给全**（write+edit）：学生演练工作时需要写/改文件（如 sample 跑 dataset 题目产出答案文件、跑测试验证五元组改动）；旧版只给 read 是基于「学生不改 workspace」的假设，实际学生演练做不了活就影响验收（v0.0.215 用户裁决推翻原假设）。`version.json.tools` 仍可作 instanceOverride 在 bound 内进一步收窄（详见 §6）——如某学生演练场景明确禁止写盘，version.json.tools = `["read","glob","grep","bash"]` 即可。
>
> **注意**：student profile 工具白名单只是**默认上限**；version.json.tools 字段可作 instanceOverride 进一步收窄（详见 §6）。

### 3.4 summary / consolidate 矩阵（6 文件）

按 `[P0]session_type_profile.md §4` 矩阵完整性要求，每个 main 都要有对应 summary + consolidate：

| kind | main | summary | consolidate |
|---|---|---|---|
| head_teacher | 复用 default + academy 工具 | `extends: summary` | `extends: consolidate` |
| coach | 同上 | 同上 | 同上 |
| student | 学习工具子集 | 同上 | 同上 |

> summary/consolidate 共性已在 `app/plugins/session-types/summary.yaml` / `consolidate.yaml` 基座定义；3 个 academy summary 文件 = `{id, extends: summary}`，consolidate 同理。Validator 校验闭合（`validateMainMatrix`）。

## 4. scope yaml 矩阵（9 文件）

- `app/plugins/scopes/academy-head_teacher.parent.main.yaml`：定义 head 的 system_prompt_mapper / system_reminder EP 链（含 academy 特有 mapper：classroom_role / dataset_overview / grader_overview / task_status）。
- `app/plugins/scopes/academy-coach.parent.main.yaml`：coach prompt 链（含 training_directive / iteration_state / subagent_tree）。
- `app/plugins/scopes/academy-student.parent.main.yaml`：student prompt 链（极简 — identity + tools）。
- summary/consolidate 各 `extends: summary` / `extends: consolidate`（基座 + academy 共性）。

### 4.1 新 academy mapper（point impl）

| mapper impl | 用途 | 归属 scope |
|---|---|---|
| `academy_classroom_role` | 教室身份正文（"你是 X 教室的班主任/教练/学生"） | 三个 main scope |
| `academy_coach_role` | [v0.0.221] 重写：coach 绝对主权 + advisory（directive 非硬命令）+ 工作流（evaluate→反思→edit→revise→循环→adopt 旁路）+ manage-task action 说明（adopt/pause/resume，去 propose）+ academy-train-skill/learn-skill 可加载指针 | coach main scope |
| `academy_training_directive` | 训练任务 directive 透传进 coach prompt（[v0.0.221] 注明 advisory 语义） | coach main scope |
| `academy_iteration_state` | [v0.0.221] 扩充：taskId/taskSeq/classroomId/studentId+name + mode/optimizeStyle + 生命周期（status/resumable/maxTurns 软提示/roundsUsed）+ **candidate versionId+label+workspaceDir 绝对路径** + **base versionId+label+workspaceDir 绝对路径**（coach 读 base AGENTS.md）+ temporaryBaseline(versionId+avgScore) + **版本谱系（本 task 全部 process 版：[{round,versionId,label,decision,avgScore,workspaceDir}]）** + **已采纳 formal（本 task 归档的：[{versionId,label,adoptedFromProcessLabel}]）** + dataset/grader 概览 | coach main scope |
| `academy_classroom_assets` | 教室数据集/评估器/skill 概览 | head main scope |
| `academy_classroom_students` | 学生名单（名字/id/当前正式版 label+versionId/版本数/在跑任务 #seq status 轮次；空名单给 create_student 指针） | head main scope |
| `academy_task_status` | [v0.0.221] 补：每 task 行加 **coachSessionId**（head send_message 目标）+ produced formal count + last decision；任务态对齐新生命周期（active/paused+reason） | head main scope |
| `academy_head_role` | **[v0.0.221] NEW**：head 角色职责（管学生/资产/任务监督）+ **「task 内部要效果 → send_message 给该 task 的 coach（别自己伸手）」指引** + update_task 用途说明（调大 maxTurns 让 coach 续训） | head main scope |

> **任务书 vs system prompt 分工**：system prompt mapper（academy_coach_role）给**稳定的"怎么当教练"**（身份+方法论+工具说明+skill 指针）；**任务书**（initial user message，由 `createTrainingTaskAndCoach` 核心投递）给**这次具体任务**（学生上下文+candidate ws 路径+directive+工作流指引）。两者每轮注入互补。
>
> **实际注册路径**：impl 落 `app/plugins/builtins/rocky_context/prompt/academy-*.ts` + 在 `app/plugins/builtins/rocky_context/plugin.json` 的 `extImpls` 列表注册；academy mapper 通过 `academy-*.scope.yaml` 的 `groups[].points[].impls:` 显式列出激活（仅在 academy scope）。
> 共享 helper：`academy-shared.ts` 提供 `AcademyContextLike` 鸭子类型（含 `task.candidateVersionId`、`students[].versionIds`、`tasks[].studentId`、顶层 `formalVersionLabels`（versionId→label，students mapper 渲染正式版 label 的数据源））+ `readAcademyContext` / `readClassroomId` / `readTrainingTaskId` / `readAcademyRole`。

## 5. 装配链（五元组 → SessionConfig，两入口统一核心）

启动 academy session：coach session 的创建由**统一核心** `createTrainingTaskAndCoach(deps, input)`（`app/server/src/academy/academy-training-core.ts`）封装；head/student 走 `createAcadamySession` handler。

### 5.0 createTrainingTaskAndCoach 核心（coach 建链）

```typescript
// app/server/src/academy/academy-training-core.ts
export interface CreateTrainingTaskInput {
  classroomId: string;
  studentId: string;
  baseVersionId: string;
  mode: 'simple' | 'multi';
  optimizeStyle: 'learning' | 'training';
  directive?: string;
  datasetId?: string;
  graderId?: string;
  maxTurns?: number;
}
export interface TrainingCoreDeps {
  academyStore: AcademyStore;
  sessionStore: SessionStore;
  agentManager: AgentManagerImpl;
  appConfig: AppConfigService;
  dataDir: string;
}

/** 两入口（HTTP handler + head 工具 start）统一调用 */
export async function createTrainingTaskAndCoach(
  deps: TrainingCoreDeps,
  input: CreateTrainingTaskInput,
): Promise<{
  task: TrainingTaskEntity;
  coachSessionId: string;
  candidateVersionId: string;
  candidateWorkspaceDir: string;
}>;
```

**5 步**（顺序是护栏——tid 先 gen 满足 C5 校验，candidate 先 fork 才能给 coach session 当 workspace）：
1. 校验（classroom/student/base formal/multi 必填 dataset+grader/同 student 无 running task）+ 分配 taskSeq + gen tid
2. fork 初始 candidate（round=1 自 base）→ candidateVersionId + workspaceDir
3. resolveAcademySessionModel（classroom.defaultModel → 未配则 throw，**v0.0.230 收窄去 app 默认**）→ createSession(coach, workspaceDir=candidate ws, academyTrainingTaskId=tid, classroomId)
   > 创建链与运行时链共用同一 resolver：`resolveAcademySessionModel` 内部调 `model-resolver.resolveModel({sessionType:'academy', classroom})`；运行时（POST /messages、/compact 等）经 `bootstrap-agent-phase.setResolveConfig → buildSessionConfigFromDeps` 走同一 academy 两档链（session → classroom.defaultModel，任一保留字/不可用继续下探，跑空抛 `MODEL_NOT_CONFIGURED`）。**v0.0.230 删第三档 `app_config.default_models.chat`**——app 默认是 playground 个体级概念，群体级（academy/studio）无应用层默认；教室未配 defaultModel → 建任务/运行均明确报错引导去教室 head 配置。
4. putTask(coachSessionId, candidateVersionId, temporaryBaselineVersionId=baseVersionId, status='pending')
5. 读 base resolveVersionContent + 组装 TaskBookPayload → deliverTo(coach, buildTaskBookMessage) fire-and-forget

> **coach workspaceDir = 初始 candidate ws**（修原 cwd 错位：原 coach ws=head-workspace 空目录）。round2+ candidate 换目录时由 iteration_state mapper 注入新 candidate ws 绝对路径，coach 按 prompt 中绝对路径编辑。

### 5.0b createStudentWithInitialVersion 核心（建学生两入口统一）

```typescript
// app/server/src/academy/academy-student-core.ts
export interface CreateStudentCoreInput {
  classroomId: string;
  name: string;
  logo?: string;
  /** 初始模型快照（缺省 → classroom.defaultModel → 未配则 `model_not_configured`；v0.0.230 收窄去 app 默认 fallback 链） */
  model?: { providerId?: string; modelId: string };
}
export interface StudentCoreDeps {
  academyStore: AcademyStore;
  appConfig: AppConfigService;
  /** dataDir 绝对路径（resolveDataDir 展开后，packaged 护栏 BUG-004） */
  dataDir: string;
}

/** 两入口（HTTP handleCreateStudent + manage-student.create_student）统一调用 */
export async function createStudentWithInitialVersion(
  deps: StudentCoreDeps,
  input: CreateStudentCoreInput,
): Promise<{ student: StudentEntity; initialVersion: StudentVersionEntity | undefined }>;
```

**4 步**（从 HTTP handler 平移，不改编排）：
1. classroom 存在校验 + name 非空校验（→ `StudentCoreError('classroom_not_found' | 'invalid_input')`）
2. resolveAcademySessionModel 播种初始 model（input.model → classroom.defaultModel → 未配则 `model_not_configured`；**v0.0.230 去 app 默认兜底**，教室未配 defaultModel 时建学生同样报错引导；**禁写死保留字**——训练 sample 读 version.json.model 直调 LLM；失败 → `StudentCoreError('model_not_configured')`）
3. putStudent → createInitialFormalVersion（建 0.0 空版）→ 回写 `currentFormalVersionId` + `versionIds`
4. getVersion 重读 initialVersion → 返 `{ student, initialVersion }`（与 HTTP 201 响应形状一致）

**错误契约**：`StudentCoreError(code)` 由 caller 映射——HTTP handler 按 `STUDENT_CORE_HTTP_STATUS`（classroom_not_found=404 / model_not_configured=400 / invalid_input=400）映射状态码；工具层按 code 拼 errorResult 字符串。核心本身不依赖 HTTP Request/Response（纯核心，两入口共享，同 `createTrainingTaskAndCoach` 模式）。

> **为什么抽核心**：HTTP handler 与 head 工具都需要「建学生 + 0.0 初始版 + 回写指针」同一套编排；若各写一份会漂移（两入口建 0.0 版逻辑不一致 → 训练 sample 读到不同字段）。仿 `createTrainingTaskAndCoach` 抽统一核心，两入口各自只剩「参数收集 + 错误映射」薄壳。

### 5.1 createAcadamySession（head/student 通用装配，不变）

```typescript
// app/server/src/handlers/academy-session.ts
async function createAcadamySession(input: {
  classroomId: string;
  role: 'head_teacher' | 'coach' | 'student';
  // student 专属
  studentId?: string;
  versionId?: string;
  // coach 专属
  trainingTaskId?: string;
  // head 专属：无
  // 公共
  workspaceDir: string;
  modelId?: string;
  providerId?: string;
  /** version.json.tools（仅 student）—— instanceOverride */
  tools?: string[];
}): Promise<Session> {
  // 1. 构造 kind + context
  const kind = new SessionKind({ biz: 'academy', role: input.role, derivation: 'parent' });
  const ctx: SessionContext = {
    classroomId: input.classroomId,
    ...(input.studentId ? { studentId: input.studentId } : {}),
    ...(input.versionId ? { versionId: input.versionId } : {}),
    ...(input.trainingTaskId ? { trainingTaskId: input.trainingTaskId } : {}),
  };
  validateSessionKind(kind);
  validateSessionContext(kind, ctx);

  // 2. createSession（主 SessionStore；profile + scope 自动按 kind 解析）
  return await sessionStore.createSession({
    id: ulid(),
    biz: 'academy',
    role: input.role,
    derivation: 'parent',
    workspaceDir: input.workspaceDir,
    modelId: input.modelId ?? 'default',
    providerId: input.providerId,
    // academy 实例上下文 4 字段（CreateSessionInput → SessionRecord.academyXxx 落盘）
    classroomId: ctx.classroomId,
    studentId: ctx.studentId,
    versionId: ctx.versionId,
    trainingTaskId: ctx.trainingTaskId,
    // tools instanceOverride（仅 student 用，subAgentConfig.tools 装配链；详见 §6）
    ...(input.tools ? { subAgentConfig: { tools: input.tools } } : {}),
  });
}
```

### 5.1 CreateSessionInput → SessionRecord plumbing（完整读写链）

**写侧**（`CreateSessionInput` → `SessionRecord`，在 `session-store-core-impl.ts` createSession）：
- `CreateSessionInput.classroomId/studentId/versionId/trainingTaskId`（4 字段）→ 映射为 `SessionRecord.academyClassroomId/academyStudentId/academyVersionId/academyTrainingTaskId`（schema_defs/session.ts 持久化字段）。
- 写时 `validateSessionContext` 校验 C4-C7（academy parent 必填 classroomId；coach 必填 trainingTaskId；student 必填 studentId + versionId）。

**读侧投影链**（`SessionRecord` → `Session` 业务对象 → `SessionContext`，**4 处都补齐**才能让 train-student 工具读到 `rtc.sessionContext.classroomId`）：
1. `Session` interface 加 `academyClassroomId/academyStudentId/academyVersionId/academyTrainingTaskId`（session-store-types.ts）。
2. `toSession`（session-store-converters.ts）：SessionRecord → Session 时投影这 4 字段。
3. `getSessionContext`（session-store-core-impl.ts）：从 Session 抽出 SessionContext（`classroomId` 等），传 resolveConfig。
4. `setBuildAgentToolContext`（bootstrap-agent-phase.ts）：rtc.sessionContext 注入 4 字段（**train-student 工具读 `rtc.sessionContext.classroomId`**——不补则工具生产全废「caller has no classroomId」）。

### 5.2 SessionConfig.academyContext 注入（mapper 数据源）

`SessionConfig.academyContext?: unknown` 是**鸭子类型字段**（context-types.ts），形状见 `app/plugins/builtins/rocky_context/prompt/academy-shared.ts AcademyContextLike`。

**装配时机**：resolveConfig 回调（**每轮 prompt 组装都走**——iteration/task 每轮变，必须现拉最新）调 `buildAcademyContext(kind, sessionContext, academyStore)`（`academy-context.ts`，112 行）：
- 按 role 裁剪：head_teacher 拉 classroom + students/datasets/graders/tasks（教室资产 + 任务看板）+ 逐生 `safe(getVersion)` 解析正式版 label 组装 `formalVersionLabels`（单生失败跳过不阻塞）；coach 拉 classroom + task + turns（训练 directive + 迭代状态）；student 仅 classroom。
- 容错：任一 entity 查询失败 → 对应字段 undefined（mapper graceful degrade 返空），不 throw 阻塞 prompt 组装。
- 非 academy session（biz ≠ 'academy' 且 role ∉ {head_teacher,coach,student}）→ 不注入 academyContext（mapper 链也不含 academy impl，双保险）。

> 生产验证 mapper 是否生效：`GET /session/:id/debug/system-prompt`（session-debug，test gate）看 head/coach prompt 是否含教室身份 / directive / 轮次。

## 6. version.json.tools 装配（student 版本级白名单）

```typescript
// buildSessionConfigFromDeps 内（academy-student 分支）：
//   读 version.json.tools → 作 instanceOverride 传 resolveToolSet
//   resolveToolSet(kind, { tools: version.tools }) = version.tools ∩ academy-student.parent.main.bound
//   结果 = config.tools / spec.toolDefinitions / spec.allowedTools（三层一致）
```

- 缺省 version.json.tools = bound 全集（=student profile.toolBound）。
- version.json.tools ∩ bound = 最终生效白名单；不在 bound 的工具名静默剔除（防 LLM 看到无效工具）。

## 7. 工具实现：manage-task + manage-classroom（[v0.0.221] 三工具→两工具）

> **[v0.0.221] 工具拆分**：
> - `train-student`（14 action）→ 改名 **`manage-task`**（13 action，coach 专属；去 start/stop/accept/reject/propose，加 adopt/pause/resume/history）。
> - `manage-student`（9 action）→ **并入 `manage-classroom`**（manage-student-tool.ts 文件删除；manage-student-actions.ts + manage-student-training-actions.ts 保留为 helper 模块被 manage-classroom-tool.ts import）。
> - `manage-classroom`（原 9 action）→ **扩为 20 action**（原 dataset/grader/skill + 学生 CRUD 7 + 任务监督 4）。
> - head profile.toolBound 去 train-student/manage-student，保留 manage-classroom；coach profile.toolBound 改 train-student→manage-task。

- `manage-task`：1 工具 13 action（详见 `[P0]train_student_tool.md`，已重命名）；**coach 专属**（head 不再有 task lifecycle 权限）。
- `manage-classroom`：1 工具 **20 action**（仅 head 可见；coach/student profile.toolBound 不含）：
  - dataset/grader/skill（原 9 action 不变）
  - 学生 CRUD（原 manage-student 7 action：list_students/get_student/create_student/update_student/delete_student/list_versions/get_version）
  - 任务监督（4 action：`start_task` / `list_tasks` / `get_task` / `update_task`）

### 7.1 manage-classroom 的任务监督 4 action（[v0.0.221] 新增）

| action | 语义 |
|---|---|
| `start_task` | head 发起训练（原 manage-student.start_training 改名；薄壳调 `createTrainingTaskAndCoach` 同核心） |
| `list_tasks` | 教室任务看板（原 manage-student.training_status 看板模式；可选 studentId/studentName 过滤；按 createdAt 倒序） |
| `get_task` | 单 task 详情监督级（含 history 摘要；**不下钻 per-case reasoning**——head 监督级，per-case 是 coach 专属） |
| `update_task` | **新增**：patch `{maxTurns?, directive?}`（仅此两字段；用于让 coach 续训越过原 maxTurns 上限，或调整 directive 给建议）；不改 task.status/candidateVersionId/temporaryBaseline（内部状态） |

> **start_training → start_task 改名**：语义统一（"任务"模型贯穿）；逻辑不变（薄壳调统一核心）。
> **training_status → list_tasks/get_task 拆分**：原 training_status 一个 action 兼任看板+单 task 详情，现拆为两 action 各司其职（看板 / 单 task 监督级）。
> **manage-student 7 action 不变**（list_students/get_student/create_student/update_student/delete_student/list_versions/get_version）：只是工具归属从 manage-student 换到 manage-classroom，函数实现保留在 manage-student-actions.ts。
> **delete_student 守卫更新**：在跑任务集合改 `new Set(['pending','running','paused'])`（去 awaiting_confirm/done，加 paused）。

### 7.2 原 manage-student（已并入 manage-classroom，本节保留作历史参考）

仅 head 可见（coach/student profile.toolBound 不含；工具层 role 兜底校验同 manage-classroom）。1 工具 9 action：

| action | 语义 |
|---|---|
| `list_students` | 列学生 + 逐生 enrich（当前正式版 label+versionId / 版本数 / 在跑任务交叉）；可选 `name` 过滤（二段匹配：精确 ci → 子串；无匹配返空数组不报错） |
| `get_student` | 按 `studentId` 或 `studentName` 取单生 + 版本摘要（名字歧义返候选列表 errorResult） |
| `create_student` | 建学生 + 0.0 初始版 — 薄壳调统一核心 `createStudentWithInitialVersion`（`academy-student-core.ts`，与 HTTP `handleCreateStudent` 共享，仿 §5.0 两入口模式）；`StudentCoreError(code)` 转 errorResult 保 code |
| `update_student` | patch name/logo（仅此两字段） |
| `delete_student` | 在跑任务（pending/running/awaiting_confirm）守卫拒绝（提示先 stop）；级联**硬删**（全部 version records + student record + `fs.rm studentRoot`，不可恢复——CrudStore 查询侧不过滤 `_deleted`，软删会污染 mapper 数据源） |
| `list_versions` | 某学生全部版本摘要（label/type/status/taskSeq/round） |
| `get_version` | 版本五元组读取：`agentsMd` 全文 / `model` / `tools` / `skillNames` / `memoryFiles`（缺 version.json → model/tools 返 null 不报错） |
| `start_training` | head 发起训练 — 薄壳调 `createTrainingTaskAndCoach`（与 `train-student.start` 同核心，复用其 `buildCoreDeps`/`coreErrorToResult`）；`studentId` 或 `studentName` 解析（歧义返候选）；`baseVersionId` 缺省 = 学生当前正式版；mode/optimizeStyle 默认与 runStart 一致（multi/training） |
| `training_status` | `taskId` 给 → task+turns（同 train-student.status 语义）；否则教室任务看板（可选 studentId/studentName 过滤）按 createdAt 倒序摘要（done → `acceptedVersionId` 可再 get_version 读五元组）；纯 store 读不依赖 trainingEngine |

> **分工**：manage-student 是 head 的学生 CRUD/版本读取/发起训练/训练查询主入口；train-student 保留 coach 任务内推进 + head 审核（accept/reject/stop/evaluate/status 不动）。两 start 入口（HTTP / train-student.start / manage-student.start_training）同核心 `createTrainingTaskAndCoach`。

> **已知偏离（BUG-001，pre-existing known-issue）**：`get_student` / `list_students` 返回的 `currentFormalVersionLabel` / `currentFormalVersionId` 读自 `student` record 的指针；但现 `acceptTask`（`training-engine/lifecycle.ts`）只更新 `task.acceptedVersionId` + 新 formal version 的 active 状态，**未同步更新 `student.currentFormalVersionId` 指针**。结果：accept 发布新正式版 v1.0 后，实体已正确落库（`list_versions` 显示 1.0 active），但 `get_student` 仍报 v0.0。根因在 accept 流程（非 v0.0.215 引入），修在 write 侧（accept 时同步 student 指针）而非读侧兜底。详 `states/v0.0.215/bugs/BUG-001-academy-accept-read-side-pointer-lag-[open].md`。

## 8. API 端点 biz 过滤

- `GET /session?biz=academy` → 仅返 academy session（与 playground/studio 隔离）。
- `handlers/session.ts` 扩展：`bizParam === 'academy'` → `bizFilter = 'academy'`；缺省 / 'playground' / 非法值 → playground（现状不变）。
- UI 列表守卫（`chat-slice.ts`）：academy-page 用 `?biz=academy` 拉；playground/studio 页保持原过滤。

> **路由分发**（academy-routes.ts）：`dispatchAcademyRoutes(req, method, path, deps)` 按最长前缀优先分发——具体 pattern（`/academy/training-task/*` / `:cid/student/:sid/training-task` / `:cid/student/:sid/version/*` / `:cid/student/:sid` / `:cid/{dataset,grader}/*`）全部先于 generic `/academy/classroom/` 前缀判断，避免 swallow 深层路径。`AcademyHandlerDeps` = `{ academyStore, trainingEngine, agentManager, sessionStore, appConfig, dataDir }`——**`dataDir` 必传**（workspace 路径根；resolveDataDir 展开后绝对路径，packaged 护栏 BUG-004）；`appConfig` 用于建学生初始版本播种默认 model 的 resolveModel。
>
> **`GET /academy/session?classroomId=:cid` 未实现**：API spec §4.1 早期草案写过该端点，实际未实现——前端走 `GET /session?biz=academy` + 客户端按 `academyClassroomId/academyVersionId` 过滤兜底。

## 9. nav-rail 第 3 业务入口

- `view-store.ts ViewId` 加 `'academy'`。
- `nav-rail.tsx` 顶部业务区从 2 项（Playground/Studio）扩为 3 项（+ Academy 🎓）。
- `app-shell.tsx` MainView union 加 academy 分支 → 路由到 `page-academy.tsx`。

## 10. 边界

| 管 | 不管 |
|---|---|
| academy 3 kind 枚举 + 校验 + SessionContext 扩展 | 本文 ✅ |
| profile/scope yaml 矩阵内容 | 本文 §3/§4 ✅（文件由 coder 落） |
| createAcadamySession 装配链 | 本文 §5 ✅ |
| session schema_defs 扩展（academy 4 实例字段） | `../../agent/session/[P0]session_store.md` |
| academy toolBound 含的工具本身的契约 | `../../agent/tools/` + 本文 `[P0]train_student_tool.md` |
| 9 个 yaml 文件实际内容 | coder 按本文 §3 落 yaml |
