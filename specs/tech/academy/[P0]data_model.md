---
type: spec
title: Academy Data Model — schema/store/目录规范
priority: P0
status: active
updated: 2026-07-31
since: v0.0.210
---

# Academy Data Model — Schema + Store + 目录规范

> 定位：academy 域 6 个 entity 的 SchemaDef + Store 接口 + 落盘目录规范。复用现有 CrudStore（file engine）+ SessionStore（不动）。
> 落盘根：`<DATA_DIR>/academy/<classroomId>/`，classroom 隔离。

## 1. Entity 总览

> 落盘规范：所有 entity 走 CrudStore 一级分片（按 `classroomId` shard），平铺路径 `{root}/academy/{cid}/{entity}/{id}.json`（classroom entity 是 `{root}/academy/{cid}/classroom/{cid}.json`，自分片自读）。entity 名 = 目录名，**复数化**避免与单数 classroom 冲突。
> 工作区目录（versions/{label}/ws/ 等）由 `academy-paths.ts` + `academy-version-dir.ts` 管，**不走 CrudStore**——是另一层 IO。

| Entity（目录名） | 落盘路径 | 分片键 | 关联 |
|---|---|---|---|
| `classroom` | `academy/{cid}/classroom/{cid}.json` | classroomId（自分片） | head session（双向） |
| `students` | `academy/{cid}/students/{sid}.json` | classroomId | classroom（外键）+ versionIds + currentFormalVersionId |
| `student_versions` | `academy/{cid}/student_versions/{vid}.json` | classroomId | student（外键）+ parentFormalVersionId（自关联） |
| `training_tasks` | `academy/{cid}/training_tasks/{tid}.json` | classroomId | classroom + student + baseVersionId + coachSessionId + acceptedVersionId |
| `training_turns` | `academy/{cid}/training_turns/{tid_或_seq}.json` | classroomId | task（外键 taskId） |
| `datasets` | `academy/{cid}/datasets/{did}.json` | classroomId | classroom |
| `graders` | `academy/{cid}/graders/{gid}.json` | classroomId | classroom |

> **工作区目录规范**（版本五元组落盘，由 `academy-paths.ts` 管，**非 CrudStore 路径**）：每个 `student_version` 有 `workspaceDir`（绝对路径）——正式版 = `students/{sid}/versions/{label}/ws/`；过程版 = `students/{sid}/versions/.work/{base}.{taskSeq}/{round}/ws/`。AGENTS.md / .rocky/{skills,memory}/ / version.json 五元组全在这里。

## 2. classroom schema

```typescript
// app/server/src/academy/schema_defs/classroom.ts
export const ClassroomSchema = {
  entity: 'classroom',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    name: { type: 'string', required: true },           // 教室名（用户可改）
    logo: { type: 'string', required: false },          // emoji logo（demo 体现）
    headTeacherSessionId: { type: 'ulid', required: true }, // 建教室时自动建 head session，双向关联
    datasetIds: { type: 'json', required: false },      // string[]（追加/删除由 head 用工具维护）
    graderIds: { type: 'json', required: false },       // string[]
    skillIds: { type: 'json', required: false },        // string[]（教室级 skill 挂载；可选）
    archived: { type: 'boolean', required: false },     // 教室归档（lazy 默认 false）
    /**
     * 教室级默认模型（json 透传；格式同 version.json.model 五元组之一 a）。
     * 形状：`{providerId?:string, modelId:string}`（复合 ModelSelection，对齐 squad.modelDefault）。
     * 用途：① 建学生播种 0.0 初始版本 fallback 链中间档；② head/coach 会话 picker 顶部「默认模型」项数据源。
     * undefined / 未配 → picker 不显默认项；建学生播种链跑空 → 400 model_not_configured
     * （v0.0.230 去 app 默认兜底——群体级无应用层默认概念，与运行时链语义等价）。
     */
    defaultModel: { type: 'json', required: false },
    // createdAt/updatedAt/version 信封由 CrudStore 注入
  },
} as const satisfies SchemaDef;
```

