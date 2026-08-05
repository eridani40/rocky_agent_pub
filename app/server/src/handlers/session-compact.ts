/**
 * session-compact handler — POST /session/:id/compact 手动触发 compact
 * 参考: specs/api/overall/04-agent-session.md §7（POST /session/:id/compact 契约）
 *       specs/tech/agent/context/[P0]context_compact_detail.md §2b（手动触发路径）
 *       specs/tech/agent/session/[P0]session_task_lock.md §5（409 判定读 lock.getState）
 *       specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §C
 *
 * 职责（v0.0.158 简化后 ~30 行；chat/compact 同链，唯一入口 = agentManager.resolveConfigBySid）：
 *   - POST → 202 fire-and-forget（不 await compact 完成）
 *   - 触发条件校验（唯一 409 = compact 正在跑）：
 *       读 SessionTaskLock.getState(sid, 'compact').status === 'running'
 *       → 409 { error:"compact_in_progress", message }
 *       否则（任何 session.state：idle/running/interrupting/interrupted/error）→ 通过 →
 *       调 contextEngine.compact 执行路径
 *   - SessionConfig 组装由 agentManager.resolveConfigBySid 收敛（与 chat 同链，不再区分 summary
 *     子链——本版本删「独立 summary 模型」层，chat/compact 用同一 resolve 结果）。
 *   - 复用 context-compact-runner 的 compact 执行路径（lock.acquire('compact') → forked agent
 *     → setSummary + accumulateUsage('forked') write → lock.markDone/failed）。
 *
 * 原则：任何 session 任何时间都能 compact，除非 compact 正在跑。
 * compact 互斥由 lock.getState 检查（接口层）+ 内部 lock.acquire CAS（执行层）双保险保证。
 *
 * SessionTaskLock 不落盘（spec §3.2），重启 = 全部释放（无幽灵锁）。
 *
 * subagent 允许 compact——长跑上下文也会爆炸，必须支持（手动+自动均走同一 forked agent 路径）。
 */
import {
  ProviderNotFoundError,
  ModelNotFoundError,
} from '../llm-client-factory';
import { type SessionHandlerDeps } from './session';
import type { SessionConfig } from '../agent/context-types';
// ModelNotConfiguredError：resolve 链跑完仍无可用 modelId → 400 错误体。
//   参考: services/model-resolver.ts + PRD 03 §5.1
import { ModelNotConfiguredError } from '../services/model-resolver';

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 处理 POST /session/:id/compact — 手动触发 compact（fire-and-forget）。
 *
 * spec api §7 / context_compact_detail §2b：
 *   - 202 + { ok: true } = 服务端已接收触发请求、compact 异步执行中
 *   - 409 + { error, message } 唯一一种：
 *       compact_in_progress（lock.getState(sid,'compact').status === 'running'）
 *   任何 session.state（含 running/interrupting/idle/interrupted/error）都放行 → 202
 *
 * fire-and-forget：handler 启动 compact（不 await 完成），立即返 202；compact 异步执行。
 *
 * 错误：400 model 未配置 / provider 未找到；404 session 不存在；405 非 POST。
 */
export async function handleSessionCompact(
  _req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  // 唯一 409 = compact 正在跑。读 SessionTaskLock.getState(sid, 'compact').status。
  // session.state（含 running/interrupting）一律放行——任何时间都可 compact（subagent 防爆炸关键）。
  // SessionHandlerDeps.taskLock 缺省（旧测试未注入）→ 视为 idle 放行（保 UT 兼容）。
  const taskLock = deps.taskLock;
  if (taskLock && taskLock.getState(id, 'compact').status === 'running') {
    return json(409, { error: 'compact_in_progress', message: '正在压缩中，请等待' });
  }

  // v0.0.158：唯一入口 — agentManager.resolveConfigBySid（与 chat 同链）。
  //   compact 不再走独立 summary 子链，chat/compact 用同一 config resolve 结果。
  //   ModelNotConfiguredError → 400 {code, message, detail:{sessionType}}（PRD 03 §5.1）；
  //   ProviderNotFound/ModelNotFound → 400；其他 → 500。
  let config: SessionConfig;
  try {
    config = await deps.agentManager.resolveConfigBySid(id);
  } catch (e) {
    if (e instanceof ModelNotConfiguredError) {
      return json(400, { code: e.code, message: e.message, detail: e.detail });
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ProviderNotFoundError || e instanceof ModelNotFoundError) {
      return json(400, { error: msg });
    }
    return json(500, { error: `compact config build failed: ${msg}` });
  }

  // fire-and-forget：启动 compact 不 await 完成，立即返 202。
  // compact 执行路径内部：lock.acquire('compact') CAS（并发第二个 acquire 返 false →
  //   不执行，无副作用）→ forked agent → setSummary + accumulateUsage('forked') write →
  //   lock.markDone/failed。失败仅 log（不 reject 进程）。
  void deps.contextEngine.compact(config).catch((err) => {
    console.warn(
      `[compact] session ${id} manual compact failed:`,
      err instanceof Error ? err.message : String(err),
    );
  });

  return json(202, { ok: true });
}
