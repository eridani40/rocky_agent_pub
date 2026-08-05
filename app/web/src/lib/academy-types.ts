/**
 * academy-types —— Academy 板块实体类型（教室/学生/版本/训练任务/数据集/评估器）
 * 参考: specs/api/overall/18-academy.md（端点契约，T1 已 frozen）
 *       specs/tech/academy/[P0]data_model.md（entity schema 权威源）
 * 从 academy-api 拆出（保 academy-api ≤300 行）；纯类型无运行逻辑。
 */
// ── entity 类型（对齐 data_model.md §2-§5 + T1 schema_defs） ─────────────

/** 教室级默认模型复合（对齐 squad.modelDefault：providerId optional + modelId） */
export type ClassroomDefaultModel = { providerId?: string; modelId: string };

/** 教室主记录 */
export interface ClassroomEntity {
  id: string;
  name: string;
  logo?: string;
  headTeacherSessionId: string;
  datasetIds?: string[];
  graderIds?: string[];
  skillIds?: string[];
  archived?: boolean;
  /**
   * 教室级默认模型（复合 ModelSelection）。
   * 用途：① 建学生播种 0.0 初始版本 fallback 链中间档；② head/coach 会话 picker 顶部「默认模型」项数据源。
   * undefined / 未配 → picker 不显默认项，建学生播种直 fallback app 默认。
   */
  defaultModel?: ClassroomDefaultModel;
  createdAt?: string;
  updatedAt?: string;
}