### 2.1 建学生播种 fallback 链（version.json.model）

建学生（POST /academy/classroom/:cid/student）播种 0.0 初始版本的 version.json.model，按以下优先级 resolve（对齐 InputModelPicker 4 源）：

1. **body.model 显式具体 ModelRef**（非保留字）→ resolveModel 精确/反查 providerId
2. **classroom.defaultModel 具体非保留字**→ resolveModel 精确/反查 providerId

保留字（'default'/'none'/空）= 视为「跟随默认」跳过当前档继续 fallback；两档跑空 → 400 `model_not_configured`（**v0.0.230 去 app 默认兜底**——app 默认是 playground 个体级概念，群体级（academy/studio）无应用层默认，与运行时链语义等价）。学生 version.json.model 仍可单独覆盖（五元组契约不变）。

## 3. student + student_version schema

```typescript
// app/server/src/academy/schema_defs/student.ts
export const StudentSchema = {
  entity: 'student',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    classroomId: { type: 'ulid', required: true },      // 外键 classroom
    name: { type: 'string', required: true },           // 学生名（教室唯一，UI 显示）
    logo: { type: 'string', required: false },
    versionIds: { type: 'json', required: false },      // string[]（所有版本 id，UI 树形展示用）
    currentFormalVersionId: { type: 'ulid', required: false }, // 最新正式版 id（建学生时自动建 0.0 并填此字段）
    // createdAt/updatedAt/version
  },
} as const satisfies SchemaDef;

// app/server/src/academy/schema_defs/student-version.ts
export const StudentVersionSchema = {
  entity: 'student_version',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    studentId: { type: 'ulid', required: true },        // 外键 student
    classroomId: { type: 'ulid', required: true },      // 冗余（路径便利 + list 过滤）
    /** 版本号字面量：'0.0' / '1.0' / '1.2.3' 等 */
    versionLabel: { type: 'string', required: true },
    /** 'formal' = 正式版（含 0.0）；'process' = 过程版（训练中临时） */
    type: { type: 'enum', required: true, enumValues: ['formal', 'process'] },
    /** 正式版：null；过程版：基于的版本 id（multi-turn 场景指向 process 候选；见 §3 注） */
    parentFormalVersionId: { type: 'ulid', required: false },
    /** 过程版专属：任务序号（同 base 下递增）；正式版：null */
    taskSeq: { type: 'number', required: false },
    /** 过程版专属：轮次序号；正式版：null */
    roundNumber: { type: 'number', required: false },
    /** 由哪个训练任务产生（过程版必填；接受后转正的正式版也保留此字段作溯源） */
    createdFromTaskId: { type: 'ulid', required: false },
    /**
     * [v0.0.219] 该 formal 由哪个过程版本采纳而来（adoptToFormal 写入；仅 formal 有值）。
     * 初始 0.0 / 旧 record 无此字段（required:false）。UI 据此显「采纳自 v{label}」徽章。
     */
    adoptedFromProcessVersionId: { type: 'ulid', required: false },
    /** 工作区绝对路径（必填）——五元组落在此目录 */
    workspaceDir: { type: 'string', required: true },
    /** 'active' = 当前用；'adopted' = 已被接受转正（过程版专属终态）；'rejected' = 训练拒绝（保留可回看） */
    status: { type: 'enum', required: false, enumValues: ['active', 'adopted', 'rejected'] },
    // createdAt/updatedAt/version
  },
} as const satisfies SchemaDef;
```

> **`parentFormalVersionId` 字段名 multi-turn 误导**（语义注）：字段名含 "Formal" 是首版设计时设想的「过程版一定基于 formal」。但 multi-turn 训练迭代场景下，`temporaryBaselineVersionId`（临时基线）会更新为 round1 的候选 process 版本，round2+ fork 的 base 实际指向 process 版本——此字段也跟着指向 process（不是 formal）。schema 仅约束 `ulid + required=false`，不约束指向类型；字段名应理解为「parent baseline version id」（来源版本，formal 或 process 均可）。详见 §6 `forkVersionWorkspace` base 备注。

