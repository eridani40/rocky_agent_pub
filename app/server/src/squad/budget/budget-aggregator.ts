/**
 * BudgetAggregator — squad 级 budget 横向聚合（Display + Gate 双语义分离）
 * 参考: specs/tech/squad/[P1]scheduler.md §5（budget helper 契约 + Display/Gate 分离 + daily 窗口）
 *       specs/tech/squad/[P1]squad_autonomy.md §6（budget 公式 + null=无 gate）
 *       specs/api/version_logs/v0.0.33.4/change_log.md §4（BudgetUsage schema）
 *
 * 设计要点：
 *   - squadBudgetRemaining（Gate 用，前提 budget≠null，caller short-circuit null）→ limit - consumed
 *   - displayUsage（Display 用，budget=null→limit=-1/remaining=-1，consumed 照算）
 *   - 横向 Σ team sessions 的 total.total_tokens（leader/mate sessionIds + squadChatSessionId）
 *   - daily 窗口：windowStart = now 在 squad.timezone 当地当日 0 点（注入 now = UT seam）
 *
 * spec drift（已在模块顶部记录，回债 spec 由 doc-modifier 收尾）：
 *   session_store.getUsageView 真签名为 (sessionId): Promise<SessionUsageView>，不带 windowStart
 *   （spec scheduler.md §5 写的 getUsageView(sid, windowStart) 为 aspirational）。
 *   本聚合器把数据源抽象为 getUsageTotalTokens(sid, windowStart) 注入点；wiring (T3) 包装
 *   sessionStore.getUsageView(sid).total.total_tokens 并暂忽略 windowStart（daily 分桶需
 *   session_usage 增 per-day 累计，future）。UT 通过 mock 该注入点模拟跨日窗口差异。
 */
import type { SquadEntity, MemberEntity } from '../../stores/squad-store';

/** Budget 配置形态（squad.budget json 字段；data_model §1.1） */
export interface SquadBudgetConfig {
  limit: number;
  window: 'daily';
  scope: 'team';
}

/** GET /budget/usage 响应（api change_log §4 BudgetUsage schema） */
export interface BudgetUsage {
  squadId: string;
  /** squad.budget.limit（budget=null 时=-1，仅 Display） */
  limit: number;
  window: 'daily';
  /** Σ team sessions total.total_tokens（当窗口） */
  consumed: number;
  /** limit - consumed（<0 表示超限；budget=null 时=-1） */
  remaining: number;
  /** ISO，当日 squad.timezone 0 点 */
  windowStart: string;
  /** ISO，次日 squad.timezone 0 点（回血时刻） */
  windowEnd: string;
  /** per-session 明细（UI 审计用） */
  perSession: Array<{ sessionId: string; role: 'leader' | 'mate' | 'squad'; consumed: number }>;
  timezone: string;
}

/**
 * 单 session 在 windowStart 窗口内的 total.total_tokens（注入点）。
 * wiring (T3) 包装 sessionStore.getUsageView(sid).total.total_tokens；
 * 真签名不带 windowStart，wiring 暂忽略（daily 分桶 future）。
 */
export type GetSessionUsageFn = (sessionId: string, windowStart: Date) => Promise<number>;

/** BudgetAggregator 依赖（构造注入，UT mock） */
export interface BudgetAggregatorDeps {
  squadStore: { getSquad(squadId: string): Promise<SquadEntity | undefined> };
  memberStore: { listMembers(squadId: string): Promise<MemberEntity[]> };
  /** 拉 session 当窗口 total.total_tokens（wiring 包装 sessionStore.getUsageView） */
  getUsageTotalTokens: GetSessionUsageFn;
}

/** 默认 timezone（squad.timezone 缺省时 = 进程本地 tz） */
const DEFAULT_TIMEZONE: string =
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

/**
 * Squad record 上的 timezone 字段访问（T5 加进 schema；此处前向兼容 cast）。
 * [v0.0.33.4 T5] 导出供 squad handler toDetail 回显复用（避免 DEFAULT_TIMEZONE 双写漂移）。
 */
export function squadTimezone(squad: SquadEntity): string {
  return (squad as SquadEntity & { timezone?: string }).timezone ?? DEFAULT_TIMEZONE;
}

/**
 * 计算 now 在指定 tz 当地当日 0 点的 UTC 瞬时（daily 窗口左界）。
 *
 * 算法（迭代对齐 wall clock 到 00:00，DST 安全）：
 *   1. 用 Intl.DateTimeFormat 取 now 在 tz 的 Y/M/D；
 *   2. 初始候选 = Date.UTC(Y,M-1,D,0,0,0)（与真当地 0 点差 ≤14h，max tz offset）；
 *   3. 读候选在 tz 的 wall clock（HH:mm），wallMin = hh*60+mm；
 *      - wallMin<12h：候选在当日 0 点之后 → 减 wallMin；
 *      - wallMin>12h：候选在下一日 0 点之前 → 加 (24h-wallMin)（用 wallMin-24h 负值统一）；
 *   4. 迭代 2 次（首次落在 ±14h 内，二次精确到分钟；DST 切换日 02:00 不影响第 2 次）。
 *
 * 注：不用「noon UTC offset」法——DST 切换日正午 offset ≠ 当日 0 点 offset（03-08 NY
 *     noon=EDT 但 midnight=EST，差 1h）。迭代法读 candidate 处 wall clock，自然正确。
 *
 * 参考: scheduler.md §5 daily 窗口分桶（squad.timezone 当日 0 点为窗口左界）
 */
