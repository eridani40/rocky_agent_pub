/**
 * squad schema_defs barrel — squad 层 entity SchemaDef 集中 re-export
 * 参考: specs/tech/squad/[P1]data_model.md §1（entity 定义）
 *
 * squad（不分片）+ member（按 squadId 分片）。
 */
export { SquadSchema } from './squad';
export type { SquadRecord } from './squad';
export { MemberSchema } from './member';
export type { MemberRecord } from './member';
