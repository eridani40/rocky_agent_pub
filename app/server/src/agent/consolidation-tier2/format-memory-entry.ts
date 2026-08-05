/**
 * formatMemoryEntry — memory entry 的 Phase 1 Orient 展示行序列化（tier2 spec §6）
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §6
 *
 * `UserMemoryEntry`（全局块）与 `MemoryEntry`（session 块）结构不同但展示所需字段一致
 * （name/archived/evolvable/updatedAt/intro），共用最小结构化类型，避免 global-memory.ts /
 * session-memory.ts 各自维护一份等价实现（reuse，防未来只改一处漏改另一处）。
 */
export interface FormattableMemoryEntry {
  name: string;
  archived: boolean;
  evolvable: boolean;
  updatedAt: string;
  intro: string;
}

/** 序列化单条 agent-sourced memory entry（全局 memory / session memory 两块共用） */
export function formatMemoryEntry(e: FormattableMemoryEntry): string {
  return `- ${e.name} | archived=${e.archived} | evolvable=${e.evolvable} | updated=${e.updatedAt || 'unknown'}\n  ${e.intro}`;
}
