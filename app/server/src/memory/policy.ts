/**
 * memory policy —— 记忆写入的单点策略：正文字符硬限 + evolvable gate 错误 + 写入 opts
 * 参考: specs/tech/agent/memory/[P0]memory_definition.md §5/§5.1（长度硬限 + evolvable 治理）
 *       specs/tech/agent/memory/[P0]memory_manage_tool.md §5/§5.1（gate 语义 + 错误文案）
 *       specs/tech/version_logs/v0.0.238/change_plan.md 模块 F（字符口径退役旧 300 词口径）
 *       specs/tech/version_logs/v0.0.247/change_plan.md（存储数量硬上限 MemoryQuotaExceededError）
 *
 * 单点原则（memory_definition §5）：长度硬限在 service write 层单点强制（writeLocked），
 * agent 工具 + UI HTTP 两路径同款。intro ≤50 字符 / body ≤500 字符（中英文统一按字符数计，
 * trim 后 str.length）。字符校验在 per-entry file-lock 内原子执行（防 TOCTOU）。
 *
 * v0.0.247 补存储数量硬限（补 v0.0.238 注入配额存储侧缺口）：仅在 create 路径触发（writeLocked
 * 锁内 !existing 分支），超 group30/global50/session20 硬拒绝（错误引导 archive 腾位）。
 * count+check+write 在 dir 级虚拟锁内原子（防并发 TOCTOU）。
 */
import type { AppConfigService } from '../config/app-config-service';

/** intro 硬限（字符数，trim 后 str.length；PRD §14.2.4） */
export const INTRO_CHAR_LIMIT = 50;
/** body 硬限（字符数，trim 后 str.length；PRD §14.2.4） */
export const BODY_CHAR_LIMIT = 500;

/**
 * intro / body 超字符硬限时抛出（service write 层）。
 * 携 field（'intro' | 'body'）/ current / limit 供上层 boundary 映射错误文案。
 * message 形态 `memory <field> exceeds <limit> chars (current: <n>)`（PRD §14.2.4 / UC-11）。
 */
export class MemoryCharLimitError extends Error {
  /** 超限字段（'intro' | 'body'） */
  readonly field: 'intro' | 'body';
  /** 本次字段实际字符数（trim 后） */
  readonly current: number;
  /** 硬限值（INTRO_CHAR_LIMIT / BODY_CHAR_LIMIT） */
  readonly limit: number;
  constructor(field: 'intro' | 'body', current: number, limit: number) {
    super(`memory ${field} exceeds ${limit} chars (current: ${current})`);
    this.name = 'MemoryCharLimitError';
    this.field = field;
    this.current = current;
    this.limit = limit;
  }
}

/**
 * 进化性写命中 evolvable=false 既有条目时抛出（agent 路径 enforceEvolvable=true）。
 * 携条目 name 供 boundary 映射 `[invalid_input] memory "<name>" is non-evolvable`（memory_manage_tool §5.1）。
 */
export class MemoryNonEvolvableError extends Error {
  /** 被拒绝的条目 name */
  readonly entryName: string;
  constructor(name: string) {
    super(`memory "${name}" is non-evolvable`);
    this.name = 'MemoryNonEvolvableError';
    this.entryName = name;
  }
}

/**
 * memory 存储数量硬上限溢出时抛出（service write 层 create 路径，v0.0.247）。
 *
 * 触发条件：writeLocked 锁内 `!existing` 分支调 checkMemoryStoreQuota，count >= quotas[scope] 时抛。
 * 携 scope / current / limit / nonEvolvableCount 四字段供上层映射（HTTP 400 / 工具 invalid_input）：
 *   - scope：'global' | 'session' | 'group'（与配额三层一致）
 *   - current：当前 active 条目数（不含 archived）
 *   - limit：当前 scope 配额上限
 *   - nonEvolvableCount：当前 dir 中 evolvable=false 的 active 条目数（这些无法被 agent archive 腾位，
 *     需手动处理；=0 时不附 suffix）
 *
 * message 形态：`memory <scope> quota exceeded (<current>/<limit>); archive N 旧条目腾位后再写`；
 *   nonEvolvableCount>0 时附 `（其中 X 条 evolvable=false 无法 archive，需手动处理）`。
 *   N = current - limit + 1（写入 1 条新所需腾出的最小位数，>=1）。
 */
