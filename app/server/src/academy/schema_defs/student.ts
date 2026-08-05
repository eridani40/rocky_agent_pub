/**
 * student entity 的 SchemaDef — academy 学生元数据（版本树根）
 * 参考: specs/tech/academy/[P0]data_model.md §3（SchemaDef + 落盘布局）
 *
 * 设计（data_model.md §3 + §6.1）：
 *   - engine='file'，shardKeyField='classroomId'，dirTemplate='academy/{shardKey}'
 *   - 落盘：{root}/academy/{cid}/students/{studentId}.json（classroom 隔离）
 *   - 与 classroom 双向关联（外键 classroomId）+ 版本树根（versionIds 反索引）
 *   - currentFormalVersionId 建学生时自动建 0.0 并填此字段（INV：必有初始正式版）
 *   - workspaceDir 不在 student entity 上——版本才有（version 是工作区真相源）
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * student entity 的 SchemaDef。
 * 落盘路径：{root}/academy/{cid}/students/{studentId}.json（按 classroomId 分片）。
 */
export const StudentSchema = {
  entity: 'students',
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
    /** 外键 classroom（双向关联） */
    classroomId: { type: 'ulid', required: true },
    /** 学生名（教室唯一，UI 显示） */
    name: { type: 'string', required: true },
    /** 学生 logo（emoji 可选） */
    logo: { type: 'string', required: false },
    /** 所有版本 id（UI 树形展示用；append-only，每次建版本 push） */
    versionIds: { type: 'json', required: false },
    /**
     * 最新正式版 id（建学生时自动建 0.0 并填此字段；adopt 后更新指向新 formal 版本）。
     * INV：必有初始 0.0 正式版，故此字段一旦建学生即非空。
     */
    currentFormalVersionId: { type: 'ulid', required: false },
  },
} as const satisfies SchemaDef;

/** student 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type StudentRecord = InferRecord<typeof StudentSchema>;
