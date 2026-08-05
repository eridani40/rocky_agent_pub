/**
 * group-dir — group ws 根唯一解析点（squad 共享 workspace 根）
 * 参考: states/v0.0.205.t2_cons/context.md（存储模型定稿：scope group = squad）
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A2
 *
 * 职责：
 *   - squadId → `<dataDir>/squads/<squadId>/`
 *   - `resolveGroupWsDir` 唯一解析点（memory 工具 / query / session-config / plugin mapper 四处共享）
 *
 * 组内资源（memory/skills/state）统一落 `<groupWsDir>/.rocky/` 下（见 memory-dir-store wsMemoryDir
 * 与 skills/resolver groupSkillRoot）。
 */
import { join } from 'node:path';

/**
 * 校验 per-id 标识（防路径逃逸）。
 */
export function assertPerIdName(id: unknown, kind: string): string {
  const s = String(id ?? '').trim();
  if (!s) throw new Error(`${kind} is required`);
  if (/[\/\\]/.test(s)) throw new Error(`${kind} contains path separator: ${JSON.stringify(s)}`);
  if (s === '.' || s === '..') throw new Error(`${kind} must not be path alias: ${JSON.stringify(s)}`);
  return s;
}

/** squad group ws 根：`<dataDir>/squads/<squadId>/` */
export function squadWsDir(dataDir: string, squadId: string): string {
  return join(dataDir, 'squads', assertPerIdName(squadId, 'squadId'));
}

/** group 引用 */
export interface GroupRef {
  squadId?: string;
}

/**
 * 解析 group ws 根：squadId 命中 → squad ws 根；无 → 返 `undefined`。
 * 空串/空白 id 视为缺失（软解析，不抛错——caller 决定 not_in_group 语义）。
 */
export function resolveGroupWsDir(dataDir: string, ref: GroupRef): string | undefined {
  const sqid = String(ref.squadId ?? '').trim();
  if (sqid) return squadWsDir(dataDir, sqid);
  return undefined;
}