### 3.1 version.json（工作区内，五元组快照）

```typescript
// <workspaceDir>/version.json（不同于 StudentVersionSchema，这是版本内容快照，五元组之一 a/d/e）
{
  "versionLabel": "1.2.3",          // 冗余，便于离线工具识别
  "model": {                        // a 模型
    "providerId": "...",
    "modelId": "..."
  },
  "tools": ["read", "write", ...]   // e 工具白名单（可选；缺省 = student profile bound 全集）
  // b system prompt = <workspaceDir>/AGENTS.md（自动加载）
  // c memory = <workspaceDir>/.rocky/memory/（自动加载）
  // d skills = <workspaceDir>/.rocky/skills/（自动加载）
}
```

> **装配链**（[P0]session_kind_extension.md §4 详）：启动 `academy-student` session 时，`createSession` 读 `version.json` → `subAgentConfig.tools = version.tools` → `resolveToolSet(kind, instanceOverride)` = `tools ∩ academy-student.parent.main.bound`；model 走 version.json.model → session 持久 providerId+modelId。

> **d skills 读侧契约**：skills 落 `<workspaceDir>/.rocky/skills/`，一个 skill = **一个目录 + SKILL.md + 任意附属文件**（`../agent/skills/[P0]skill_definition.md §1/§2`），**不是单个 markdown**。对 UI/API 暴露的读侧形态是 `SkillSummary`（目录 + 文件树 + 每文件 hash），单文件内容按需读——原语见 §6.1，端点契约见 `specs/api/overall/18-academy.md §1.8`（列表随版本内容返回）+ `§1.11`（单文件读/写）。

## 4. training_task + training_turn schema

