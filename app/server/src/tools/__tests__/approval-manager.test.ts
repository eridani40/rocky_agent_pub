/**
 * ApprovalManager UT — cache-through 持久化 + sessionId 隔离 + 向后兼容
 * 参考: specs/tech/agent/tools/[P0]tool_permission.md §5
 *       specs/tech/version_logs/v0.0.148/change_plan.md 链路 C（纠正 v0.0.122 D2）
 *
 * 校验点：
 *   - isApproved/recordAlways 按 (sessionId, key) 记忆（async）
 *   - sessionId 隔离（A 记不影响 B）
 *   - store unwired（undefined）向后兼容（UT 隔离）
 *   - cache-through：cache hit 不读 store / miss 读 store 填 cache / recordAlways write-through
 *   - approvalManager 单例可从模块直接 import
 */
import { describe, it, expect, vi } from 'vitest';
import { ApprovalManager, approvalManager, type ApprovalStorePort } from '../approval-manager';

/** 构造 mock ApprovalStorePort（vi.fn 跟踪调用） */
function mkMockStore(opts: {
  keys?: Record<string, string[]>;
} = {}): ApprovalStorePort & { getMock: ReturnType<typeof vi.fn>; addMock: ReturnType<typeof vi.fn> } {
  const data: Record<string, string[]> = { ...opts.keys };
  const getMock = vi.fn(async (sid: string) => [...(data[sid] ?? [])]);
  const addMock = vi.fn(async (sid: string, key: string) => {
    const existing = data[sid] ?? [];
    data[sid] = Array.from(new Set([...existing, key]));
  });
  return {
    getAlwaysApprovedKeys: getMock,
    addAlwaysApprovedKey: addMock,
    getMock,
    addMock,
  };
}

describe('ApprovalManager — 基础记忆行为（async）', () => {
  it('记录前 isApproved 返 false（初始状态：任何 key 均未批准）', async () => {
    const mgr = new ApprovalManager();
    expect(await mgr.isApproved('session-a', 'bash:rm-wildcard')).toBe(false);
    expect(await mgr.isApproved('', 'bash:rm-wildcard')).toBe(false);
  });

  it('recordAlways 后 isApproved 返 true（记忆生效）', async () => {
    const mgr = new ApprovalManager();
    await mgr.recordAlways('session-a', 'bash:rm-wildcard');
    expect(await mgr.isApproved('session-a', 'bash:rm-wildcard')).toBe(true);
  });

  it('同一会话多个 key 互相独立（记录 A key 不影响 B key）', async () => {
    const mgr = new ApprovalManager();
    await mgr.recordAlways('session-a', 'bash:rm-wildcard');
    expect(await mgr.isApproved('session-a', 'bash:custom-1')).toBe(false);
    expect(await mgr.isApproved('session-a', 'bash:rm-wildcard')).toBe(true);
  });

  it('recordAlways 幂等（重复记录同一 key 不报错，isApproved 仍 true）', async () => {
    const mgr = new ApprovalManager();
    await mgr.recordAlways('session-a', 'bash:rm-wildcard');
    await mgr.recordAlways('session-a', 'bash:rm-wildcard');
    expect(await mgr.isApproved('session-a', 'bash:rm-wildcard')).toBe(true);
  });
});

describe('ApprovalManager — sessionId 隔离（INV-P6）', () => {
  it('会话 A 记录不影响会话 B', async () => {
    const mgr = new ApprovalManager();
    await mgr.recordAlways('session-a', 'bash:rm-wildcard');
    expect(await mgr.isApproved('session-a', 'bash:rm-wildcard')).toBe(true);
    expect(await mgr.isApproved('session-b', 'bash:rm-wildcard')).toBe(false);
  });

  it('不同会话可独立记录各自的 key（互不影响）', async () => {
    const mgr = new ApprovalManager();
    await mgr.recordAlways('session-a', 'bash:rm-wildcard');
    await mgr.recordAlways('session-b', 'bash:custom-1');
    expect(await mgr.isApproved('session-a', 'bash:rm-wildcard')).toBe(true);
    expect(await mgr.isApproved('session-a', 'bash:custom-1')).toBe(false);
    expect(await mgr.isApproved('session-b', 'bash:custom-1')).toBe(true);
    expect(await mgr.isApproved('session-b', 'bash:rm-wildcard')).toBe(false);
  });

  it('空 sessionId 与非空 sessionId 隔离', async () => {
    const mgr = new ApprovalManager();
    await mgr.recordAlways('', 'bash:rm-wildcard');
    expect(await mgr.isApproved('', 'bash:rm-wildcard')).toBe(true);
    expect(await mgr.isApproved('session-a', 'bash:rm-wildcard')).toBe(false);
  });
});

