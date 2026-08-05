/**
 * summary-block — summary 消息块（preamble + head + tail）算法单一权威源
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §6/§6.5
 *       specs/tech/agent/context/[P0]context_compact_detail.md
 *
 * 职责：
 *   - pickHead / pickTail：head/tail 选取（tokenCap 算法，char×ratio 累加）
 *   - buildSummaryBlock：summary 单 text block（preamble+head+tail 3 段）
 *   - bakeSummaryBlock：[v0.0.186] compact 时烘焙完整 block 文本（一次构建，持久化到
 *     summary 记录 block 字段；组装期 msg[0] 直接读，零选取零计算 → prompt 缓存前缀逐字节稳定）
 *   - getEstimatedOutput：读 appConfig estimated output（assemble budget 用）
 *
 * [v0.0.186] 本模块自 plugin rocky_context/assemble/base_builder_helpers.ts 迁入 server：
 *   compact 烘焙（runCompact）与组装 fallback（base_builder）两处消费同一算法；
 *   server 不能反向 import plugin 源码（plugin 边界/build 约束），故算法单源落 server，
 *   plugin 侧经深 import 复用（build-plugins 会改写为 @app/server/dist 深路径）。
 *
 * 两个消费点：
 *   1. compact 烘焙（主路径）：runCompact 产 summary 时调 bakeSummaryBlock，
 *      用当时的 ratio + 锚定候选 + tokenCap 算出完整文本存 record.block。
 *   2. 组装 fallback（存量旧 summary 无 block 字段）：base_builder 即时构建，
 *      用 pickHead/pickTail/buildSummaryBlock 走 v0.0.185 锚定路径，下次 compact 自动升级。
 */
import type { Message, TextBlock } from '../message/types';
import type { SessionStore } from './session-store';
import type { SessionConfig } from './context-types';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './session-usage-helper';

/** 默认 tokenCap（与 base_builder / summary_do_compact configSchema.default 一致）：head/tail 各自的累加上限（char×ratio 口径） */
export const DEFAULT_SUMMARY_TOKEN_CAP = 10000;
/** 默认 head/tail 候选各取条数上限（与 summary_reader / summary_do_compact configSchema.default 一致） */
export const DEFAULT_SUMMARY_CANDIDATE_LIMIT = 500;
/** assemble budget 占 tokenLimit 的比例（留 5% 给 prompt/system 等开销） */
export const SUMMARY_BUDGET_RATIO = 0.95;

/**
 * head 选取：从候选首条往后累加 char×ratio，
 * 加上当前条会超过 tokenCap 则弃该条并停止；不足 1 条保底 1 条。
 */
export function pickHead(candidates: Message[], tokenCap: number, ratio: number): Message[] {
  return pickByTokenCap(candidates, tokenCap, ratio, /* fromStart */ true);
}

/**
 * tail 选取：从候选末尾（锚定 summaryUpTo）往前累加 char×ratio，
 * 加上当前条会超过 tokenCap 则弃该条并停止；不足 1 条保底 1 条。结果按原序返回。
 */
export function pickTail(candidates: Message[], tokenCap: number, ratio: number): Message[] {
  return pickByTokenCap(candidates, tokenCap, ratio, /* fromStart */ false);
}

/**
 * head/tail 共享选取算法（owner 拍板：min=1 保底 + tokenCap 上限，无 max/fraction）。
 *   - fromStart=true：从头累加；fromStart=false：从尾累加（结果按原序返回）。
 *   - 逐条累加 messageChars×ratio；picked 已有 ≥1 条且加上当前条会超 tokenCap → 弃当前条并停止
 *     （不跳过当前条继续试后面的——「放弃当前条，停止」语义保确定性）。
 *   - 保底：首条必取（哪怕它一条就超 cap）。
 * 同候选 + 同 ratio → 同选取结果（纯函数）；候选锚定后同 summary version 下逐字节稳定。
 */