```typescript
// app/server/src/academy/schema_defs/training-task.ts
export const TrainingTaskSchema = {
  entity: 'training_task',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    classroomId: { type: 'ulid', required: true },
    studentId: { type: 'ulid', required: true },
    /** 训练 base：必须是 formal 版本（如 1.0） */
    baseVersionId: { type: 'ulid', required: true },
    /** 任务序号（在 base 下递增；过程版本号第 2 段） */
    taskSeq: { type: 'number', required: true },
    /** 绑定的 coach session（建任务时自动建） */
    coachSessionId: { type: 'ulid', required: true },
    /** 'simple' = 单轮无评估；'multi' = 多轮带评估 */
    mode: { type: 'enum', required: true, enumValues: ['simple', 'multi'] },
    /** 'learning' = 学习式（web_search 收集）；'training' = 训练式（数据集迭代） */
    optimizeStyle: { type: 'enum', required: true, enumValues: ['learning', 'training'] },
    /** simple=1；multi 默认 5（demo）；可用户调；[v0.0.221] update_task 可调大让 coach 续训越过原上限 */
    maxTurns: { type: 'number', required: false },
    /**
     * [v0.0.221] 任务状态机闭合 3 值（生产轴）：
     *   pending → running ↔ paused + pausedReason
     * adopt 是旁路（不改 task 状态，归档轴，见 §6 adoptToFormal）。
     * 原 awaiting_confirm/done/rejected/aborted 已去除（采纳解耦 + done/aborted 合并到 paused+reason）；
     * resumeOnStartup migration 把旧值映射到 paused+pausedReason（见 training_engine §6）。
     */
    status: {
      type: 'enum', required: true,
      enumValues: ['pending', 'running', 'paused'],
    },
    /**
     * [v0.0.221] pausedReason 闭合 4 值（status='paused' 时区分为何而停；其他状态必为 undefined）：
     *   - 'maxturns' = maxTurns 到顶（硬终态，不可 resume 越过；须 update_task 调大）
     *   - 'earlystop' = 连续 3 轮无提升（可 resume）
     *   - 'completed' = coach 主动 pause 表示目标达成（可 resume 续训）
     *   - 'stopped' = 用户/head 主动叫停（可 resume）
     */
    pausedReason: {
      type: 'enum', required: false,
      enumValues: ['maxturns', 'completed', 'stopped', 'earlystop'],
    },
    /** 训练目标（训练内要求透传，head 发起时填） */
    directive: { type: 'string', required: false },
    /** 当前轮次（0=尚未开始；1+=进行中） */
    currentTurn: { type: 'number', required: false },
    /** 临时基线版本 id（multi 模式：当前最优已采纳过程版；初始 = baseVersionId） */
    temporaryBaselineVersionId: { type: 'ulid', required: false },
    /** 当前 coach 在编辑的候选过程版本 id（revise improve 时晋升为 temporaryBaseline，并 fork 新 candidate 到此字段） */
    candidateVersionId: { type: 'ulid', required: false },
    /** 评估配置（multi 模式必填）：datasetId + graderId */
    datasetId: { type: 'ulid', required: false },
    graderId: { type: 'ulid', required: false },
    /** 最终接受时落（接受 = 复制临时基线为新正式版；指向新正式版 id） */
    acceptedVersionId: { type: 'ulid', required: false },
    /** 早停原因（连续 3 轮无提升） */
    earlyStopReason: { type: 'string', required: false },
    // createdAt/updatedAt/version
  },
} as const satisfies SchemaDef;

// app/server/src/academy/schema_defs/training-turn.ts
export const TrainingTurnSchema = {
  entity: 'training_turn',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    taskId: { type: 'ulid', required: true },
    classroomId: { type: 'ulid', required: true },       // 冗余（路径便利）
    studentId: { type: 'ulid', required: true },         // 冗余
    round: { type: 'number', required: true },           // 第 N 轮（1-based）
    /** 本轮 candidate 版本 id（过程版本 base.taskSeq.round） */
    candidateVersionId: { type: 'ulid', required: true },
    /** 'running' / 'sampled' / 'graded' / 'decided' / 'rejected' / 'adopted' */
    status: {
      type: 'enum', required: true,
      enumValues: ['running', 'sampled', 'graded', 'decided', 'rejected', 'adopted'],
    },
    /** sample 阶段产出：[{ caseId, studentOutput }]（学生答题输出） */
    sampleResults: { type: 'json', required: false },
    /** grade 阶段产出：[{ caseId, score, level, reasoning }]（reasoning 必填） */
    gradeResults: { type: 'json', required: false },
    /** 决策结果：'improve' / 'regress' / 'equal'（纯函数 gate） */
    decision: { type: 'enum', required: false, enumValues: ['improve', 'regress', 'equal'] },
    /** 本轮 avgScore（用户视角分数，用于判进化退化） */
    avgScore: { type: 'number', required: false },
    /** 反思总结（coach 生成或引擎整理） */
    reflection: { type: 'string', required: false },
    // createdAt/updatedAt/version
  },
} as const satisfies SchemaDef;
```

## 5. dataset + grader schema

```typescript
// app/server/src/academy/schema_defs/dataset.ts
export const DatasetSchema = {
  entity: 'dataset',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    classroomId: { type: 'ulid', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: false },
    /** 元素 = 问题 case（可带每 case 独立评估标准 + 期望答案） */
    items: {
      type: 'json', required: true,
      // Array<{ id: string, question: string, gradingCriteria?: string, expectedAnswer?: string }>
    },
    // createdAt/updatedAt/version
  },
} as const satisfies SchemaDef;

// app/server/src/academy/schema_defs/grader.ts
export const GraderSchema = {
  entity: 'grader',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    classroomId: { type: 'ulid', required: true },
    name: { type: 'string', required: true },
    /** 闭合枚举（首版只这两种；未来按需扩 'regex'/'contains' 等） */
    type: { type: 'enum', required: true, enumValues: ['llm-judge', 'em'] },
    /** type='llm-judge'：prompt 模板（含 {question}/{student_output}/{criteria} 占位符） */
    promptTemplate: { type: 'string', required: false },
    /** type='llm-judge'：可选指定模型（providerId+modelId），缺省 = 学生所用模型 */
    providerId: { type: 'string', required: false },
    modelId: { type: 'string', required: false },
    /** 分级阈值（默认 0.5；>= threshold = 正例，< = 负例） */
    threshold: { type: 'number', required: false },
    /** 'em' 类型专属：精确匹配规则（如大小写不敏感、trim） */
    matchRule: { type: 'json', required: false }, // { caseInsensitive?: boolean, trim?: boolean }
    // createdAt/updatedAt/version
  },
} as const satisfies SchemaDef;
```

