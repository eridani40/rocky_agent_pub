/**
 * bash 策略检测层（纯函数，便于 UT）
 * 参考: specs/tech/agent/tools/[P0]bash_tools.md §5
 *       specs/tech/version_logs/v0.0.122/change_plan.md 模块 G
 *
 * 实现一条内置策略：
 *   - rm-wildcard（D1）：rm 命令且参数含字面 * → ask（需用户批准）
 *
 * deny 优先于 ask：先扫全部 policy，任一 deny 即返；无 deny 有 ask 返首个 ask；都不命中返 allow。
 *
 * 注意：策略为参数级 best-effort，不做完整 shell AST。
 * 间接拼接（如 d=$HOME/.s; ls 变量拼接形式）不命中参数层策略，交执行层 seatbelt OS 级拦截（纵深防御）。
 */
import type { PermissionDecision } from './types';

// ============================================================
// 1. BashPermissionPolicy 类型
// ============================================================

/**
 * 单条 bash 权限策略（内部类型，可扩展列表）。
 * check 返 null 表示本条未命中，继续下一条。
 */
interface BashPermissionPolicy {
  /** 策略 id（日志/审计用） */
  id: string;
  /** 判定函数：命中返 PermissionDecision，未命中返 null */
  check(command: string): PermissionDecision | null;
}

// ============================================================
// 2. 单条策略检测函数（导出供 UT）
// ============================================================

/**
 * 检测命令是否包含 rm 通配删除（参数级 best-effort，D1）。
 *
 * 检测逻辑：
 *   1. 按 ; && || | 拆段（token 化）
 *   2. 逐段取 token，命令名 = rm 且任一参数含字面 * → ask
 *
 * 命中 → ask reason=「rm 通配删除，需用户批准」approvalKey=bash:rm-wildcard
 * 未命中 → null
 *
 * 示例：
 *   - `rm -rf *` → 命中（rm + 参数含 *）
 *   - `ls && rm x*` → 命中（第二段 rm + 参数含 *）
 *   - `rm file.txt` → 未命中（无含 * 的参数）
 *   - `echo '*'` → 未命中（命令名 echo，不是 rm）
 */
export function detectRmWildcard(command: string): PermissionDecision | null {
  // 按 ; && || | 拆段（保留 && || 顺序，正则分割）
  const segments = command.split(/;|&&|\|\||\|/);

  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // 命令名取第一个非空 token（支持 shell 保留字前缀如 env，但 best-effort 取 tokens[0]）
    const cmdName = tokens[0];
    if (cmdName !== 'rm') continue;

    // 参数（tokens[1..] ）中任一含字面 *
    const args = tokens.slice(1);
    if (args.some((a) => a.includes('*'))) {
      return {
        behavior: 'ask',
        reason: 'rm 通配删除，需用户批准',
        approvalKey: 'bash:rm-wildcard',
      };
    }
  }

  return null;
}

// ============================================================
// 3. 策略列表（顺序即优先级，deny 优先于 ask）
// ============================================================

/** 内置策略列表（按 deny-first 排列，便于 checkBashPermission 扫描） */
const POLICIES: BashPermissionPolicy[] = [
  {
    id: 'rm-wildcard',
    check: detectRmWildcard,
  },
];

// ============================================================
// 4. checkBashPermission — 主入口（deny 优先）
// ============================================================

/**
 * bash 权限检查（纯函数，无副作用，INV-P3）。
 *
 * 扫描顺序：
 *   1. 先收集所有 deny 决策，任一命中即立即返 deny（deny 优先于 ask）
 *   2. 无 deny 则收集 ask 决策，返首个 ask
 *   3. 都不命中返 allow
 *
 * 此函数只产 PermissionDecision（纯判定）——ask 时的 ApprovalManager 查询 + 悬挂由引擎驱动。
 *
 * @param command shell 命令字符串（来自 BashInput.command）
 * @returns PermissionDecision（allow | deny | ask）
 */
export function checkBashPermission(command: string): PermissionDecision {
  let firstAsk: PermissionDecision | null = null;

  for (const policy of POLICIES) {
    const decision = policy.check(command);
    if (decision === null) continue;

    if (decision.behavior === 'deny') {
      // deny 优先：任一命中即返
      return decision;
    }
    if (decision.behavior === 'ask' && firstAsk === null) {
      // 记录首个 ask，继续扫（可能后面有 deny）
      firstAsk = decision;
    }
  }

  // 无 deny：有 ask 返首个 ask，否则 allow
  return firstAsk ?? { behavior: 'allow' };
}
