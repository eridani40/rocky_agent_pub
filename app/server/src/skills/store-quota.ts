/**
 * skill 存储侧分层配额（v0.0.247）—— 补 v0.0.238 注入配额的存储侧缺口
 * 参考: specs/tech/version_logs/v0.0.247/change_plan.md skill 子系统（核心不变量 1-6）
 *       app/plugins/builtins/rocky_context/prompt/skills.ts（注入侧 resolveSkillQuotas 对照）
 *       app/server/src/memory/store-quota.ts（同模式 memory 实现）
 *
 * 与注入侧概念解耦：注入配额截「注入到 system prompt 的条数」（selectSkillsByQuota）；
 * 存储配额截「磁盘存储的条数」（checkSkillStoreQuota）。阈值同源（maxSkillInject/Group/Session
 * 三 key，用户拍板跟注入同值），但概念独立、类型独立（未来拆 key 互不影响）。
 *
 * 核心不变量（贯穿全模块）：
 *   1. 只在 executeCreate 触发（executePatch / enable / disable 不触发——否则 disable 自锁）
 *   2. disabled 不计入（filter enabled===true，与 L0 catalog 同口径）
 *   3. builtin 不计（resolver 排除 builtin scope，agent/用户物理不会写 builtin 层）
 *   4. evolvable=false 计入配额（防全标 false 绕过），溢出错误文案如实带 nonEvolvableCount
 *   5. count + write 在 dir 级锁内原子（防 TOCTOU；executeCreate caller 持锁）
 */
import type { AppConfigService } from '../config/app-config-service';
import { SkillResolver, builtinSkillRoot } from './resolver';
import type { SkillEnabledStore } from './enabled-store';
import { SkillQuotaExceededError } from './policy';

/**
 * 各 scope 独立存储配额（与 skills.ts SkillInjectQuotas 同结构，**概念解耦独立类型**）。
 * 注入配额截 prompt 条数、存储配额截磁盘条数——语义不同，独立 type 防误用。
 */
export interface SkillStoreQuotas {
  /** global 层（app scope）硬限 */
  global: number;
  /** group 层（squad 共享）硬限 */
  group: number;
  /** session 层（workspace scope）硬限 */
  session: number;
}

/**
 * 默认值（与 skills.ts DEFAULT_SKILL_QUOTAS 同值同源：global 50 / group 30 / session 20）。
 * 用户拍板「阈值跟注入配额同值」（req.md §阈值）。
 */
export const DEFAULT_SKILL_STORE_QUOTAS: SkillStoreQuotas = {
  global: 50,
  group: 30,
  session: 20,
};

/**
 * 从 AppConfigService 读 skill 存储配额（app_config session group 三 key，与
 * 注入侧 resolveSkillQuotas 同 key 同兜底逻辑）。各层独立回退默认。
 *
 * key 语义（与注入侧完全一致）：
 *   - maxSkillInject       → global 层（app scope）
 *   - maxSkillInjectGroup  → group 层
 *   - maxSkillInjectSession → session 层（workspace scope）
 *
 * @param appConfig app_config 服务；null（caller 未注入）→ 全层默认 50/30/20
 */
export function resolveSkillStoreQuotas(appConfig: AppConfigService | null): SkillStoreQuotas {
  if (!appConfig) return { ...DEFAULT_SKILL_STORE_QUOTAS };
  const session = appConfig.get('session', 'default');
  if (!session || typeof session !== 'object') return { ...DEFAULT_SKILL_STORE_QUOTAS };
  const rec = session as {
    maxSkillInject?: unknown;
    maxSkillInjectGroup?: unknown;
    maxSkillInjectSession?: unknown;
  };
  return {
    global:
      typeof rec.maxSkillInject === 'number' && Number.isFinite(rec.maxSkillInject)
        ? rec.maxSkillInject
        : DEFAULT_SKILL_STORE_QUOTAS.global,
    group:
      typeof rec.maxSkillInjectGroup === 'number' && Number.isFinite(rec.maxSkillInjectGroup)
        ? rec.maxSkillInjectGroup
        : DEFAULT_SKILL_STORE_QUOTAS.group,
    session:
      typeof rec.maxSkillInjectSession === 'number' && Number.isFinite(rec.maxSkillInjectSession)
        ? rec.maxSkillInjectSession
        : DEFAULT_SKILL_STORE_QUOTAS.session,
  };
}