## 6. Store 接口（拆分：CRUD facade + 业务原语）

为保证单文件 ≤300 行，Store 实现拆为两个文件：
- **`academy-store.ts`**（~178 行）：CRUD facade（7 entity 的 put / get / list / query），无业务逻辑。
- **`academy-store-ops.ts`**（~210 行）：业务原语模块函数（`forkVersionWorkspace` / `adoptToFormal` / `createInitialFormalVersion`），首参 `AcademyStore` 实例（共享 CrudStore 句柄）。

```typescript
// app/server/src/academy/academy-store.ts
/** academy 域统一 store facade（聚合 7 entity 的 CompositeStore） */
export class AcademyStore {
  constructor(opts: { root: string }) {
    this.store = new CompositeStore()
      .mount('classroom', fs)        // entity 名 = 目录名（classroom 单数；其余复数化）
      .mount('students', fs)
      .mount('student_versions', fs)
      .mount('training_tasks', fs)
      .mount('training_turns', fs)
      .mount('datasets', fs)
      .mount('graders', fs);
  }

  // classroom（自分片：shardKey=自身 id）
  async putClassroom(rec): Promise<ClassroomEntity>;
  async getClassroom(classroomId: string): Promise<ClassroomEntity | undefined>;
  async listClassrooms(): Promise<ClassroomEntity[]>;

  // student + version（按 classroomId 分片）
  async putStudent(rec): Promise<StudentEntity>;
  async getStudent(classroomId, studentId): Promise<StudentEntity | undefined>;
  async listStudentsByClassroom(classroomId): Promise<StudentEntity[]>;
  async putVersion(rec): Promise<StudentVersionEntity>;
  async getVersion(classroomId, versionId): Promise<StudentVersionEntity | undefined>;
  async listVersions(classroomId, studentId): Promise<StudentVersionEntity[]>; // 含过程版本

  // training task + turn
  async putTask(rec): Promise<TrainingTaskEntity>;
  async getTask(classroomId, taskId): Promise<TrainingTaskEntity | undefined>;
  async listTasksByClassroom(classroomId): Promise<TrainingTaskEntity[]>;
  async listTasksByCoach(coachSessionId): Promise<TrainingTaskEntity[]>;
  async appendTurn(rec): Promise<TrainingTurnEntity>;     // upsert，不提供 update
  async getTurn(classroomId, taskId, round): Promise<TrainingTurnEntity | undefined>;
  async listTurns(classroomId, taskId): Promise<TrainingTurnEntity[]>;

  // dataset + grader
  async getDataset(classroomId, id): Promise<DatasetEntity | undefined>;
  async putDataset(rec): Promise<DatasetEntity>;
  async listDatasetsByClassroom(classroomId): Promise<DatasetEntity[]>;
  async getGrader(classroomId, id): Promise<GraderEntity | undefined>;
  async putGrader(rec): Promise<GraderEntity>;
  async listGradersByClassroom(classroomId): Promise<GraderEntity[]>;

  /** 暴露底层 CrudStore（service 层事务用，如 listStudentsByClassroom + 批量 putVersion） */
  getCrud(): CrudStore;
  /** root 路径（fork/adopt/createInitial 用，避免再次展开） */
  getRoot(): string;
}

// app/server/src/academy/academy-store-ops.ts（业务原语模块函数）
/**
 * fork 版本目录（物理复制 workspace；与 source 类型无关）。
 * **base 可为 formal 或 process**（multi-turn 迭代场景下 base=temporaryBaselineVersionId 是 process）。
 * spec INV-5（原子性）+ INV-6（workspaceDir 不可变）都与 base 类型无关——fork 语义就是物理复制，
 * 不应在 API 层加 base.type 校验（曾因误加 formal-only 校验导致 multi-turn round2+ 500，已去除）。
 *
 * 过程版本号 3 段化：versionLabel = `${base.versionLabel.split('.')[0]}.${taskSeq}.${round}`
 *   （取 base 顶层 major，不拼完整 label）。修原 4 段 bug（base='0.0' → 旧拼 '0.0.1.1' 4 段；
 *   multi-turn base 是 process 版时段数爆炸）。dst 目录路径仍用 base 完整 label（路径唯一性），
 *   仅 versionLabel 字段用 3 段。adoptToFormal 已用 split('.')[0] 取 major（§6 adoptToFormal）。
 *
 * [v0.0.221] versionLabel 写侧 BUG 修复：copyVersionDir 仅复制源 workspace（含其 version.json，
 *   源的 version.json versionLabel 是旧的「0.0」或更早 base 的 label）。fork 后 MUST 调
 *   patchVersionJsonLabel(dstDir, newLabel) 把新版本 workspace 内 version.json 的 versionLabel
 *   字段同步到新 label（record.versionLabel 与 workspace version.json.versionLabel 必须一致）。
 *   patchVersionJsonLabel 只覆写 version.json 单字段（保留 model/tools 不动，禁用 writeVersionDirFiles
 *   全量重写——那会丢 skill/memory）。
 */
export async function forkVersionWorkspace(
  store: AcademyStore,
  root: string,                  // = dataDir 绝对路径（resolveDataDir 展开后）
  baseVersionId: string,         // fork 源（formal 或 process 均可，multi-turn 临时基线是 process）
  classroomId: string,
  studentId: string,
  taskSeq: number,
  round: number,
  createdFromTaskId: string,     // 写入新 process 版本，forkCandidate round 推进靠此过滤本任务历史版本
): Promise<{ versionId: string; workspaceDir: string }>;

/**
 * 采纳 = 复制任意 process 版本为新正式版（按 seq 找下一个空正式版号分配）。
 * INV：input.type 必须为 'process'（adopt 自身校验，不走 forkVersionWorkspace）。
 *
 * [v0.0.219] 新 formal record 写 `adoptedFromProcessVersionId: processVersionId` 作溯源
 *   （UI 据此显「采纳自 v{label}」，初始 0.0 无此字段）。
 *
 * [v0.0.221] 三个关键变更（采纳解耦 + BUG 修复）：
 *   1. **可重复调**（不再 require task.status='awaiting_confirm'；同一 task 一生可产多个 formal 版本）：
 *      每次调用产新 ULID（major 递增 2.0/3.0/4.0...），不删除已有 formal record。
 *   2. **versionLabel 写侧 BUG 修复**：copyVersionDir 后 MUST 调 patchVersionJsonLabel(newWorkspaceDir,
 *      newLabel) 同步新 formal workspace 内 version.json 的 versionLabel（原 BUG：恒 "0.0"）。
 *   3. **同步 student.currentFormalVersionId 指针（BUG-001 修复）**：末尾 MUST 调 store.putStudent
 *      把 student.currentFormalVersionId 更新为新 formal versionId（原 acceptTask 不同步指针致
 *      get_student/list_students 仍报旧 formal；本版 adopt 改造时一并修）。
 *
 * 不变量（INV）：adoptToFormal 不改 task 状态（旁路）；调用方（engine.adoptVersion）负责投递通知。
 */
export async function adoptToFormal(
  store: AcademyStore,
  root: string,                  // = dataDir 绝对路径（resolveDataDir 展开后）
  classroomId: string,
  processVersionId: string,
): Promise<{ newFormalVersionId: string; newLabel: string; newWorkspaceDir: string }>;

/** 建学生初始 0.0 formal 版本（建学生事务内调） */
export async function createInitialFormalVersion(
  store: AcademyStore,
  studentId: string,
  classroomId: string,
): Promise<StudentVersionEntity>;
```

