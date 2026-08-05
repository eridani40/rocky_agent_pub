/**
 * memory 注入配额选择纯函数（分层配额：各 scope 独立计数独立截断）
 * 参考: specs/tech/agent/memory/[P0]memory_injection.md §2/§3
 *       specs/tech/version_logs/v0.0.238/change_plan.md 模块 E（分层配额 20/30/50）+ 架构决策 O3
 *       specs/prd/overall/14-prompt-quality-governance.md §14.2.3（各 scope 独立计数独立截断）
 *
 * 职责：memory 三 mapper（memory_user / memory_session / memory_group）协同的配额选择。
 * 三 mapper 各自读三源（global 源 + session 源 + group 源）后调本函数 → 同输入同输出无分歧；
 * 各自只输出本 scope 切片为自己的 fragment（tier/priority 不变）。
 *
 * 分层配额（覆盖旧「三源共享统一 maxN」）：
 *   各 scope 独立计数、独立截断（session ≤20 / group ≤30 / global ≤50，app_config 可覆盖）。
 *   层内排序 = 旧 6 类顺序的层内投影：manual（source='user'）→ agent（source='agent'），
 *   各组组内 updatedAt 倒序（ISO 字典序=时间序，'' 排末）+ tiebreak name 升序。
 *
 * 纯函数无副作用，单独 UT 覆盖。
 */

/** 注入配额所需的 entry 行（metadata 级，无 body；格式化 L0 只需 name+intro） */
export interface MemoryEntryRow {
  name: string;
  intro: string;
  /** 来源标记：'user'=UI 写（手动） / 'agent'=agent 写（自动） */
  source: 'user' | 'agent';
  /** 最后更新时间 ISO；存量缺省 ''（排末） */
  updatedAt: string;
}

/** 各 scope 独立注入配额（缺失由 caller 兜底 20/30/50） */
export interface MemoryInjectQuotas {
  global: number;
  group: number;
  session: number;
}

/**
 * 组内排序：updatedAt 倒序（ISO 字典序=时间序；'' 排末）+ tiebreak name 升序保确定。
 * 与 skill 侧 selectSkillsByQuota 同构（见 app/.../prompt/skills.ts）。
 */
function sortByUpdatedAtDescNameAsc(a: MemoryEntryRow, b: MemoryEntryRow): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
  return a.name.localeCompare(b.name);
}

/**
 * 单 scope 层内选择：manual（source='user'）组 → agent 组拼接（组内各自排序），slice(0, quota)。
 * quota<=0 → 空（该层不注入）；quota>条目数 → 全要。
 */
function selectScopeLayer(
  entries: readonly MemoryEntryRow[],
  quota: number,
): MemoryEntryRow[] {
  if (quota <= 0) return [];
  const manual: MemoryEntryRow[] = [];
  const agent: MemoryEntryRow[] = [];
  for (const r of entries) {
    (r.source === 'user' ? manual : agent).push(r);
  }
  const ordered = [
    ...manual.sort(sortByUpdatedAtDescNameAsc),
    ...agent.sort(sortByUpdatedAtDescNameAsc),
  ];
  // slice 不 mutate 原数组；返回新对象防 caller 改到输入行
  return ordered.slice(0, quota).map((r) => ({
    name: r.name,
    intro: r.intro,
    source: r.source,
    updatedAt: r.updatedAt,
  }));
}

/**
 * 注入配额选择纯函数（3 源 / 各 scope 独立配额）。
 *
 * 三 mapper 共享：各自读三源（global + session + group）后调本函数得同一划分
 * `{ global, session, group }`，各自只取本 scope 的切片输出为 fragment。同输入同输出无分歧。
 *
 * @param globalEntries global 源 entries（listMetas(globalMemoryDir) 取 name/intro/source/updatedAt）
 * @param sessionEntries session 源 entries（listMetas(wsMemoryDir) 取，已过滤 archived）
 * @param groupEntries group 源 entries（listMetas(wsMemoryDir) 取，已过滤 archived；无 group 传 []）
 * @param quotas 各 scope 独立配额（caller 经 app_config 解析，缺失兜底 20/30/50）
 * @returns 按 scope 拆分的切片；某 scope 配额<=0 → 该切片为空
 */
export function selectMemoriesByQuota(
  globalEntries: readonly MemoryEntryRow[],
  sessionEntries: readonly MemoryEntryRow[],
  groupEntries: readonly MemoryEntryRow[],
  quotas: MemoryInjectQuotas,
): { global: MemoryEntryRow[]; session: MemoryEntryRow[]; group: MemoryEntryRow[] } {
  return {
    global: selectScopeLayer(globalEntries, quotas.global),
    session: selectScopeLayer(sessionEntries, quotas.session),
    group: selectScopeLayer(groupEntries, quotas.group),
  };
}
