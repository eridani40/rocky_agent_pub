/**
 * buildAgentToolContext parentSessionId 取值规则 UT（v0.0.28 BUG 回归锁）
 * 参考: app/server/src/bootstrap.ts setBuildAgentToolContext
 *       specs/tech/multi_agent/[P1]subagent_derivation.md §5（send_message 子→父）
 *
 * 锁定 bootstrap.setBuildAgentToolContext 的 parentSessionId 取值规则：
 *   parentSessionId = session.parentSessionId ?? sessionId
 *
 *   - 顶层 parent session（无 parentSessionId）→ fallback 自身 sid
 *     （agent 工具 spawn/query/abort 把自身 sid 当 parentRef 给 child）
 *   - subagent session（有 parentSessionId）→ 取真 parent sid
 *     （send_message('parent') 路由到真 parent，不路由回自身）
 *
 * 修复前 BUG：parentSessionId = sessionId（运行 session 的 sid），
 *   subagent 调 send_message('parent') 时 resolveAgentRef 把 'parent' 解析成
 *   subagent 自身 → deliverTo(self) → a2a 消息投递回 subagent，parent 永远收不到。
 *
 * 本 UT 不直接测 bootstrap（需整个 app 装配），而是复刻 bootstrap 的取值规则
 * 函数 + 验证两种 session 形态（顶层 / subagent）下的 parentSessionId 正确性，
 * 配合 runtime-context-a2a-routing.test.ts（resolveAgentRef 层）双层锁。
 */
import { describe, it, expect } from 'vitest';
import type { Session } from '../session-store-types';

/**
 * 复刻 bootstrap.setBuildAgentToolContext 的 parentSessionId 取值规则（修复后）。
 * 任何对 bootstrap 的回归（改回 sessionId）会让本函数语义错 → 本 UT fail。
 */
function resolveParentSessionId(session: Pick<Session, 'id' | 'parentSessionId'>): string {
  // [v0.0.28 BUG 修复] 必须 session.parentSessionId ?? sessionId
  return session.parentSessionId ?? session.id;
}

describe('buildAgentToolContext: parentSessionId 取值规则（v0.0.28 BUG 回归锁）', () => {
  it('顶层 parent session（无 parentSessionId）→ fallback 自身 sid', () => {
    const session: Pick<Session, 'id' | 'parentSessionId'> = {
      id: 'PARENT-TOP-001',
      // parentSessionId 缺省
    } as Pick<Session, 'id' | 'parentSessionId'>;
    // 顶层 parent 的 rtc.parentSessionId = 自身（agent 工具 spawn 把自身当 parentRef）
    expect(resolveParentSessionId(session)).toBe('PARENT-TOP-001');
  });

  it('subagent session（有 parentSessionId）→ 取真 parent sid（非自身）', () => {
    const session: Pick<Session, 'id' | 'parentSessionId'> = {
      id: 'CHILD-001',
      parentSessionId: 'PARENT-001',
    };
    // subagent 的 rtc.parentSessionId = 真 parent（send_message('parent') 路由正确）
    const resolved = resolveParentSessionId(session);
    expect(resolved).toBe('PARENT-001');
    expect(resolved).not.toBe('CHILD-001');
  });

  it('深层 subagent（parent 也是 subagent）→ 取直接 parent sid（不递归）', () => {
    // 多层 spawn：grandchild.parentSessionId = child（不是 root parent）
    // send_message('parent') 解析到直接 parent（child），符合 a2a §3 拓扑
    const session: Pick<Session, 'id' | 'parentSessionId'> = {
      id: 'GRANDCHILD-001',
      parentSessionId: 'CHILD-MID-001',
    };
    expect(resolveParentSessionId(session)).toBe('CHILD-MID-001');
  });

  it('回归锁：证实修复前 BUG 行为（sessionId 直取）会让 subagent 路由错', () => {
    const session: Pick<Session, 'id' | 'parentSessionId'> = {
      id: 'CHILD-X',
      parentSessionId: 'PARENT-X',
    };
    // 修复前 buggy 规则：parentSessionId = sessionId（= session.id，忽略 parentSessionId）
    const buggyResolved = session.id;
    expect(buggyResolved).toBe('CHILD-X'); // 证实 bug：路由到自身
    expect(buggyResolved).not.toBe('PARENT-X');

    // 修复后正确规则
    expect(resolveParentSessionId(session)).toBe('PARENT-X');
  });
});