> **CrudStore 不允许 record 自带 `createdAt/updatedAt/version` 信封字段**——这些由 store 注入。adoptToFormal 更新 process.status='adopted' 时必须 strip envelope 字段（解构排除），否则 putAsync 抛错。

### 6.1 目录工具函数（复用旧 academy 可复用件，调研 §5）

- `academy-version-dir.ts`：`copyVersionDir(src,dst)` / `writeVersionDirFiles(dir,{prompt,skills,version})` / `resolveVersionContent(dir)`。fork/adopt 用这套原语。
- `academy-version-skills.ts`（v0.0.221 抽离自 `academy-version-dir.ts`）：**版本 skill 读写原语**（skill = 目录 + SKILL.md + 任意附属文件，见 `../agent/skills/[P0]skill_definition.md §1/§2`）。单向依赖（`academy-version-dir.ts` → `academy-version-skills.ts`；反向不存在）；抽离是为满足 ≤300 行硬限（328→221 + 120）。
  ```
  versionSkillDir(wsDir, skillName) → <wsDir>/.rocky/skills/<name>   （skillName 非法返 null）
  listVersionSkills(wsDir)     → SkillSummary[]   （目录 + 文件树 + 每文件 hash + description）
  listVersionSkillNames(wsDir) → string[]         （轻量：只要目录名，会话启动/装配路径用，不付哈希 IO）
  ```
  - `SkillSummary = { name; description?; fileCount; files: AcademySkillFileNode[] }`；`AcademySkillFileNode = SkillFileNode & { hash? }`（hash = sha1(bytes) 前 12，仅 file 有）。hash 用途 = 两版本 diff 判定「文件是否修改」——**不用 size 判**（同长度改动会漏判）。契约见 `specs/api/overall/18-academy.md §1.8`。
  - **复用而非重造**：文件树走 `skills/tree.ts buildFileTree`；description 走 `skills/resolver.ts parseSkillDir`（只取 description，丢弃 scope/enabled/governance——版本资产不属四层 scope 语义）；单文件读/写走 `skills/file-io.ts readSkillFile/writeSkillFile`（与 `/skill/:name/file` 同一原语）。academy 侧 **MUST NOT** 自写目录遍历 / frontmatter 解析 / 二进制识别 / 越界守卫。
  - **写面最小 + 权限**：`writeSkillFile` 只覆写已存在的文本文件（不建文件/目录、不删、不写二进制）；仅 formal 版本可写，process 版本只读（409）。**MUST NOT 用 `writeVersionDirFiles` 写 skill 内容**——那是 AGENTS.md + version.json 的全量重写路径（曾被误用：skill 目录名列表当 agentsMd 提交，把 AGENTS.md 覆盖成目录名列表）。
