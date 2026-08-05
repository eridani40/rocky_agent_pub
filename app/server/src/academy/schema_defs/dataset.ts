/**
 * dataset entity 的 SchemaDef — academy 数据集（评估用 case 集合）
 * 参考: specs/tech/academy/[P0]data_model.md §5（SchemaDef + items 结构）
 *
 * 设计（data_model.md §5 + §6.1）：
 *   - engine='file'，shardKeyField='classroomId'，dirTemplate='academy/{shardKey}'
 *   - 落盘：{root}/academy/{cid}/datasets/{datasetId}.json（classroom 隔离）
 *   - items json 透传（Array<{id,question,gradingCriteria?,expectedAnswer?}>）
 *   - 元素结构由 handler 校验（schema 层不拆元素 schema，复杂嵌套走 json 透传）
 *   - items 全量替换（不做增量 diff，handler 契约）
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * dataset entity 的 SchemaDef。
 * 落盘路径：{root}/academy/{cid}/datasets/{datasetId}.json（按 classroomId 分片）。
 */
export const DatasetSchema = {
  entity: 'datasets',
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
    /** 数据集名（教室唯一，UI 显示） */
    name: { type: 'string', required: true },
    /** 数据集描述（可选） */
    description: { type: 'string', required: false },
    /**
     * 元素 = 问题 case 列表（json 透传）。
     * 形态：Array<{ id: string, question: string, gradingCriteria?: string, expectedAnswer?: string }>
     * handler 校验元素结构；schema 层不拆元素 schema。
     */
    items: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

/** dataset 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type DatasetRecord = InferRecord<typeof DatasetSchema>;
