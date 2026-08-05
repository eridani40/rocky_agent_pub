/**
 * academy schema_defs barrel — academy 域 7 entity SchemaDef 集中 re-export
 * 参考: specs/tech/academy/[P0]data_model.md §1-§5（六个 entity 定义）
 *
 * v0.0.210 新增：
 *   - classroom（教室主记录）+ students（学生元数据）+ student_versions（版本树）
 *   - training_tasks（训练任务）+ training_turns（单轮记录）
 *   - datasets（数据集）+ graders（评估器）
 *
 * 所有 entity 共享 shardKeyField='classroomId' + dirTemplate='academy/{shardKey}'，
 * 落盘根 {root}/academy/{cid}/<entity>/{id}.json（classroom 隔离）。
 */
export { ClassroomSchema } from './classroom';
export type { ClassroomRecord } from './classroom';
export { StudentSchema } from './student';
export type { StudentRecord } from './student';
export { StudentVersionSchema } from './student-version';
export type { StudentVersionRecord } from './student-version';
export { TrainingTaskSchema } from './training-task';
export type { TrainingTaskRecord } from './training-task';
export { TrainingTurnSchema } from './training-turn';
export type { TrainingTurnRecord } from './training-turn';
export { DatasetSchema } from './dataset';
export type { DatasetRecord } from './dataset';
export { GraderSchema } from './grader';
export type { GraderRecord } from './grader';
