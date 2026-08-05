/**
 * skill policy —— skill 写入的存储侧配额策略（v0.0.247）
 * 参考: specs/tech/version_logs/v0.0.247/change_plan.md skill 子系统（核心不变量 1-6）
 *       specs/prd/overall/14-prompt-quality-governance.md §14.2.3（注入配额同值同源）
 *       app/server/src/memory/policy.ts MemoryCharLimitError（同模式对照）
 *
 * 单点原则：存储配额拦截在 executeCreate 的 dir 锁内单点强制（count+write 原子），
 * agent 工具路径同款强制（skill 走工具路径，无 UI HTTP 直写）。超限硬拒绝 + 文案引导
 * agent 先 disable 旧 skill 腾位（守「永不自动删」铁律，逼 agent 主动收敛）。
 *
 * 与注入侧（resolveSkillQuotas）解耦：注入截「prompt 注入条数」，存储截「磁盘存储条数」；
 * 阈值同源（maxSkillInject/Group/Session 三 key），但概念独立、未来可拆 key 互不影响。
 */

/**
 * skill 存储配额溢出时抛出（executeCreate dir 锁内 count+check 原子执行）。
 *
 * 携四字段供上层 catch 映射 [INVALID_INPUT] 错误文案：
 *   - scope：对外词汇（'global'/'session'/'group'），与 agent 工具入参一致
 *   - current / limit：当前 active 量 / 硬限值（错误文案核心信息）
 *   - nonEvolvableCount：当前 active 中 evolvable=false 的数量（无法靠 disable 腾位，
 *     需 patch 改或重新评估；守 v0.0.151「如实反映、不视为 bug」原则）
 *
 * message 形态：`skill <scope> quota exceeded (<current>/<limit>); disable an old skill to free space`
 * （nonEvolvableCount > 0 时附「其中 X 条 evolvable=false 无法 disable」提示，便于 agent 决策）。
 */
export class SkillQuotaExceededError extends Error {
  /** 超限的对外 scope（'global'/'session'/'group'） */
  readonly scope: 'global' | 'session' | 'group';
  /** 当前该 scope 的 active skill 数量（disabled/builtin 不计） */
  readonly current: number;
  /** 该 scope 的硬限值 */
  readonly limit: number;
  /** 当前 active skill 中 evolvable=false 的数量（无法靠 disable 腾位） */
  readonly nonEvolvableCount: number;

  constructor(
    scope: 'global' | 'session' | 'group',
    current: number,
    limit: number,
    nonEvolvableCount: number = 0,
  ) {
    const base = `skill ${scope} quota exceeded (${current}/${limit}); disable an old skill to free space`;
    const tip = nonEvolvableCount > 0
      ? ` (note: ${nonEvolvableCount} non-evolvable skill(s) cannot be disabled — patch or re-evaluate them)`
      : '';
    super(base + tip);
    this.name = 'SkillQuotaExceededError';
    this.scope = scope;
    this.current = current;
    this.limit = limit;
    this.nonEvolvableCount = nonEvolvableCount;
  }
}
