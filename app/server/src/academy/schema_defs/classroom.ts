/**
 * classroom entity 的 SchemaDef — academy 教室主记录
 * 参考: specs/tech/academy/[P0]data_model.md §2（SchemaDef + 落盘布局）
 *       specs/tech/academy/[P0]session_kind_extension.md §1（academy kind 扩展）
 *
 * 设计（data_model.md §2 + §6.1）：
 *   - engine='file'，shardKeyField='classroomId'，dirTemplate='academy/{shardKey}'
 *   - 落盘：{root}/academy/{cid}/classroom/{cid}.json（classroomId 同时作分片键与主键，
 *     路径前段 academy/{cid} 由 dirTemplate 拼接，entity 名 'classroom' 自动追加为子目录）
 *   - classroom 与 head session 双向关联（建教室事务原子保证，INV-1）
 *   - datasetIds/graderIds/skillIds 由 head 用 manage-classroom 工具维护（json 透传 string[]）
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * classroom entity 的 SchemaDef。
 * 落盘路径：{root}/academy/{cid}/classroom/{cid}.json（按 classroomId 自分片）。
 */
export const ClassroomSchema = {
  entity: 'classroom',
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
    /**
     * 教室 id（与 id 同值，作为 shardKey 用；冗余字段是为了让 CrudStore 通过
     * shardKeyField='classroomId' 提取分片键而不需特判 id-as-shardKey）。
     */
    classroomId: { type: 'ulid', required: true },
    /** 教室名（用户可改） */
    name: { type: 'string', required: true },
    /** emoji logo（demo 体现） */
    logo: { type: 'string', required: false },
    /**
     * 建教室时自动建 head session，双向关联（INV-1）。
     * session 侧：biz='academy'/role='head_teacher'/derivation='parent'/academyClassroomId=cid。
     */
    headTeacherSessionId: { type: 'ulid', required: true },
    /** 数据集 id 列表（head 用 manage-classroom 工具维护） */
    datasetIds: { type: 'json', required: false },
    /** 评估器 id 列表（head 用 manage-classroom 工具维护） */
    graderIds: { type: 'json', required: false },
    /** 教室级 skill 挂载（可选） */
    skillIds: { type: 'json', required: false },
    /** 教室归档（lazy 默认 false，handler 不传则 store 不写 → undefined 视为 false） */
    archived: { type: 'boolean', required: false },
    /**
     * 教室级默认模型（json 透传；格式同 version.json.model 五元组之一 a）。
     * 形状：`{providerId?:string, modelId:string}`（复合 ModelSelection，对齐 squad.modelDefault）。
     * 用途：建学生播种 0.0 初始版本的 fallback 链中间档（body.model 显式 → 教室 defaultModel → app 默认）；
     *   head/coach 会话 picker 顶部「默认模型」项的数据源。
     * undefined / null = 未配，picker 不显默认项，建学生播种直 fallback app 默认。
     */
    defaultModel: { type: 'json', required: false },
  },
} as const satisfies SchemaDef;

/** classroom 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type ClassroomRecord = InferRecord<typeof ClassroomSchema>;