export function startOfDayInTz(now: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t: string): string => {
    const p = parts.find(p => p.type === t);
    return p ? p.value : '0';
  };
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  // 初始候选：当日 UTC 0 点（与真当地 0 点差 ≤14h）
  let utcMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const wp = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(utcMs));
    // hour12:false 下部分环境午夜返 "24" 而非 "00"，统一 mod 24
    const hh = Number((wp.find(p => p.type === 'hour') || { value: '0' }).value) % 24;
    const mm = Number((wp.find(p => p.type === 'minute') || { value: '0' }).value);
    let wallMin = hh * 60 + mm;
    if (wallMin > 12 * 60) wallMin -= 24 * 60; // 候选近次日 0 点 → 推进（负 delta）
    utcMs -= wallMin * 60 * 1000;
  }
  return new Date(utcMs);
}

/**
 * 次日 0 点（windowEnd = budget 回血时刻）。
 * 从 startOfDay(now) 推 24h 后再算 startOfDay，正确处理 DST（一天可能 23/25 小时）。
 */
export function nextDayStartInTz(now: Date, tz: string): Date {
  const start = startOfDayInTz(now, tz);
  return startOfDayInTz(new Date(start.getTime() + 24 * 3600 * 1000), tz);
}

/**
 * BudgetAggregator — squad 级 budget 横向聚合器。
 *
 * 两个消费者（语义分离，scheduler.md §5 权威）：
 *   - squadBudgetRemaining（Gate）：scheduler.md §4 gate2 调用，假设 budget≠null
 *     （caller 对 null short-circuit 放行，故本函数永不被 null 调用）
 *   - displayUsage（Display）：GET /budget/usage 调用，budget=null 时返 -1
 */
export class BudgetAggregator {
  constructor(private readonly deps: BudgetAggregatorDeps) {}

  /**
   * Gate 用：squad 当窗口 budget 余量（前提 budget!==null）。
   *
   * caller（scheduler gate2）已对 null short-circuit（budget=null 跳过 budget gate），
   * 故本函数假定 budget!==null；若被 null 调用则抛错（编程错误）。
   *
   * @returns limit - consumed（<0 表示超限；caller check <=0 即 skip 当周期心跳）
   */
  async squadBudgetRemaining(squadId: string, now: Date): Promise<number> {
    const ctx = await this.compute(squadId, now);
    const budget = ctx.squad.budget as SquadBudgetConfig | null;
    if (budget === null || budget === undefined) {
      // 防御性：spec 约定 caller short-circuit null，到这说明编程错误
      throw new Error(
        `squadBudgetRemaining called with null/undefined budget (caller must short-circuit null); squadId=${squadId}`,
      );
    }
    return budget.limit - ctx.total;
  }

  /**
   * Display 用：GET /budget/usage 响应体。
   *
   * budget=null（未配）→ limit=-1/remaining=-1（UI 显示「无限制」），consumed 照算。
   * 注意：该 -1 **不进 scheduler gate**（gate 对 null 直接放行，见 scheduler.md §4 gate2）。
   */
  async displayUsage(squadId: string, now: Date): Promise<BudgetUsage> {
    const ctx = await this.compute(squadId, now);
    const budget = ctx.squad.budget as SquadBudgetConfig | null;
    const isNull = budget === null || budget === undefined;
    const limit = isNull ? -1 : budget.limit;
    const remaining = isNull ? -1 : budget.limit - ctx.total;
    return {
      squadId,
      limit,
      window: 'daily',
      consumed: ctx.total,
      remaining,
      windowStart: ctx.windowStart.toISOString(),
      windowEnd: ctx.windowEnd.toISOString(),
      perSession: ctx.perSession,
      timezone: ctx.tz,
    };
  }

  /**
   * 拉取 squad + members + 各 session 当窗口 usage，聚合 total + perSession。
   * Display/Gate 共用（两消费者仅 budget=null 处理不同）。
   */
  private async compute(
    squadId: string,
    now: Date,
  ): Promise<{
    squad: SquadEntity;
    total: number;
    perSession: BudgetUsage['perSession'];
    windowStart: Date;
    windowEnd: Date;
    tz: string;
  }> {
    const squad = await this.deps.squadStore.getSquad(squadId);
    if (!squad) throw new Error(`squad not found: ${squadId}`);
    const members = await this.deps.memberStore.listMembers(squadId);
    const tz = squadTimezone(squad);
    const windowStart = startOfDayInTz(now, tz);
    const windowEnd = nextDayStartInTz(now, tz);

    const perSession: BudgetUsage['perSession'] = [];
    let total = 0;
    // 横向 Σ：team sessions（leader/mate 各自的 sessionId + squadChatSessionId）
    // memberIds 含 leader（data_model §1.1），listMembers 返全量（含 leader）。
    // 各 session usage 读取相互独立 → Promise.all 并发（顺序由 map 保序，total 可交换，
    // 行为与串行一致；gate 路径每 tick 调，并发降 N 次 round-trip 为 1）。
    const memberEntries = await Promise.all(
      members.map(async m => {
        const consumed = await this.deps.getUsageTotalTokens(m.sessionId, windowStart);
        return { sessionId: m.sessionId, role: m.role, consumed };
      }),
    );
    for (const e of memberEntries) {
      total += e.consumed;
      perSession.push(e);
    }
    const squadChatConsumed = await this.deps.getUsageTotalTokens(
      squad.squadChatSessionId,
      windowStart,
    );
    total += squadChatConsumed;
    perSession.push({
      sessionId: squad.squadChatSessionId,
      role: 'squad',
      consumed: squadChatConsumed,
    });
    return { squad, total, perSession, windowStart, windowEnd, tz };
  }
}
