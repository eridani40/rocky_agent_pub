/**
 * training_task entity 的 SchemaDef — 训练任务（状态机载体）
 * 参考: specs/tech/academy/[P0]data_model.md §4（SchemaDef + 状态机闭合）
 *
 * 设计（data_model.md §4 + §6.1 + §8 INV-4）：
 *   - engine='file'，shardKeyField='classroomId'，dirTemplate='academy/{shardKey}'
 *   - 落盘：{root}/academy/{cid}/training_tasks/{taskId}.json（classroom 隔离）
 *   - task 与 coach session 双向关联（INV-2）
 *   - status enum 三态（pending/running/paused+pausedReason）；maxTurns 硬上限到顶须 update_task 调大续训
 *   - taskSeq 在 base 下唯一（INV-4，同 base 多任务递增分配）
 *   - multi 模式必填 datasetId + graderId（由 handler/service 校验，schema 层 required=false）
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * training_task entity 的 SchemaDef。
 * 落盘路径：{root}/academy/{cid}/training_tasks/{taskId}.json（按 classroomId 分片）。
 */
export const TrainingTaskSchema = {
  entity: 'training_tasks',
  engine: 'file',
  fs: {
    sharding: {
      shardKeyField: 'classroomId',
      dirTemplate: 'academy/{shardKey}',
    },
    format: 'json',
  },
  fields: {
    /** ULID 主键（业务生成） */
    id: { type: 'ulid', required: true },
    /** 外键 classroom（分片键 + 关联） */
    classroomId: { type: 'ulid', required: true },
    /** 外键 student（任务针对的学生） */
    studentId: { type: 'ulid', required: true },
    /** 训练 base：必须是 formal 版本（如 1.0；不接受以 process 版为 base） */
    baseVersionId: { type: 'ulid', required: true },
    /** 任务序号（在 base 下递增；过程版本号第 2 段；INV-4 同 base 唯一） */
    taskSeq: { type: 'number', required: true },
    /** 绑定的 coach session（建任务时自动建，INV-2 双向关联） */
    coachSessionId: { type: 'ulid', required: true },
    /** 'simple' = 单轮无评估；'multi' = 多轮带评估 */
    mode: {
      type: 'enum',
      required: true,
      enumValues: ['simple', 'multi'],
    },
    /** 'learning' = 学习式（web_search 收集）；'training' = 训练式（数据集迭代） */
    optimizeStyle: {
      type: 'enum',
      required: true,
      enumValues: ['learning', 'training'],
    },
    /** simple=1；multi 默认 5（demo）；可用户调 */
    maxTurns: { type: 'number', required: false },
    /**
     * 任务状态机三态（v0.0.221 收窄 6→3）：
     * pending → running ↔ paused(+pausedReason)
     *
     * 设计（design.md §5）：done/aborted/rejected/awaiting_confirm 合并为 paused，
     * 区分为何而停走 pausedReason；maxturns 是硬上限不可越过（到顶须 update_task 调大再 resume）。
     * 旧值由 resumeOnStartup migration 重写（见 lifecycle.ts）。
     */
    status: {
      type: 'enum',
      required: true,
      enumValues: ['pending', 'running', 'paused'],
    },
    /**
     * 为何而停（status='paused' 时填；running/pending 时 undefined）。
     * - maxturns：maxTurns 到顶（硬终态，须 update_task 调大才能 resume）
     * - completed：训练目标达成（原 done 语义合并）
     * - stopped：人为停止（原 aborted 语义合并）
     * - earlystop：连续 3 轮无提升
     */
    pausedReason: {
      type: 'enum',
      required: false,
      enumValues: ['maxturns', 'completed', 'stopped', 'earlystop'],
    },
    /** 训练目标（训练内要求透传，head 发起时填） */
    directive: { type: 'string', required: false },
    /** 当前轮次（0=尚未开始；1+=进行中） */
    currentTurn: { type: 'number', required: false },
    /** 临时基线版本 id（multi 模式：当前最优过程版；初始 = baseVersionId） */
    temporaryBaselineVersionId: { type: 'ulid', required: false },
    /**
     * 当前 coach 在编辑的候选过程版本 id。
     * candidate = coach 正在编辑的待评版本；baseline（temporaryBaseline）= 当前最优已采纳版本。
     * revise improve 时 candidate 晋升为 temporaryBaseline，并 fork 新 candidate 落到此字段。
     * 初始 candidate 由 createTrainingTaskAndCoach 在建任务时 fork 自 baseVersionId（round1 副本）。
     */
    candidateVersionId: { type: 'ulid', required: false },
    /** 评估配置（multi 模式必填）：datasetId */
    datasetId: { type: 'ulid', required: false },
    /** 评估配置（multi 模式必填）：graderId */
    graderId: { type: 'ulid', required: false },
    /** 最终接受时落（接受 = 复制临时基线为新正式版；指向新正式版 id） */
    acceptedVersionId: { type: 'ulid', required: false },
    /** 早停原因（连续 3 轮无提升） */
    earlyStopReason: { type: 'string', required: false },
  },
} as const satisfies SchemaDef;

/** training_task 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type TrainingTaskRecord = InferRecord<typeof TrainingTaskSchema>;
