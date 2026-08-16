/**
 * TokenUsageSubscriber — 异步消费 SessionUsageUpdateEvent 写 token_usage_stat
 * 参考: specs/tech/persistence/[P1]token_usage_stat.md §4（写入路径 + 不变量）
 *       specs/tech/version_logs/v0.0.194/change_plan.md 模块 C 第 2-3 行
 *       specs/prd/version_logs/v0.0.194/prd.md §2.5（异步不阻塞主流程 P8/P10）
 *
 * 职责：
 *   - onUsageNotify(sid, view)：消费 SessionUsageView → 算 delta → upsertDelta
 *   - model 归属优先级链：registry 成功 target（运行时真实命中）→ session.providerId/modelId
 *     → squad.modelDefault/modelDefaultProviderId → '__unknown__'（v0.0.359：registry 插头最高优先）
 *   - subagent 跳过（parentSessionId 非空——usage 已通过 accumulateUsage 递归 sub 上报 parent）
 *   - 首见记 0（不灌历史累计，§4 不变量）
 *   - fire-and-forget 错误隔离（写入失败不阻塞主对话，§4 不变量 + PRD P10）
 *
 * 装配方式（change_plan 模块 C row 2-3）：
 *   - setTokenUsageSubscriberDeps({statStore, sessionStore, squadStore})：模块级 setter
 *     （bootstrap 装配后注入；UT 可直接 set）
 *   - sessionStoreNotifyUsageChanged emit 后调 notifyTokenUsageSubscriber(sid, view)（fire-and-forget catch）
 *
 * 偏离 change_plan（向 orchestrator 汇报）：
 *   - change_plan 写「new TokenUsageSubscriber().subscribe(sessionStatusBus)」bus 订阅 + 模块 C row 3
 *     「sessionStoreNotifyUsageChanged 额外调 subscriber.onUsageNotify」——两者同时用会 double-count。
 *   - 实现：仅用 direct call（onUsageNotify），不订阅 bus。direct call 更简洁可靠（无 bus 生命周期 +
 *     无订阅时序竞态），fire-and-forget 在调用点显式 catch。spec §4 的「subscribe to bus」是概念
 *     数据流描述（subscriber 消费 usage events），direct call 是等价的投递机制。
 */
import type { TokenUsageStatStore, TokenUsageDelta } from '../../persistence/token-usage-stat-store';
import type { SessionUsageView } from '../../agent/session-store-types';
import type { SessionStore } from '../../agent/session-store';
import { SessionSchema } from '../../agent/schema_defs';
// [v0.0.359 T1] 成功 target registry（model 归属最高优先：运行时真实命中 physical model）
import { getSuccessTarget } from '../../llm/caller/success-target-registry';

/** model 解析需要的 squad 读取接口（最小契约，UT 可 mock；subscriber 只读 3 个字段） */
export interface SquadReader {
  getSquad(squadId: string): Promise<{ modelDefault?: string; modelDefaultProviderId?: string; timezone?: string } | undefined> | { modelDefault?: string; modelDefaultProviderId?: string; timezone?: string } | undefined;
}

/** subscriber 依赖（模块级 setter 注入） */
export interface TokenUsageSubscriberDeps {
  statStore: TokenUsageStatStore;
  sessionStore: SessionStore;
  squadReader: SquadReader;
}

/** Usage total 字段 key → stat 字段 key 映射（snake_case 对齐） */
const TOTAL_TO_DELTA: Record<string, keyof TokenUsageDelta> = {
  input_no_cache: 'input_no_cache',
  input_cache_read: 'cache_read',
  input_cache_write: 'cache_creation',
  output_response: 'output_response',
  output_reasoning: 'output_reasoning',
  cost: 'cost',
};

/** '__unknown__' 兜底 model 值 */
const UNKNOWN_MODEL = '__unknown__';

/**
 * 格式化 ISO 时间到 squad.timezone 本地 'YYYY-MM-DD HH' 小时桶。
 * 用 Intl.DateTimeFormat 取 timezone-aware 的 Y/M/D/H 拼接。
 */
function formatHourBucket(isoTime: string, timezone: string): string {
  const dt = new Date(isoTime);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(dt);
  const get = (t: string): string => {
    const p = parts.find(p => p.type === t);
    return p ? p.value : '0';
  };
  const y = get('year');
  const m = get('month');
  const d = get('day');
  let h = Number(get('hour')) % 24; // hour12:false 下部分环境午夜返 "24"
  return `${y}-${m}-${d} ${String(h).padStart(2, '0')}`;
}

/**
 * 从 SessionUsageView.total 派生 per-field delta。
 * 首见（lastSeen 无）→ 所有字段 0（§4 不变量：首见记 0，不灌历史累计）。
 * 后续 → per-field diff(current, lastSeen)，负值钳 0（view.total 是累计值不应回退，
 *   若回退说明状态被外部清，跳过本次 delta 避免负统计）。
 */
