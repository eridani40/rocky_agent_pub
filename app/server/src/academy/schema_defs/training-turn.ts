/**
 * training_turn entity 的 SchemaDef — 训练单轮记录（评估/决策）
 * 参考: specs/tech/academy/[P0]data_model.md §4（SchemaDef + 状态闭合）
 *
 * 设计（data_model.md §4 + §6.1）：
 *   - engine='file'，shardKeyField='classroomId'，dirTemplate='academy/{shardKey}'
 *   - 落盘：{root}/academy/{cid}/training_turns/{turnId}.json（classroom 隔离）
 *   - status enum 闭合 6 值（running/sampled/graded/decided/rejected/adopted）
 *   - round 1-based（第 N 轮）
 *   - sampleResults/gradeResults json 透传（reasoning 必填由 grader 实现保证）
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * training_turn entity 的 SchemaDef。
 * 落盘路径：{root}/academy/{cid}/training_turns/{turnId}.json（按 classroomId 分片）。
 *
 * 注：data_model.md §1 表写 "tasks/<tid>/turns/<seq>.json"（嵌套在 task 目录下），
 * 但 CrudStore 仅支持一级分片；这里用平铺 academy/{cid}/training_turns/{turnId}.json
 * 简化实现。语义不变（taskId 字段做外键关联）。
 */
export const TrainingTurnSchema = {
  entity: 'training_turns',
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
    /** 外键 task（关联） */
    taskId: { type: 'ulid', required: true },
    /** 冗余 classroomId（路径便利 + 分片键） */
    classroomId: { type: 'ulid', required: true },
    /** 冗余 studentId（路径便利，查询避免 join） */
    studentId: { type: 'ulid', required: true },
    /** 第 N 轮（1-based） */
    round: { type: 'number', required: true },
    /** 本轮 candidate 版本 id（过程版本 base.taskSeq.round） */
    candidateVersionId: { type: 'ulid', required: true },
    /** 'running' / 'sampled' / 'graded' / 'decided' / 'rejected' / 'adopted' */
    status: {
      type: 'enum',
      required: true,
      enumValues: ['running', 'sampled', 'graded', 'decided', 'rejected', 'adopted'],
    },
    /** sample 阶段产出：[{ caseId, studentOutput }]（学生答题输出） */
    sampleResults: { type: 'json', required: false },
    /** grade 阶段产出：[{ caseId, score, level, reasoning }]（reasoning 必填） */
    gradeResults: { type: 'json', required: false },
    /** 决策结果：'improve' / 'regress' / 'equal'（acceptGate 纯函数判定） */
    decision: {
      type: 'enum',
      required: false,
      enumValues: ['improve', 'regress', 'equal'],
    },
    /** 本轮 avgScore（用户视角分数，用于判进化退化） */
    avgScore: { type: 'number', required: false },
    /** 反思总结（coach 生成或引擎整理） */
    reflection: { type: 'string', required: false },
  },
} as const satisfies SchemaDef;

/** training_turn 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type TrainingTurnRecord = InferRecord<typeof TrainingTurnSchema>;
