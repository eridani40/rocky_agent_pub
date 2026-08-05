/**
 * memory 存储数量硬上限（v0.0.247 — 补 v0.0.238 注入配额的存储侧缺口）
 * 参考: specs/tech/version_logs/v0.0.247/change_plan.md（memory 子系统 + 6 核心不变量）
 *       reqs/[working] v0.0.247/req.md（阈值/溢出/位置/口径/触发边界）
 *       app/plugins/builtins/rocky_context/prompt/memory.ts resolveMemoryQuotas（同 key 同兜底）
 *
 * 职责：存储侧分层配额（global50/group30/session20，值同注入配额）。
 *   - resolveMemoryStoreQuotas：从 app_config 读三层配额（与 mapper resolveMemoryQuotas 同 key 同兜底）
 *   - countActiveEntries：数 dir 中未 archived 的 active 条目（复用 listEntries，不手写 readdir）
 *   - checkMemoryStoreQuota：count >= limit → throw MemoryQuotaExceededError（携 evolvable=false 计数）
 *
 * 与 inject-quota.ts 概念解耦（不变量#6 决策：新类型不复用 MemoryInjectQuotas）：
 *   注入截断（selectMemoriesByQuota 截 prompt 条数）vs 存储硬限（本文件挡写入），
 *   语义不同，未来拆 key 互不影响。值结构相同但 type 独立。
 *
 * 原子性约束：checkMemoryStoreQuota 自身不持锁——count+check+write 必须由 caller 在 dir 级
 *   虚拟锁（path.resolve(dir,'.quota.lock')）内串行调用（writeLocked !existing 分支），防 TOCTOU race。
 */
import { listEntries, listMetas, type MemoryScope } from './memory-dir-store';
import { MemoryQuotaExceededError } from './policy';
import type { AppConfigService } from '../config/app-config-service';

/**
 * 各 scope 独立存储配额（与注入配额 MemoryInjectQuotas 概念解耦：值同结构同，未来可独立调）。
 * global=数据根共享 / group=squad 共享 / session=单会话私有，三层独立计数独立硬限。
 */
export interface MemoryStoreQuotas {
  global: number;
  group: number;
  session: number;
}

/**
 * 默认存储配额：global50 / group30 / session20。
 * MUST 与 mapper DEFAULT_MEMORY_QUOTAS（memory.ts L45）同值同源（req.md「阈值跟注入配额同值」）。
 */
export const DEFAULT_MEMORY_STORE_QUOTAS: MemoryStoreQuotas = {
  global: 50,
  group: 30,
  session: 20,
};

/**
 * 从 app_config 读 memory 分层存储配额（key 与 mapper resolveMemoryQuotas 同源同兜底）。
 *
 * key 语义（与注入侧一致）：maxMemoryInject→global / maxMemoryInjectGroup→group / maxMemoryInjectSession→session。
 * 兜底（各层独立）：appConfig=null / session record 缺失 / 字段非 finite → 该层回退默认（50/30/20）。
 *
 * @param appConfig caller 注入的 AppConfigService（handler/tool 经 ctx/config 取；UT 可传 null）
 * @returns 解析后的三层配额（永远非 null，缺省值兜底）
 */
export function resolveMemoryStoreQuotas(appConfig: AppConfigService | null): MemoryStoreQuotas {
  if (!appConfig) return { ...DEFAULT_MEMORY_STORE_QUOTAS };
  const session = appConfig.get('session', 'default');
  if (!session || typeof session !== 'object') return { ...DEFAULT_MEMORY_STORE_QUOTAS };
  const rec = session as {
    maxMemoryInject?: unknown;
    maxMemoryInjectGroup?: unknown;
    maxMemoryInjectSession?: unknown;
  };
  return {
    global:
      typeof rec.maxMemoryInject === 'number' && Number.isFinite(rec.maxMemoryInject)
        ? rec.maxMemoryInject
        : DEFAULT_MEMORY_STORE_QUOTAS.global,
    group:
      typeof rec.maxMemoryInjectGroup === 'number' && Number.isFinite(rec.maxMemoryInjectGroup)
        ? rec.maxMemoryInjectGroup
        : DEFAULT_MEMORY_STORE_QUOTAS.group,
    session:
      typeof rec.maxMemoryInjectSession === 'number' && Number.isFinite(rec.maxMemoryInjectSession)
        ? rec.maxMemoryInjectSession
        : DEFAULT_MEMORY_STORE_QUOTAS.session,
  };
}

/**
 * 数 dir 中未 archived 的 active 条目（用于存储配额计数）。
 * 复用 listEntries({includeArchived:false}) 的扫描 + 坏文件跳过逻辑（不变量#2：archived 不计入）。
 * dir 不存在 → 0（listEntries 内部已兜底）。
 */
export function countActiveEntries(dir: string): number {
  return listEntries(dir, { includeArchived: false }).length;
}

/**
 * 检查存储配额：count >= quotas[scope] → throw MemoryQuotaExceededError（携 evolvable=false 计数）；
 * 未超 → no-op（caller 继续写）。
 *
 * 原子性：本函数不持锁——caller 必须在 dir 级虚拟锁（writeLocked !existing 分支嵌套
 *   withFileLock(path.resolve(dir,'.quota.lock'))）内调用，确保 count+write 同锁内串行（防 TOCTOU race）。
 *
 * evolvable=false 计数（不变量#4：计入配额防绕过，错误文案如实告知）：
 *   - opts.evolvableFalseCount 显式传入 → 直接用（caller 锁内已 listMetas 统计，避免二次扫描）
 *   - 未传 → 本函数内 listMetas(dir) filter !archived && evolvable===false 统计
 *
 * @param dir 条目目录（caller 持 dir 锁）
 * @param scope 当前写入 scope（决定查 quotas[scope]）
 * @param quotas caller 经 resolveMemoryStoreQuotas 解析后的三层配额
 * @param opts.evolvableFalseCount 可选：dir 中 evolvable=false 的 active 条目数
 */
export function checkMemoryStoreQuota(
  dir: string,
  scope: MemoryScope,
  quotas: MemoryStoreQuotas,
  opts?: { evolvableFalseCount?: number },
): void {
  const limit = quotas[scope];
  const current = countActiveEntries(dir);
  if (current >= limit) {
    const evolvableFalseCount =
      opts && typeof opts.evolvableFalseCount === 'number'
        ? opts.evolvableFalseCount
        : listMetas(dir).filter((m) => !m.archived && m.evolvable === false).length;
    throw new MemoryQuotaExceededError(scope, current, limit, evolvableFalseCount);
  }
}