- `academy-paths.ts`：路径生成单点（避免散拼），仅保留实际使用的函数——**`taskRoot`/`turnFilePath` 等已删除**（ CrudStore 平铺后 turn/task 走 store 接口，不拼路径）：
  ```
  classroomRoot(dataDir, cid) = ${dataDir}/academy/${cid}
  studentRoot(dataDir, cid, sid) = ${classroomRoot}/students/${sid}
  versionDir(dataDir, cid, sid, label) = ${studentRoot}/versions/${label}/ws  (formal)
                                       or ${studentRoot}/versions/.work/${base}.${taskSeq}/${round}/ws  (process)
  headWorkspaceDir(dataDir, cid) = ${classroomRoot}/head-workspace
  formalVersionWorkspaceDir(dataDir, cid, sid, label) = ${studentRoot}/versions/${label}/ws
  ```

> **coach workspaceDir = 初始 candidate ws**：`createTrainingTaskAndCoach` 建 coach session 时把 workspaceDir 设为初始 candidate（round1 fork 自 base）的 workspaceDir 绝对路径——修原「coach ws = head-workspace 空目录」的 cwd 错位，coach 默认 cwd = 候选目录。round2+ candidate 换目录时，coach 按 `academy_iteration_state` mapper 注入的新 candidate ws 绝对路径 edit（不靠相对 cwd）。

