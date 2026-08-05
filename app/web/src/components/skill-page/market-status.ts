/**
 * market-status — 市场卡/详情状态区状态机的单一来源（纯函数）。
 * 参考: specs/ui/components/skill-page/market-status.md；PRD §4；change_plan invariant#5/#6。
 *
 * 给定一个市场 ref + 已安装 skill 列表（+ 可选 detailHash/installing），派生状态区应渲染的态。
 * 同源判定 = ref 精确匹配 marketRef（非同名，invariant#5）；
 * 可更新惰性——无 detailHash 时绝不返回 updatable/upToDate（invariant#6，列表阶段零额外请求）。
 * 边界：纯函数，不渲染、不请求、不持状态。
 */
import type { SkillEntry } from '../../lib/api-client';

/** 市场状态区五态（列表只出前三态；updatable/upToDate 仅详情阶段传 detailHash 时算） */
export type MarketStatus =
  | 'installable' // ref 不在已安装库
  | 'installing' // 安装/更新处理中
  | 'installed' // ref === 某 installedSkill.marketRef（未比对 hash）
  | 'updatable' // 已安装 + detailHash !== installedHash
  | 'upToDate'; // 已安装 + detailHash === installedHash

/**
 * 查找与市场 ref 同源的已安装 skill（marketRef 精确匹配，不看 name）。
 * @param ref 市场 item.ref（安装唯一标识）
 * @param installedSkills 已安装列表（含 marketRef/installedHash）
 * @returns 同源已安装 skill；无则 undefined
 */
export function findInstalled(ref: string, installedSkills: SkillEntry[]): SkillEntry | undefined {
  return installedSkills.find((s) => s.marketRef !== undefined && s.marketRef === ref);
}

/**
 * 派生市场状态区应渲染的态（互斥，按优先级）。
 * 1. opts.installing → installing。
 * 2. 未找到同源已安装 → installable。
 * 3. 找到同源已安装：
 *    - 无 detailHash（列表阶段惰性）→ installed。
 *    - 有 detailHash：与 installedSkill.installedHash 比较 → 不同 updatable / 相同 upToDate；
 *      installedHash 缺失（legacy 无锚点）→ 保守返 installed（无法判断可更新，不误报）。
 * @param ref 市场 item.ref
 * @param installedSkills 已安装列表
 * @param opts.installing 该 ref 正在安装/更新处理中
 * @param opts.detailHash 详情阶段的当前内容哈希（仅详情 modal 传，触发可更新比对）
 */
export function deriveMarketStatus(
  ref: string,
  installedSkills: SkillEntry[],
  opts?: { installing?: boolean; detailHash?: string },
): MarketStatus {
  if (opts?.installing === true) return 'installing';
  const installed = findInstalled(ref, installedSkills);
  if (!installed) return 'installable';
  // 惰性：无 detailHash（列表阶段）不比对 hash
  if (opts?.detailHash === undefined) return 'installed';
  // legacy 已安装但无内容锚点 → 无法判断可更新，保守视为已安装
  if (installed.installedHash === undefined) return 'installed';
  return opts.detailHash !== installed.installedHash ? 'updatable' : 'upToDate';
}