export class MemoryQuotaExceededError extends Error {
  /** 触发的 scope（配额三层之一） */
  readonly scope: 'global' | 'session' | 'group';
  /** 当前 active 条目数（不含 archived） */
  readonly current: number;
  /** 当前 scope 配额上限 */
  readonly limit: number;
  /** dir 中 evolvable=false 的 active 条目数（这些无法被 agent archive 腾位） */
  readonly nonEvolvableCount: number;
  constructor(
    scope: 'global' | 'session' | 'group',
    current: number,
    limit: number,
    nonEvolvableCount = 0,
  ) {
    const needArchive = Math.max(1, current - limit + 1);
    const base = `memory ${scope} quota exceeded (${current}/${limit}); archive ${needArchive} 旧条目腾位后再写`;
    const suffix =
      nonEvolvableCount > 0
        ? `（其中 ${nonEvolvableCount} 条 evolvable=false 无法 archive，需手动处理）`
        : '';
    super(base + suffix);
    this.name = 'MemoryQuotaExceededError';
    this.scope = scope;
    this.current = current;
    this.limit = limit;
    this.nonEvolvableCount = nonEvolvableCount;
  }
}

/**
 * write/archive 共用的写入策略入参（三语义正交，memory_definition §5.1）：
 * - enforceEvolvable：进化性写 gate。true 时更新既有 evolvable=false 条目 / archive → throw
 *   MemoryNonEvolvableError（agent 工具路径传 true；UI 路径省略/false 不 gate）。
 * - defaultEvolvable：新建条目（name 不存在）的默认 evolvable（缺省 false）；被 setEvolvable 覆盖。
 *   agent write 传 true（agent 资产可进化）；UI POST 传 false（用户资产防 agent 擅改）。
 * - setEvolvable：UI 显式改 evolvable（PATCH body 携带）；存在则直接作为落盘 evolvable。
 *   agent 路径**不传**（不碰治理元字段）。
 * - source：条目来源标记（v0.0.149，与 evolvable 解耦，同一 opts 载体）。
 *   仅在**新建**时盖戳；update 路径忽略此值、保留既有 source（origin 不可变）。
 *   agent 路径传 'agent'；UI POST 传 'user'；UI PATCH 不传（保留既有）。
 */
export interface MemoryWriteOpts {
  enforceEvolvable?: boolean;
  defaultEvolvable?: boolean;
  setEvolvable?: boolean;
  /** 新建条目的来源盖戳（update 路径忽略，保留既有 source） */
  source?: 'user' | 'agent';
  /**
   * 存储数量硬上限注入（v0.0.247，可选；仅 writeLocked create 分支消费）：
   *   - scope：当前写入的配额层（'global' | 'session' | 'group'），决定查 quotas[scope]
   *   - appConfig：读 app_config 的 maxMemoryInject* 解析配额；null → 用默认 50/30/20
   * 缺省（undefined）= 不查配额（向后兼容存量 caller / UT 直接 writeLocked）。
   * 仅 create 路径（!existing）触发配额检查；update（existing）路径忽略此字段（不变量#1）。
   */
  store?: {
    scope: 'global' | 'session' | 'group';
    appConfig: AppConfigService | null;
  };
}

/**
 * 计算本次写入落盘的 evolvable 值（write 语义单点，两介质复用）：
 * - setEvolvable 存在 → 直接用（UI 显式改）
 * - 否则更新既有 → 保留既有 evolvable（existingEvolvable）
 * - 否则新建 → defaultEvolvable ?? false
 *
 * @param opts 写入策略入参
 * @param existingEvolvable 既有条目的 evolvable（已解析为具体 boolean，存量缺省 true）；无既有传 undefined
 */
export function resolvePersistedEvolvable(
  opts: MemoryWriteOpts,
  existingEvolvable: boolean | undefined,
): boolean {
  if (typeof opts.setEvolvable === 'boolean') return opts.setEvolvable;
  if (existingEvolvable !== undefined) return existingEvolvable;
  return opts.defaultEvolvable ?? false;
}
