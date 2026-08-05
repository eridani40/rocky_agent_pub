/**
 * SKILL.md frontmatter 治理/来源锚点读写 helper（v0.0.167 从 installer-core 抽出以守文件体量 ≤300 行）
 * 参考: specs/tech/agent/skills/[P0]skill_definition.md §2 §6.3
 *       specs/tech/agent/skills/[P1]skill_market.md §7.1
 *
 * 两个纯 IO helper 都围绕 SKILL.md 的 gray-matter frontmatter：
 *   - applyGovernance：落盘前把治理两字段 + 市场来源三字段写入 frontmatter（下载路径）。
 *   - readInstalledMarketRef：读磁盘已装 skill 的 market_ref（覆盖守卫判同源，读磁盘不信前端）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import matter from 'gray-matter';
import type { SkillGovernanceOverride } from './installer-core';

/**
 * 改写 SKILL.md frontmatter 治理 + 市场来源字段（下载路径落盘前）；读/解析失败则静默跳过（不阻断安装）。
 * 写入键（snake_case，对齐 resolver.parseSkillDir 读侧）：
 *   `production_method` / `evolvable`（治理，v0.0.166）+ `market_ref` / `market_source` / `installed_hash`（来源锚点，v0.0.167）。
 * 各字段 undefined 则**不写**（multipart 路径不传 governance → 不触达本函数；传 governance 但某字段缺 → 不写该键，零回归）。
 */
export function applyGovernance(skillMdPath: string, gov: SkillGovernanceOverride): void {
  let raw: string;
  try {
    raw = readFileSync(skillMdPath, 'utf8');
  } catch {
    return;
  }
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return;
  }
  const data = { ...(parsed.data as Record<string, unknown>) };
  // 治理字段（parseSkillDir 读 snake_case → camelCase）
  if (gov.productionMethod !== undefined) data.production_method = gov.productionMethod;
  if (gov.evolvable !== undefined) data.evolvable = gov.evolvable;
  // v0.0.167 市场来源锚点（各 undefined 不写，multipart 零回归）
  if (gov.marketRef !== undefined) data.market_ref = gov.marketRef;
  if (gov.marketSource !== undefined) data.market_source = gov.marketSource;
  if (gov.installedHash !== undefined) data.installed_hash = gov.installedHash;
  writeFileSync(skillMdPath, matter.stringify(parsed.content, data), 'utf8');
}

/**
 * 读给定 SKILL.md 路径 frontmatter 的 `market_ref`（覆盖守卫判同源用，v0.0.167）。
 * **读磁盘不信前端**：守卫据此判断已装 skill 是否与本次安装同源。
 * 文件缺失 / 解析失败 / 字段非 string → 返回 undefined（视为本地/未知来源，一律不覆盖）。
 */
export function readInstalledMarketRef(skillMdPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(skillMdPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const ref = matter(raw).data.market_ref;
    return typeof ref === 'string' && ref ? ref : undefined;
  } catch {
    return undefined;
  }
}