function computeDelta(
  currentTotal: Record<string, number>,
  lastSeen: Record<string, number> | undefined,
): TokenUsageDelta & { llmCallCount: number } {
  // 首见记 0（不灌历史累计）
  if (!lastSeen) {
    return { input_no_cache: 0, cache_read: 0, cache_creation: 0, output_response: 0, output_reasoning: 0, cost: 0, llmCallCount: 0 };
  }
  // 后续 → per-field diff(current, lastSeen)，负值钳 0
  const delta: TokenUsageDelta & { llmCallCount: number } = {
    input_no_cache: 0, cache_read: 0, cache_creation: 0,
    output_response: 0, output_reasoning: 0, cost: 0, llmCallCount: 0,
  };
  for (const [totalKey, deltaKey] of Object.entries(TOTAL_TO_DELTA)) {
    const cur = currentTotal[totalKey] ?? 0;
    const prev = lastSeen[totalKey] ?? 0;
    delta[deltaKey] = Math.max(0, cur - prev);
  }
  delta.llmCallCount = Math.max(0, (currentTotal['llmCallCount'] ?? 0) - (lastSeen['llmCallCount'] ?? 0));
  return delta;
}

/**
 * TokenUsageSubscriber — 消费 usage event 算 delta 写 stat 表。
 * 内部持 lastSeen[ssid] 记录上次 view.total（per-field diff 基线）。
 */
class TokenUsageSubscriber {
  private readonly lastSeen = new Map<string, Record<string, number>>();

  constructor(private readonly deps: TokenUsageSubscriberDeps) {}

  /**
   * 消费 SessionUsageView → 算 delta → upsertDelta（fire-and-forget 错误隔离）。
   *
   * 步骤（spec §4）：
   *   1. 查 SessionSchema(ssid) 拿 squadId/memberId/providerId/modelId/parentSessionId
   *   2. subagent（parentSessionId 非空）跳过
   *   3. model 三级 fallback：session → squad → '__unknown__'
   *   4. hour = format(event time, squad.timezone, 'YYYY-MM-DD HH')
   *   5. delta = per-field diff(view.total, lastSeen[ssid])（首见记 0）
   *   6. upsertDelta（fire-and-forget，失败不抛）
   */
  async onUsageNotify(sid: string, view: SessionUsageView, eventTime: string = new Date().toISOString()): Promise<void> {
    try {
      const rec = this.deps.sessionStore.crud.get(SessionSchema, sid);
      if (!rec) return; // session 不存在静默（与 accumulate 容错一致）

      // subagent 跳过（parentSessionId 非空——usage 已递归上报 parent）
      const parentSessionId = (rec as { parentSessionId?: string }).parentSessionId;
      if (parentSessionId) return;

      const squadId = (rec as { squadId?: string }).squadId;
      const memberId = (rec as { memberId?: string }).memberId;
      // 无 squadId/memberId → 非 studio session，跳过（token 统计是 squad 功能）
      if (!squadId || !memberId) return;

      // model 归属优先级链 + timezone 都需读 squad，一次 fetch 复用（避免重复 disk IO）
      // [v0.0.359 T1] 优先级链插头：registry 成功 target（运行时真实命中 physical model，
      // 覆盖一切「实际调用过」的 session）> session/squad 配置侧三级 fallback（registry miss
      // 时兜底：进程重启后/旧 session 补记/测试注入路径——零回归，原样保留）
      const successTarget = getSuccessTarget(sid);
      const sessionProviderId = (rec as { providerId?: string }).providerId;
      const sessionModelId = (rec as { modelId?: string }).modelId;
      const squad = await this.deps.squadReader.getSquad(squadId);
      let providerId = successTarget?.providerId ?? sessionProviderId;
      let modelId = successTarget?.modelId ?? sessionModelId;
      if ((!providerId || !modelId) && squad) {
        // fallback squad.modelDefault/modelDefaultProviderId
        providerId = providerId ?? (squad as { modelDefaultProviderId?: string }).modelDefaultProviderId;
        modelId = modelId ?? (squad as { modelDefault?: string }).modelDefault;
      }
      if (!providerId || !modelId) {
        providerId = providerId ?? UNKNOWN_MODEL;
        modelId = modelId ?? UNKNOWN_MODEL;
      }

      // hour 桶（squad.timezone 本地）
      const timezone = (squad as { timezone?: string } | undefined)?.timezone ?? 'UTC';
      const hour = formatHourBucket(eventTime, timezone);

      // delta 计算（首见记 0）
      const currentTotal = view.total ?? {};
      const prev = this.lastSeen.get(sid);
      const delta = computeDelta(currentTotal, prev);
      this.lastSeen.set(sid, { ...currentTotal });

      // upsertDelta（fire-and-forget 错误隔离：失败不阻塞主对话）
      await this.deps.statStore.upsertDelta(
        { squadId, memberId, sessionId: sid, hour, providerId, modelId },
        delta,
      );
    } catch {
      // 错误隔离（PRD P10）：统计异常不崩主对话，静默吞
    }
  }
}

// ============================================================
// 模块级 holder（同 setSessionStoreEpDelegate 范式）
// ============================================================

let subscriber: TokenUsageSubscriber | null = null;

/**
 * 注入 subscriber 依赖（bootstrap 装配后调一次；UT 可直接 set）。
 * 必须在 sessionStoreNotifyUsageChanged 首次调前完成注入。
 */
export function setTokenUsageSubscriberDeps(deps: TokenUsageSubscriberDeps): void {
  subscriber = new TokenUsageSubscriber(deps);
}

/** 消费 usage event（sessionStoreNotifyUsageChanged emit 后 fire-and-forget 调） */
export async function notifyTokenUsageSubscriber(
  sid: string,
  view: SessionUsageView,
  eventTime?: string,
): Promise<void> {
  if (!subscriber) return;
  await subscriber.onUsageNotify(sid, view, eventTime);
}

// 测试辅助：重置 holder（UT afterEach 清理用）
export function __resetTokenUsageSubscriberForTest(): void {
  subscriber = null;
}
