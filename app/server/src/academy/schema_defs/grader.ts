/**
 * grader entity 的 SchemaDef — academy 评估器配置（llm-judge / em）
 * 参考: specs/tech/academy/[P0]data_model.md §5（SchemaDef + type 闭合枚举）
 *
 * 设计（data_model.md §5 + §6.1）：
 *   - engine='file'，shardKeyField='classroomId'，dirTemplate='academy/{shardKey}'
 *   - 落盘：{root}/academy/{cid}/graders/{graderId}.json（classroom 隔离）
 *   - type enum 闭合 'llm-judge' / 'em'（首版只这两种；未来按需扩 'regex'/'contains'）
 *   - llm-judge: promptTemplate（含占位符）+ providerId/modelId 可选（缺省 = 学生所用模型）+ threshold
 *   - em: matchRule（{caseInsensitive?, trim?}，json 透传）
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * grader entity 的 SchemaDef。
 * 落盘路径：{root}/academy/{cid}/graders/{graderId}.json（按 classroomId 分片）。
 */
export const GraderSchema = {
  entity: 'graders',
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
    /** 评估器名（教室唯一，UI 显示） */
    name: { type: 'string', required: true },
    /** 闭合枚举（首版只这两种；未来按需扩 'regex'/'contains' 等） */
    type: {
      type: 'enum',
      required: true,
      enumValues: ['llm-judge', 'em'],
    },
    /**
     * type='llm-judge'：prompt 模板（含 {question}/{student_output}/{criteria} 占位符）。
     * em 类型不消费此字段。
     */
    promptTemplate: { type: 'string', required: false },
    /** type='llm-judge'：可选指定模型（providerId+modelId），缺省 = 学生所用模型 */
    providerId: { type: 'string', required: false },
    /** type='llm-judge'：可选指定模型 id，缺省 = 学生所用模型 */
    modelId: { type: 'string', required: false },
    /** 分级阈值（默认 0.5；>= threshold = 正例，< = 负例） */
    threshold: { type: 'number', required: false },
    /**
     * 'em' 类型专属：精确匹配规则（json 透传）。
     * 形态：{ caseInsensitive?: boolean, trim?: boolean }
     */
    matchRule: { type: 'json', required: false },
  },
} as const satisfies SchemaDef;

/** grader 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type GraderRecord = InferRecord<typeof GraderSchema>;
