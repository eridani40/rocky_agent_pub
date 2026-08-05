/**
 * chat-debug-log —— 【临时】chat 前端 SSE→reducer→渲染 链路观测日志
 *
 * 背景：定位「100+ tool_call 会话切走再切回，前端只渲染后面几个」的真 bug
 * （后端 replay buffer 数据齐：subscribe replayed=139 toolCall=133，怀疑前端断链）。
 *
 * 观测三层（都带 [CHAT-DEBUG] 前缀，console 过滤即得）：
 *   1. net      —— sse-client 帧网络到达 + subId 路由命中/丢弃（收到没收到）
 *   2. sse/drop —— useMessages onEvent 每条事件序号 + ctx null 丢弃（收到进没进 reducer）
 *   3. render   —— message-stream / tool-batch 渲染计数 + 折叠态（建了渲没渲）
 *
 * 排查完本文件连同各打点整体删除。开关：CHAT_DEBUG=false 一键全关。
 */

/** 一键开关：false 时所有打点零输出（保留调用点，便于后续清理） */
export const CHAT_DEBUG = true;

/** 打点输出（gate 在 CHAT_DEBUG） */
export function chatDebug(...args: unknown[]): void {
  if (CHAT_DEBUG) console.log('[CHAT-DEBUG]', ...args);
}

// —— SSE 事件统计（per-init 累计 + burst 分组） —— //

/** 累计统计：init 归零；burst = 800ms 静默窗口切分（回放 burst vs 实时流自然区分） */
interface BurstStats {
  count: number;
  toolCallStart: number;
  toolResultStart: number;
  byType: Record<string, number>;
}

let seq = 0;
let initAt = 0;
let burst: BurstStats = { count: 0, toolCallStart: 0, toolResultStart: 0, byType: {} };
let burstTimer: ReturnType<typeof setTimeout> | null = null;

function emptyBurst(): BurstStats {
  return { count: 0, toolCallStart: 0, toolResultStart: 0, byType: {} };
}

/** useMessages onInit 起点调：归零统计 + 记时间锚点（切走切回=一次新 INIT） */
export function resetChatSseStats(sessionId: string): void {
  if (!CHAT_DEBUG) return;
  seq = 0;
  initAt = Date.now();
  burst = emptyBurst();
  if (burstTimer) {
    clearTimeout(burstTimer);
    burstTimer = null;
  }
  chatDebug(`INIT session=${sessionId} —— 统计归零；随后的 burst-end 即回放/实时事件分组`);
}

/**
 * useMessages onEvent 每条 agent_loop 事件调：累计 + burst 计数 + 安排 burst-end 摘要。
 * @returns seq 全局序号 + sinceInitMs 距 INIT 毫秒（回放 burst = 一排小数字）
 */
export function trackChatSseEvent(type: string): { seq: number; sinceInitMs: number } {
  seq++;
  burst.count++;
  burst.byType[type] = (burst.byType[type] ?? 0) + 1;
  if (type === 'tool_call_start') burst.toolCallStart++;
  if (type === 'tool_result_start') burst.toolResultStart++;
  if (burstTimer) clearTimeout(burstTimer);
  burstTimer = setTimeout(() => {
    burstTimer = null;
    chatDebug(
      `burst-end size=${burst.count} toolCallStart=${burst.toolCallStart} ` +
        `toolResultStart=${burst.toolResultStart} byType=${JSON.stringify(burst.byType)}`,
    );
    burst = emptyBurst();
  }, 800);
  return { seq, sinceInitMs: Date.now() - initAt };
}

/** 数 Message[] 里 type='tool_call' 的 block 总数（结构化类型，不依赖 chat-page/types） */
export function countToolCallBlocks(messages: ReadonlyArray<{ content: ReadonlyArray<{ type: string }> }>): number {
  let n = 0;
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_call') n++;
  return n;
}

// —— net 层（sse-client 帧到达 + 路由命中） —— //

/** net 层帧序号（agent_loop topic 专属；一 session 有 2 订阅者故帧数≈2×hook 侧） */
let netSeq = 0;

/** 从事件上提取可诊断 id 字段（messageId/toolCallId/enqueueId），无则空串 */
export function dbgIds(evt: unknown): string {
  const e = evt as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ['messageId', 'toolCallId', 'enqueueId']) {
    if (typeof e[k] === 'string') parts.push(`${k}=${e[k]}`);
  }
  return parts.join(' ');
}

/**
 * sse-client 帧分发调：只记 agent_loop topic；routed=no = 帧到了但 subId 无 handler 被静默丢。
 * subId 只打尾 6 位（区分 useMessages / useRunState 双订阅的两条帧流）。
 */
export function trackChatNetFrame(topic: string, data: unknown, subId: string, routed: boolean): void {
  if (!CHAT_DEBUG || topic !== 'agent_loop') return;
  const type = (data as { type?: string } | undefined)?.type;
  chatDebug(`net #${++netSeq} type=${type} subId=${subId.slice(-6)} routed=${routed ? 'yes' : 'NO-DROPPED'} ${dbgIds(data)}`);
}