function pickByTokenCap(
  candidates: Message[],
  tokenCap: number,
  ratio: number,
  fromStart: boolean,
): Message[] {
  if (candidates.length === 0) return [];
  const ordered = fromStart ? candidates : [...candidates].reverse();
  const picked: Message[] = [];
  let tokens = 0;
  for (const m of ordered) {
    const next = tokens + messageChars(m) * ratio;
    // 超 cap 且已保底 1 条 → 弃当前条并停止
    if (picked.length >= 1 && next > tokenCap) break;
    picked.push(m);
    tokens = next;
  }
  return fromStart ? picked : picked.reverse();
}

/** 单 message char 估算（累加 content block 的 text） */
export function messageChars(m: Message): number {
  return m.content.reduce((n, b) => {
    if (b.type === 'text' || b.type === 'reasoning') return n + b.text.length;
    return n;
  }, 0);
}

/**
 * recent 放置：从新→旧累加至 budgetChars，超额丢最旧。
 *   - 从 transcript 末尾（最新）往前取，累加 char；超出 budget 即停（保新弃旧）。
 *   - 返回结果按时间升序（与原 transcript 一致，便于下游 reducer/LLM 顺序消费）。
 *   - budgetChars<=0 → 空数组（summary 已用满预算的极端兜底）。
 * 两个消费点：base_builder recent 区放置（组装）+ runCompact postSnapshot 合成（假装 assemble）。
 */
export function pickRecentWithinBudget(recent: Message[], budgetChars: number): Message[] {
  if (recent.length === 0 || budgetChars <= 0) return [];
  const picked: Message[] = [];
  let chars = 0;
  // 从新→旧累积（push O(1)），最后 reverse 回升序（避免 unshift O(n²)）
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    const next = chars + messageChars(m);
    if (picked.length > 0 && next > budgetChars) break;
    picked.push(m);
    chars = next;
  }
  return picked.reverse();
}

/**
 * 把单 message 序列化为带 msgid+role 的紧凑行（head/tail 段内）。
 * 非 text/reasoning block 跳过（tool_call/tool_result 不进 head/tail 摘录）。
 * 格式：`[<msgid>|<role>] <content>`
 */