/** 内部 SkillScope（'app'/'workspace'/'group'）→ 对外存储配额层 key（'global'/'session'/'group'） */
function toExternalScope(scope: 'app' | 'workspace' | 'group'): 'global' | 'session' | 'group' {
  if (scope === 'workspace') return 'session';
  if (scope === 'group') return 'group';
  return 'global';
}

/**
 * 数指定 scope 的 active skill 数量 + evolvable=false 计数。
 *
 * 实现：调 SkillResolver.resolve（与 L0 catalog 同源扫描），filter scope===current && enabled===true。
 * **不手扫 dir** —— 保持与 catalog / 注入侧一致口径（disabled/builtin 同口径排除）。
 *
 * @param scope 内部 scope（'app'/'workspace'/'group'，与 executeCreate 写入层一致）
 * @param dataDir app 数据根（app 层寻址）
 * @param workspaceDir workspace 路径（session 层需要；undefined 不扫 workspace 层）
 * @param groupWsDir group ws 路径（group 层需要；undefined 不扫 group 层）
 * @param enabledStore skill_state 读取器（disabled 过滤源）
 * @returns { count, nonEvolvableCount }：active 总数 + 其中 evolvable=false 的数量
 */
export function countActiveSkillsInScope(
  scope: 'app' | 'workspace' | 'group',
  dataDir: string,
  workspaceDir: string | undefined,
  groupWsDir: string | undefined,
  enabledStore: SkillEnabledStore,
): { count: number; nonEvolvableCount: number } {
  const cat = SkillResolver.resolve(
    dataDir,
    workspaceDir,
    enabledStore,
    builtinSkillRoot(),
    groupWsDir,
  );
  let count = 0;
  let nonEvolvableCount = 0;
  for (const e of cat.entries) {
    if (e.scope !== scope) continue; // 仅本 scope（builtin/app/workspace/group 之一）
    if (!e.enabled) continue; // disabled 不计（不变量#2）
    count++;
    if (e.evolvable === false) nonEvolvableCount++; // evolvable=false 计入（不变量#4）
  }
  return { count, nonEvolvableCount };
}

/**
 * 检查 scope 存储配额：超限抛 SkillQuotaExceededError，未超 no-op。
 * 必须在 caller 持 dir 锁时调用（count 原子性靠 caller，见 executeCreate dir 锁）。
 *
 * 触发条件：pre-write count >= limit（即本次写入会让 count 超过 limit）。
 *
 * @param scope 内部 scope（'app'/'workspace'/'group'，映射对外后查 quotas）
 * @param dataDir / workspaceDir / groupWsDir / enabledStore 同 countActiveSkillsInScope
 * @param quotas 各 scope 硬限（caller 经 resolveSkillStoreQuotas 解析后传入）
 * @throws SkillQuotaExceededError 当 pre-write count >= quotas[对外 scope]
 */
export function checkSkillStoreQuota(
  scope: 'app' | 'workspace' | 'group',
  dataDir: string,
  workspaceDir: string | undefined,
  groupWsDir: string | undefined,
  enabledStore: SkillEnabledStore,
  quotas: SkillStoreQuotas,
): void {
  const { count, nonEvolvableCount } = countActiveSkillsInScope(
    scope, dataDir, workspaceDir, groupWsDir, enabledStore,
  );
  const extScope = toExternalScope(scope);
  const limit = quotas[extScope];
  if (count >= limit) {
    throw new SkillQuotaExceededError(extScope, count, limit, nonEvolvableCount);
  }
}
