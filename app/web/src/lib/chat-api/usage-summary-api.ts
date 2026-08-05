/**
 * usage-summary-api —— session usage / compact / summary / clear HTTP 客户端（从 chat-api.ts 拆出）
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §5.1（summary）
 *       specs/api/version_logs/v0.0.16/change_log.md（usage / compact / clear）
 *       specs/api/overall/04-agent-session.md §5（summary）/ §6（usage）/ §7（compact）/ §8（clear）
 *
 * 依赖 session-api.ts export 的 req helper。
 * v0.0.156 拆分重构：从原单文件 chat-api.ts move，**URL/method/body 100% 等价**（INV-B-3/G1）。
 */
import type { Session, SessionUsageView, SummaryInfo } from '../../components/chat-page/types';
import { req } from './session-api';

/**
 * [v0.0.16] GET /session/:id/usage —— 拉取会话用量快照（spec api 04-agent-session.md v1.4 §6）。
 * 进入会话时初始拉取一次；后续增量由 SSE session_usage_update 推送刷新。
 */
export async function getSessionUsage(
  sessionId: string,
  base?: string,
): Promise<SessionUsageView> {
  return req<SessionUsageView>(
    `/session/${encodeURIComponent(sessionId)}/usage`,
    undefined,
    base,
  );
}

/**
 * [v0.0.16] POST /session/:id/compact —— 手动触发 compact（spec api 04-agent-session.md v1.4 §7，202 fire-and-forget）。
 * 后端用 forked agent + SummaryTask CAS 执行；非 interrupting 且 summaryTask.status ∈ {idle,done,failed} 才接受，
 * running/interrupting 返 409（caller 捕获错误即可，UI 据 SSE summary_task_update 切换状态）。
 */
export async function postCompact(
  sessionId: string,
  base?: string,
): Promise<{ ok: true }> {
  return req<{ ok: true }>(
    `/session/${encodeURIComponent(sessionId)}/compact`,
    { method: 'POST', body: '{}' },
    base,
  );
}

/**
 * [v0.0.33.2] GET /session/:id/summary —— 读 session 当前 summary（spec api 04-agent-session.md §5）。
 * Studio 角色面板记忆 tab 拉取 member session summary（= 角色长期记忆）；未触发过 compact 时 summary=null。
 */
export async function getSummary(
  sessionId: string,
  base?: string,
): Promise<{ summary: SummaryInfo | null }> {
  return req<{ summary: SummaryInfo | null }>(
    `/session/${encodeURIComponent(sessionId)}/summary`,
    undefined,
    base,
  );
}

/**
 * [v0.0.16] POST /session/:id/clear —— 清空会话（spec api 04-agent-session.md v1.4 §8，200 同步原子）。
 * body { force?: boolean } 可选；caller 前置编排（abort current run + markSummaryFailed），
 * 后端 clearSession 原子清空 transcript/summary/runs/usage + 重置 state=idle，
 * emit session_status_update + session_usage_update + messages_cleared。
 */
export async function postClear(
  sessionId: string,
  opts?: { force?: boolean },
  base?: string,
): Promise<{ ok: true; session?: Session }> {
  return req<{ ok: true; session?: Session }>(
    `/session/${encodeURIComponent(sessionId)}/clear`,
    { method: 'POST', body: JSON.stringify(opts ?? {}) },
    base,
  );
}