function serializeMessageLine(m: Message): string {
  const text = m.content
    .map((b) => {
      if (b.type === 'text' || b.type === 'reasoning') return b.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
  return `[${m.id}|${m.role}] ${text}`;
}

/**
 * 构建 summary 单 text content block（3 段：preamble + head + tail）。
 *   - preamble：引导 LLM 一句话 + summary 正文（recap）
 *   - head 段：早期保留原文（msgid+role+content），按原序
 *   - tail 段：近期保留原文，按原序
 * tailDropped=true 时 tail 段替换为降级说明（summary 自身超 budget 时）。
 */
export function buildSummaryBlock(
  summary: { content: string | null },
  head: Message[],
  tail: Message[],
  tailDropped = false,
): TextBlock {
  const lines: string[] = [];
  // ① preamble：引导 + summary 正文
  lines.push('以下是之前对话的摘要，以及为保持上下文连续保留的原文片段（head=早期，tail=近期）：');
  lines.push('');
  lines.push(summary.content ?? '');
  lines.push('');
  // ② head 段
  lines.push('--- head（早期保留原文）---');
  for (const m of head) lines.push(serializeMessageLine(m));
  lines.push('');
  // ③ tail 段
  if (tailDropped) {
    lines.push('--- tail（近期保留原文，已因 budget 限制截断）---');
  } else {
    lines.push('--- tail（近期保留原文）---');
    for (const m of tail) lines.push(serializeMessageLine(m));
  }
  return { type: 'text', text: lines.join('\n') };
}

/**
 * 读 estimated output（估算输出常量，非 model maxOutput）。
 * 鸭子类型读 appConfig.get('context', 'maxOutputTokens')；缺省/非正数/未注入 → DEFAULT_MAX_OUTPUT_TOKENS。
 * 字段名保留 `maxOutputTokens`（持久化 record + SSE schema 兼容）；语义 = estimated output。
 * [v0.0.186] 入参源修正为 SessionConfig.appConfig（v0.0.89 dev_config 已迁 app_config；
 *   旧 base_builder 读 ctx.config.devConfig 在生产恒 undefined → 恒走默认 20000，属迁移遗漏）。
 */
export function getEstimatedOutput(appConfig: unknown): number {
  if (!appConfig || typeof (appConfig as { get?: unknown }).get !== 'function') {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  const raw = (appConfig as { get: (g: string, k: string) => unknown }).get(
    'context',
    'maxOutputTokens',
  );
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * summary 超 budget 时丢 tail 保 preamble+head 的降级构建（§6.5）。
 * 与 base_builder fallback 路径同一规则，烘焙/即时构建共用。
 */
export function applySummaryBudget(
  summary: { content: string | null },
  head: Message[],
  tail: Message[],
  budgetChars: number,
): string {
  const full = buildSummaryBlock(summary, head, tail).text;
  if (full.length > budgetChars && tail.length > 0) {
    return buildSummaryBlock(summary, head, /* tail */ [], /* tailDropped */ true).text;
  }
  return full;
}

/** bakeSummaryBlock 入参（runCompact 调；tokenCap/candidateLimit 由 do_compact impl cfg 透传，缺省默认） */
export interface SummaryBakeInput {
  /** 摘要正文（extractTag 产物） */
  content: string;
  /** 摘要覆盖到的 message id（候选锚点）；null → 无 head/tail 段 */
  summaryUpTo: string | null;
  /** head/tail 各自 token 累加上限（char×ratio 口径） */
  tokenCap?: number;
  /** head/tail 候选各取条数上限 */
  candidateLimit?: number;
}

/**
 * [v0.0.186] 烘焙 summary 完整 block 文本（compact 时执行一次，结果持久化）。
 *
 * 算法与组装 fallback 完全同源：当时的 store.getRatio + 锚定候选
 * （head=会话真第一条 takeFromStart / tail=summaryUpTo 结尾）+ pickByTokenCap
 * + head∩tail 去重 + budget tailDropped 降级。
 *
 * 烘焙后 msg[0] 永远等于该文本（组装期零计算）：
 *   - ratio 后续漂移、transcript 增长、recent 窗口滑动都不影响 msg[0]（prompt 缓存前缀稳定）。
 *   - 边界（记 spec）：烘焙后 head/tail 窗口内历史消息被 HITL 编辑不回刷本块
 *     （recent 区仍每轮读最新，不受影响）；下次 compact 重新烘焙。
 */
export async function bakeSummaryBlock(
  store: SessionStore,
  config: SessionConfig,
  input: SummaryBakeInput,
): Promise<string> {
  const sid = config.sessionId;
  const tokenCap = input.tokenCap ?? DEFAULT_SUMMARY_TOKEN_CAP;
  const candidateLimit = input.candidateLimit ?? DEFAULT_SUMMARY_CANDIDATE_LIMIT;

  // 当时的 ratio（session 学习值，冷启动 1.0）——烘焙一刻定格，之后漂移不影响本块
  const ratio = await store.getRatio(sid);

  // 锚定候选（与 summary_reader v0.0.185 同一取法）：summaryUpTo=null → 无候选
  let headCandidates: Message[] = [];
  let tailCandidates: Message[] = [];
  if (input.summaryUpTo) {
    const [headPage, tailPage] = await Promise.all([
      store.getMessages(sid, {
        upToId: input.summaryUpTo,
        limit: candidateLimit,
        takeFromStart: true,
      }),
      store.getMessages(sid, { upToId: input.summaryUpTo, limit: candidateLimit }),
    ]);
    headCandidates = headPage.items;
    tailCandidates = tailPage.items;
  }

  const head = pickHead(headCandidates, tokenCap, ratio);
  const tail = pickTail(tailCandidates, tokenCap, ratio);
  // head∩tail 按 head 算（去重）
  const headIds = new Set(head.map((m) => m.id));
  const tailDeduped = tail.filter((m) => !headIds.has(m.id));

  // budget 降级（§6.5）：summary 自身超 budget → 丢 tail 保 preamble+head
  const tokenLimit = config.client.contextWindow;
  const estimatedOutput = getEstimatedOutput(config.appConfig);
  const budgetTokens = Math.max(0, SUMMARY_BUDGET_RATIO * tokenLimit - estimatedOutput);
  const budgetChars = ratio > 0 ? budgetTokens / ratio : budgetTokens;

  return applySummaryBudget({ content: input.content }, head, tailDeduped, budgetChars);
}
