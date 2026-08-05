/**
 * student_version entity 的 SchemaDef — 学生版本（五元组之一：版本元数据）
 * 参考: specs/tech/academy/[P0]data_model.md §3（SchemaDef + workspaceDir 不变量）
 *
 * 设计（data_model.md §3 + §6.1 + §8 INV-3/INV-6）：
 *   - engine='file'，shardKeyField='classroomId'，dirTemplate='academy/{shardKey}'
 *   - 落盘：{root}/academy/{cid}/student_versions/{versionId}.json（classroom 隔离）
 *   - formal/process 二分（type 字段闭合枚举）
 *   - 过程版本 INV：parentFormalVersionId + taskSeq + roundNumber 必填
 *   - 正式版本 INV：parentFormalVersionId + taskSeq + roundNumber 全 null/undefined
 *   - workspaceDir 不可变（INV-6）：一旦 fork/创建就不重命名；adopt 复制后 process 版 status='adopted'
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 *
 * 注：entity='student_versions'（复数，目录名）以避免与单数 student 冲突。
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * student_version entity 的 SchemaDef。
 * 落盘路径：{root}/academy/{cid}/student_versions/{versionId}.json（按 classroomId 分片）。
 */
export const StudentVersionSchema = {
  entity: 'student_versions',
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
    /** 外键 student（双向关联） */
    studentId: { type: 'ulid', required: true },
    /** 冗余 classroomId（路径便利 + list 过滤，避免 join student） */
    classroomId: { type: 'ulid', required: true },
    /** 版本号字面量：'0.0' / '1.0' / '1.2.3' 等（formal 标识，UI 显示） */
    versionLabel: { type: 'string', required: true },
    /** 'formal' = 正式版（含 0.0）；'process' = 过程版（训练中临时） */
    type: {
      type: 'enum',
      required: true,
      enumValues: ['formal', 'process'],
    },
    /**
     * 正式版：null/undefined；过程版：基于的正式版 id（如 1.2.3 → 指向 1.0）。
     * INV-3：process 必填；formal 必为 null/undefined。
     */
    parentFormalVersionId: { type: 'ulid', required: false },
    /** 过程版专属：任务序号（同 base 下递增）；正式版：null */
    taskSeq: { type: 'number', required: false },
    /** 过程版专属：轮次序号；正式版：null */
    roundNumber: { type: 'number', required: false },
    /** 由哪个训练任务产生（process 必填；接受后转正的 formal 也保留作溯源） */
    createdFromTaskId: { type: 'ulid', required: false },
    /**
     * 该 formal 由哪个过程版本采纳而来（adoptToFormal 写入；仅 formal 有值）。
     * 初始 0.0 / 旧 record 无此字段（required:false）。UI 据此显「采纳自 v{label}」徽章。
     * 参考: specs/tech/academy/[P0]data_model.md §3 + §6 adoptToFormal
     */
    adoptedFromProcessVersionId: { type: 'ulid', required: false },
    /**
     * 工作区绝对路径（必填，INV-6 不可变）。
     * 五元组落在此目录（AGENTS.md → system prompt，.rocky/skills/memory）。
     * formal 版路径：academy/{cid}/students/{sid}/versions/{label}/ws/
     * process 版路径：academy/{cid}/students/{sid}/versions/.work/{base}.{taskSeq}/{round}/ws/
     */
    workspaceDir: { type: 'string', required: true },
    /**
     * 'active' = 当前用（formal 默认）
     * 'adopted' = 已被接受转正（process 专属终态，原目录保留）
     * 'rejected' = 训练拒绝（保留可回看）
     */
    status: {
      type: 'enum',
      required: false,
      enumValues: ['active', 'adopted', 'rejected'],
    },
  },
} as const satisfies SchemaDef;

/** student_version 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type StudentVersionRecord = InferRecord<typeof StudentVersionSchema>;