> **过程版本路径用 base 完整 label，versionLabel 字段用 3 段**：`processVersionWorkspaceDir` 拼 dst 目录用 `base.versionLabel` 全段（保路径唯一性）；新版本 record 的 `versionLabel` 字段取 3 段（`${base顶层major}.${taskSeq}.${round}`，§3/§6 forkVersionWorkspace 注）。两者分离——路径段数随 multi-turn 自然增长但保唯一，label 字段恒 3 段。
  ```

## 7. 落盘示例（ CrudStore 平铺 + workspace 工作区分层）

**CrudStore entity 平铺层**（每 entity 一级分片，按 classroomId shard）：
```
<DATA_DIR>/academy/<cid>/
├── classroom/
│   └── <cid>.json                       # 教室 record（自分片）
├── students/
│   └── <sid>.json                       # 学生 record
├── student_versions/
│   ├── <vid_0.0>.json                   # 初始版本（formal, status=active）
│   ├── <vid_1.0>.json                   # 接受后的正式版（formal）
│   └── <vid_process>.json               # 过程版（process，multi-turn 候选）
├── training_tasks/
│   └── <tid>.json
├── training_turns/
│   └── <turnId>.json                    # 由 store.appendTurn 写入（id 由引擎生成）
├── datasets/
│   └── <did>.json
└── graders/
    └── <gid>.json
```

**workspace 工作区层**（由 academy-paths + academy-version-dir 管，**非 CrudStore**）：
```
<DATA_DIR>/academy/<cid>/
├── head-workspace/                      # head teacher session workspace（自动建）
│   └── AGENTS.md
└── students/<sid>/versions/
    ├── 0.0/ws/                          # 初始版本工作区（formal）
    │   ├── version.json
    │   ├── AGENTS.md
    │   └── .rocky/{skills,memory}/
    ├── 1.0/ws/                          # 第一个接受后的正式版工作区
    └── .work/1.1/1/ws/                  # 基于 1.0 / 任务序号 1 / 第 1 轮过程版工作区
        └── version.json AGENTS.md .rocky/...
```

> CrudStore 平铺 + workspace 工作区两层并存：entity 元数据走 CrudStore（按 classroomId shard）；五元组内容文件走 workspace 目录（按 version.workspaceDir 字段定位）。两层通过 `student_version.workspaceDir` 字段关联。

## 8. 不变量（INVARIANT）

1. **classroom 与 head session 双向**：`classroom.headTeacherSessionId` ↔ session biz=academy / role=head_teacher / derivation=parent / academyContext.classroomId。建教室事务原子保证。
2. **task 与 coach session 双向**：`task.coachSessionId` ↔ session biz=academy / role=coach / academyContext.trainingTaskId（或 coachId 字段）。
3. **过程版本必有 parentFormalVersionId + taskSeq + roundNumber**；正式版这三个字段全 null。
4. **taskSeq 在 base 下唯一**：同 base 的多个 task 占用不同 taskSeq（递增分配）。
5. **fork/adopt 原子性**：fork 用 `fs.cp(recursive)` + dst 非空抛错（防覆盖）；adopt = `fs.cp` 复制为新目录（不 rename 原 process 目录，保留可回看）。
6. **version.workspaceDir 不可变**：一旦 fork/创建，workspaceDir 不重命名（避免 session record 失效）；adopt 复制后 process 版 status='adopted'，原目录保留。

## 9. 边界

| 管 | 不管 |
|---|---|
| academy 6 entity schema + store + 目录规范 | 本文 ✅ |
| 3 新 session-kind 的 kind/profile/scope | `[P0]session_kind_extension.md` |
| 训练引擎状态机（task/turn 状态流转） | `[P0]training_engine.md` |
| CrudStore file engine 实现细节 | `../persistence/` |
| SessionStore（academy session 仍走主 SessionStore） | `../agent/session/[P0]session_store.md` |
