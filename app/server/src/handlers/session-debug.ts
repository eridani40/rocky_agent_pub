/**
 * session 调试端点 handler
 * 参考: specs/tech/agent/skills/[P0]skill_architecture.md §8（skills mapper L0 注入）
 *
 * 端点：
 *   - GET /session/:id/debug/system-prompt（test gate，组装后 system prompt 文本）
 *
 * test gate：APP_ENV=test 或 NODE_ENV=test 才放行；其他环境一律 404
 * （防生产/dev 泄露 system prompt 内容）。
 */
import type { PluginManager } from '../plugin/plugin-manager';
import type { SessionHandlerDeps } from './session';
import { buildSessionConfigFromDeps, type StudioSessionContext } from './session-config';
// SessionKind + isStudioMainSession
import { SessionKind, isStudioMainSession } from '@app/shared';
import { buildSystemPrompt } from '../agent/system-prompt-builder';
import { scopeIdOf } from '../agent/scope-id';
// debug 端点补 studioContext：复用 bootstrap.setResolveConfig 同模式
//   （bizType==='studio' && type!=='subagent' → 取 squad/member/members entity 注入 studioContext）
//   SquadStore/MemberStore 无状态封装，随用随建（与 bootstrap setResolveConfig 同模式）。
import { SquadStore, MemberStore } from '../stores/squad-store';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * GET /session/:id/debug/system-prompt（test gate）
 * 返回该 session 组装后的完整 system prompt 文本（供 AT 验证 L0 注入）。
 * 非 test 环境 → 404（避免生产暴露 prompt 内容）。
 */
export async function handleSessionDebugSystemPrompt(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  // test gate：APP_ENV=test 或 NODE_ENV=test
  if (process.env.APP_ENV !== 'test' && process.env.NODE_ENV !== 'test') {
    return json(404, { error: 'Not Found' });
  }
  if (method !== 'GET') return json(405, { error: 'Method Not Allowed' });

  // 取 session 持久值（getSession async）
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'Not Found' });

  // 构造 slim SessionKind + SessionContext（v0.0.204：与 bootstrap setResolveConfig 同模式）。
  const kind = new SessionKind({
    biz: got.biz ?? 'playground',
    role: got.role ?? 'rocky',
    derivation: got.derivation ?? 'parent',
  });
  const sessionContext = {
    ...(got.squadId !== undefined ? { squadId: got.squadId } : {}),
    ...(got.memberId !== undefined ? { memberId: got.memberId } : {}),
    ...(got.parentSessionId !== undefined ? { parentSessionId: got.parentSessionId } : {}),
  };
  let studioContext: StudioSessionContext | undefined;
  if (isStudioMainSession(kind)) {
    const squadStore = new SquadStore({ root: deps.dataDir });
    const memberStore = new MemberStore({ root: deps.dataDir });
    const squad = got.squadId ? await squadStore.getSquad(got.squadId) : undefined;
    const members = got.squadId ? await memberStore.listMembers(got.squadId) : [];
    const member = got.squadId && got.memberId
      ? await memberStore.getMember(got.squadId, got.memberId)
      : undefined;
    studioContext = {
      role: kind.role as 'squad' | 'leader' | 'mate',
      squadId: got.squadId!,
      ...(got.memberId !== undefined ? { memberId: got.memberId } : {}),
      ...(squad !== undefined ? { squad } : {}),
      ...(member !== undefined ? { member } : {}),
      ...(members.length > 0 ? { members } : {}),
    };
  }

  let config;
  try {
    // v0.0.158：签名瘦身——删 bodyOverride 与 task 参数（chat/compact 同链）
    config = buildSessionConfigFromDeps(
      deps,
      id,
      {
        providerId: got.providerId,
        modelId: got.modelId,
        // [v0.0.148] effort + approvalMode 透传（源头唯一 = session record）
        effort: got.effort,
        approvalMode: got.approvalMode,
      },
      kind,
      got.workspaceDir,
      // scope 从 derivation 派生
      got.derivation === 'subagent' ? 'subagent' : 'session',
      got.subAgentConfig,
      studioContext,
      sessionContext,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: `failed to build config: ${msg}` });
  }
  const pluginManager: PluginManager = deps.pluginManager;
  // builder 硬失败（mapper 链空 → throw）：debug 端点转 500 给清晰诊断
  // scopeId = kind canonicalId：debug 产出须与该 session 真实 system prompt 链一致
  //   （scope 决定 mapper 激活集；default scope 是错误预览）
  try {
    const text = await buildSystemPrompt(pluginManager, config, scopeIdOf(kind));
    return json(200, { sessionId: id, systemPrompt: text });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: `failed to build system prompt: ${msg}` });
  }
}