describe('ApprovalManager — store unwired 向后兼容（UT 隔离）', () => {
  it('无 store 时 isApproved miss 返 false（不抛错）', async () => {
    const mgr = new ApprovalManager(); // 未调 setStore
    expect(await mgr.isApproved('s1', 'k1')).toBe(false);
  });

  it('无 store 时 recordAlways 不抛错（仅更新 cache）', async () => {
    const mgr = new ApprovalManager();
    await mgr.recordAlways('s1', 'k1');
    expect(await mgr.isApproved('s1', 'k1')).toBe(true);
  });
});

describe('ApprovalManager — cache-through 持久化（ApprovalStorePort）', () => {
  it('cache miss + store wired → 读 store 填 cache 后判定', async () => {
    const store = mkMockStore({ keys: { 's1': ['bash:rm-wildcard'] } });
    const mgr = new ApprovalManager();
    mgr.setStore(store);

    // cache miss：从 store 读到 key
    expect(await mgr.isApproved('s1', 'bash:rm-wildcard')).toBe(true);
    expect(store.getMock).toHaveBeenCalledWith('s1');
    // cache miss 读到空 key → false
    expect(await mgr.isApproved('s1', 'bash:custom-1')).toBe(false);
  });

  it('cache hit → 不读 store（热路径 cache 优先）', async () => {
    const store = mkMockStore({ keys: { 's1': ['bash:rm-wildcard'] } });
    const mgr = new ApprovalManager();
    mgr.setStore(store);

    // 首次：cache miss 读 store 填 cache
    await mgr.isApproved('s1', 'bash:rm-wildcard');
    expect(store.getMock).toHaveBeenCalledTimes(1);

    // 第二次：cache hit 不读 store
    await mgr.isApproved('s1', 'bash:rm-wildcard');
    expect(store.getMock).toHaveBeenCalledTimes(1); // 仍只调了 1 次
  });

  it('recordAlways → 先更 cache（立即可见）+ write-through store', async () => {
    const store = mkMockStore({ keys: { 's1': [] } });
    const mgr = new ApprovalManager();
    mgr.setStore(store);

    await mgr.recordAlways('s1', 'bash:rm-wildcard');
    // cache 立即生效（不等 store 读）
    expect(await mgr.isApproved('s1', 'bash:rm-wildcard')).toBe(true);
    // store write-through 被调
    expect(store.addMock).toHaveBeenCalledWith('s1', 'bash:rm-wildcard');
  });

  it('recordAlways 去重（Set 语义，重复 key 不重复写 store 的同值）', async () => {
    const store = mkMockStore({ keys: { 's1': [] } });
    const mgr = new ApprovalManager();
    mgr.setStore(store);

    await mgr.recordAlways('s1', 'bash:rm-wildcard');
    await mgr.recordAlways('s1', 'bash:rm-wildcard'); // 重复
    expect(await mgr.isApproved('s1', 'bash:rm-wildcard')).toBe(true);
    // addAlwaysApprovedKey 被调 2 次（cache 去重在 store 层 merge；port 协议是追加单 key）
    expect(store.addMock).toHaveBeenCalledTimes(2);
  });

  it('per-session 隔离：不同 sid 读各自 store 值', async () => {
    const store = mkMockStore({ keys: { 's1': ['k1'], 's2': ['k2'] } });
    const mgr = new ApprovalManager();
    mgr.setStore(store);

    expect(await mgr.isApproved('s1', 'k1')).toBe(true);
    expect(await mgr.isApproved('s1', 'k2')).toBe(false);
    expect(await mgr.isApproved('s2', 'k2')).toBe(true);
    expect(await mgr.isApproved('s2', 'k1')).toBe(false);
  });

  it('cache miss + store session 不存在 → 返 [] → false', async () => {
    const store = mkMockStore({ keys: {} }); // session 不存在
    const mgr = new ApprovalManager();
    mgr.setStore(store);
    expect(await mgr.isApproved('unknown-sid', 'any-key')).toBe(false);
  });
});

describe('ApprovalManager — 进程级单例', () => {
  it('模块导出的 approvalManager 是 ApprovalManager 实例', () => {
    expect(approvalManager).toBeInstanceOf(ApprovalManager);
  });

  it('fresh ApprovalManager 与单例独立（UT 注入 fresh 实例不污染单例）', async () => {
    const fresh = new ApprovalManager();
    await fresh.recordAlways('session-x', 'bash:rm-wildcard');
    expect(await fresh.isApproved('session-x', 'bash:rm-wildcard')).toBe(true);
    expect(fresh).not.toBe(approvalManager);
  });
});