/** 学生元数据 */
export interface StudentEntity {
  id: string;
  classroomId: string;
  name: string;
  logo?: string;
  versionIds?: string[];
  currentFormalVersionId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 学生版本元数据（formal=正式版 / process=训练过程版） */
export interface StudentVersionEntity {
  id: string;
  studentId: string;
  classroomId: string;
  /** 版本号字面量：'0.0' / '1.0' / '1.2.3' */
  versionLabel: string;
  type: 'formal' | 'process';
  /** 过程版：基于的正式版 id（实为 parent baseline id，round2+ 可能是 process id——前端按 label major 匹配父 formal） */
  parentFormalVersionId?: string;
  /** 过程版专属：任务序号（同 base 下递增） */
  taskSeq?: number;
  /** 过程版专属：轮次序号 */
  roundNumber?: number;
  /** 由哪个训练任务产生（溯源） */
  createdFromTaskId?: string;
  /** formal 专属：该正式版由哪个过程版采纳而来（adopt 时落，0.0/旧 record 无） */
  adoptedFromProcessVersionId?: string;
  /** 工作区绝对路径（五元组落在此目录） */
  workspaceDir: string;
  status?: 'active' | 'adopted' | 'rejected';
  createdAt?: string;
  updatedAt?: string;
}

/** 训练任务主记录（状态机载体） */
export interface TrainingTaskEntity {
  id: string;
  classroomId: string;
  studentId: string;
  baseVersionId: string;
  /** 任务序号（在 base 下递增；过程版本号第 2 段） */
  taskSeq: number;
  coachSessionId: string;
  mode: 'simple' | 'multi';
  optimizeStyle: 'learning' | 'training';
  maxTurns?: number;
  /**
   * 任务生命周期状态（三态机）：
   *   pending → running ↔ paused(+pausedReason)
   * 原终态值（done/aborted/rejected/awaiting_confirm）收窄后由 resumeOnStartup migration
   * 映射为 paused+reason（见 specs/tech/academy/[P0]training_engine.md §6）。
   */
  status: 'pending' | 'running' | 'paused';
  /** 为何而停（status='paused' 时填；running/pending 时 undefined）。maxturns=硬上限到顶不可直接 resume。 */
  pausedReason?: 'maxturns' | 'completed' | 'stopped' | 'earlystop';
  directive?: string;
  currentTurn?: number;
  temporaryBaselineVersionId?: string;
  datasetId?: string;
  graderId?: string;
  /** 已废弃（旧 accept 链遗留，不再写；保留 optional 兼容旧 record 读侧） */
  acceptedVersionId?: string;
  earlyStopReason?: string;
  /** 任务 base 版本号字面量（反规范化，read 时 getVersion label 填；旧任务可能 undefined） */
  baseVersionLabel?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 单轮评估/决策记录 */
export interface TrainingTurnEntity {
  id: string;
  taskId: string;
  classroomId: string;
  studentId: string;
  /** 第 N 轮（1-based） */
  round: number;
  /** 本轮 candidate 过程版 id */
  candidateVersionId: string;
  status: 'running' | 'sampled' | 'graded' | 'decided' | 'rejected' | 'adopted';
  /** sample 阶段产出：[{ caseId, studentOutput }] */
  sampleResults?: Array<{ caseId: string; studentOutput: string }>;
  /** grade 阶段产出：[{ caseId, score, level, reasoning }]（reasoning 必填） */
  gradeResults?: Array<{ caseId: string; score: number; level?: string; reasoning?: string }>;
  /** 决策结果（纯函数 gate） */
  decision?: 'improve' | 'regress' | 'equal';
  /** 本轮均分（用户视角分数） */
  avgScore?: number;
  /** 反思总结 */
  reflection?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 数据集（items = 问题 case 列表） */
export interface DatasetEntity {
  id: string;
  classroomId: string;
  name: string;
  description?: string;
  items: Array<{ id: string; question: string; gradingCriteria?: string; expectedAnswer?: string }>;
  createdAt?: string;
  updatedAt?: string;
}

/** 评估器配置 */
export interface GraderEntity {
  id: string;
  classroomId: string;
  name: string;
  type: 'llm-judge' | 'em';
  promptTemplate?: string;
  providerId?: string;
  modelId?: string;
  threshold?: number;
  matchRule?: { caseInsensitive?: boolean; trim?: boolean };
  createdAt?: string;
  updatedAt?: string;
}

/** 教室详情聚合（GET /academy/classroom/:cid 实际返回） */
export interface ClassroomDetail {
  classroom: ClassroomEntity;
  students: StudentEntity[];
  tasks: TrainingTaskEntity[];
  datasets: DatasetEntity[];
  graders: GraderEntity[];
}

/** 学生详情聚合（GET .../student/:sid；tasks = 该学生训练任务，供前端自足检测 active 轮询） */
export interface StudentDetail {
  student: StudentEntity;
  versions: StudentVersionEntity[];
  tasks: TrainingTaskEntity[];
}

/** version.json（工作区内五元组快照 a/d/e） */
export interface VersionJson {
  versionLabel?: string;
  model?: { providerId?: string; modelId?: string };
  tools?: string[];
}

/**
 * 版本 skill 目录内的文件节点（扁平数组元素，18-academy §1.8）。
 * 与后端 `academy/academy-version-dir.ts AcademySkillFileNode` 逐字段镜像。
 */
export interface AcademySkillFileNode {
  /** 基名 */
  name: string;
  /** 相对 skill 目录的路径（如 SKILL.md / templates/grid.yaml），不含绝对路径 */
  path: string;
  type: 'file' | 'dir';
  /** file 字节数 */
  size?: number;
  /** file 内容哈希 = sha1 前 12 hex；dir 无。用途：两版本 diff 判定文件是否修改 */
  hash?: string;
}

/**
 * 版本 skill 摘要（GET .../version/:vid 的 content.skills 元素）。
 * skill 的载体是「目录 + SKILL.md + 任意附属文件」（skill_definition §1/§2），
 * 故本类型是目录 + 文件树，不是目录名。
 */
export interface SkillSummary {
  /** skill 目录名（= .rocky/skills/<name>/） */
  name: string;
  /** SKILL.md frontmatter description；无 SKILL.md / 无该字段 → undefined */
  description?: string;
  /** 目录内文件总数（递归，只数 file 不数 dir） */
  fileCount: number;
  /** 目录内文件树（扁平数组，path 相对 skill 目录） */
  files: AcademySkillFileNode[];
}

/** 版本 skill 单文件内容（GET .../skill/:name/file，18-academy §1.11.1；与 06-skill §7.2 同 shape） */
export interface VersionSkillFileContent {
  path: string;
  content: string;
  /** 超 256KB 截断 */
  truncated: boolean;
  /** 二进制目标：content='' + 前端显「不可预览」 */
  binary: boolean;
}

/**
 * 版本 memory 条目摘要（GET .../version/:vid 的 content.memory 元素）。
 * 后端 resolveVersionContent 读 `<wsDir>/.rocky/memory/*.md`：每文件 name（基名）+ size（字节）+ preview（前 200 字符）。
 * 缺目录返 []。与后端 `academy-version-dir.ts MemoryEntrySummary` 逐字段镜像。
 */
export interface MemoryEntrySummary {
  name: string;
  size: number;
  preview: string;
}

/** 版本内容（GET .../version/:vid；skills = 目录 + 文件树、memory = .rocky/memory/*.md 摘要） */
export interface VersionContent {
  meta: StudentVersionEntity;
  content: {
    agentsMd: string;
    skills: SkillSummary[];
    memory: MemoryEntrySummary[];
    versionJson: VersionJson | null;
  };
}

/** 训练任务详情（GET /academy/training-task/:tid） */
export interface TrainingTaskDetail {
  task: TrainingTaskEntity;
  turns: TrainingTurnEntity[];
  currentTurn?: TrainingTurnEntity;
  baselineScore?: number;
  history: Array<{ round: number; avgScore?: number; decision?: string; status: string }>;
}

/** 发起训练请求体（POST .../training-task，18 §2.1） */
export interface CreateTrainingTaskBody {
  baseVersionId: string;
  mode: 'simple' | 'multi';
  optimizeStyle: 'learning' | 'training';
  directive: string;
  datasetId?: string;
  graderId?: string;
  maxTurns?: number;
}
