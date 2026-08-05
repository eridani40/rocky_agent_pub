/**
 * memory-manage-scope — memory_manage / memory 两工具共享的 scope 解析助手（介质目录定位 + 统一错误）
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4（统一 scope + dir store）
 *       app/server/src/tools/memory-manage.ts（工具定义 + run 主流程）
 *
 * scope 全链统一（v0.0.205）：global/session/group 直通 dir store（删 internal/external 映射层）：
 *   - global  → <dataDir>/memory/（write 默认 scope，不动）
 *   - session → <ctx.config.workdir>/.rocky/memory/
 *   - group   → <resolveGroupWsDir(squadId)>/.rocky/memory/
 */
import type { ToolCtx, ToolRunResult } from './types';
import { errorResult, ToolErrorCode } from './types';
import { resolveDataDir } from '../config';
import { resolveGroupWsDir } from '../agent/group-dir';
import {
  globalMemoryDir,
  listMetas,
  wsMemoryDir,
  type MemoryScope,
  type MemoryType,
} from '../memory/memory-dir-store';

/**
 * write/archive 的 scope 解析（v0.0.238 改：去缺省 global——必填由 run() 边界单点 + 按 biz 校验）。
 * 纯解析：raw 是合法三值直通；缺失/空/非法 → null（caller 区分「缺失」走 scopeRequiredErrorText，
 * 「非法值」走 invalid_input；「合法但 biz 不可用」走 scopeUnavailableErrorText）。
 * read 侧宽容兜底：调用方自行 `?? 'global'`（读侧不收窄，见 memory-manage.ts read 分支）。
 */
export function parseScope(raw: unknown): MemoryScope | null {
  if (raw !== 'global' && raw !== 'session' && raw !== 'group') return null;
  return raw;
}

/** list 的 scope（global/session/group/all，必填）→ 直通值；非法 → null */
export function parseListScope(raw: unknown): MemoryScope | 'all' | null {
  if (raw === 'all') return 'all';
  return parseScope(raw);
}

/** 从 ctx.config.workdir 取调用方 session 的 ws 根；缺失 → '' */
export function resolveSessionWsDir(ctx: ToolCtx): string {
  return String((ctx.config as { workdir?: unknown }).workdir ?? '').trim();
}

/** 取 app 数据根：优先 ctx.config.dataDir（SessionConfig 注入），回退 env 解析（resolveDataDir 单一权威） */
export function resolveToolDataDir(ctx: ToolCtx): string {
  const d = String((ctx.config as { dataDir?: unknown }).dataDir ?? '').trim();
  return d || resolveDataDir();
}

/**
 * 从 ctx.config 解析 group ws 根（squadId）。
 * @returns group ws 根；缺失 → undefined（caller 转 not_in_group / 软跳过）
 */
export function resolveSelfGroupWsDir(ctx: ToolCtx, dataDir: string): string | undefined {
  const squadId = String((ctx.config as { squadId?: unknown }).squadId ?? '').trim();
  return resolveGroupWsDir(dataDir, {
    ...(squadId ? { squadId } : {}),
  });
}

/** session scope 缺 workdir 的统一 RUNTIME 错误 */
export function sessionWsMissing(): ToolRunResult {
  return errorResult(
    `[${ToolErrorCode.RUNTIME_ERROR}] session memory requires ctx.config.workdir (caller session workspace not injected)`,
  );
}

/**
 * group scope 缺依赖的统一错误（语义错：调用方不在任何 squad → invalid_input）。
 * write/archive/read/显式 list 'group' 共享此文案，LLM 匹配 not_in_group 锚点自修正。
 */
export function notInGroupError(): ToolRunResult {
  return errorResult(`[${ToolErrorCode.INVALID_INPUT}] not_in_group`);
}

/** 统一 list meta 形态（scope 直通回显，含 evolvable；三介质复用） */
export function toListMeta(
  m: { name: string; intro: string; type: MemoryType; archived: boolean; evolvable: boolean },
  scope: MemoryScope,
) {
  return { name: m.name, intro: m.intro, type: m.type, scope, archived: m.archived, evolvable: m.evolvable };
}

/** 按 scope 取介质目录（缺依赖 → undefined，caller 决定报错/软跳过） */
export function resolveScopeDir(scope: MemoryScope, ctx: ToolCtx, dataDir: string): string | undefined {
  if (scope === 'global') return globalMemoryDir(dataDir);
  if (scope === 'session') {
    const ws = resolveSessionWsDir(ctx);
    return ws ? wsMemoryDir(ws) : undefined;
  }
  const gws = resolveSelfGroupWsDir(ctx, dataDir);
  return gws ? wsMemoryDir(gws) : undefined;
}

/**
 * 探测目标 scope 既有同名条目的 type（gate-before-type：省 type 时继承之，使进化性写抵达 service evolvable gate；BUG-001）。
 * best-effort：缺 name/依赖或无既有 → undefined（缺依赖由后续写路径统一报错，不在此抢先拦）。
 */
export function probeExistingType(scope: MemoryScope, name: string, ctx: ToolCtx, dataDir: string): MemoryType | undefined {
  if (!name) return undefined;
  const dir = resolveScopeDir(scope, ctx, dataDir);
  if (!dir) return undefined;
  return listMetas(dir).find((x) => x.name === name)?.type;
}
