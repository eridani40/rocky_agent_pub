/**
 * in_memory_session_store — per-run 隔离 UT（v0.0.83.forked_per_run_isolation）
 * 参考: reqs/[working] v0.0.83.forked_per_run_isolation/req.md（第一性原则）
 *       states/v0.0.83.forked_per_run_isolation/change_plan.md §1/§4/§6
 *
 * 验证（fix 的核心证明）：
 *   - 同 sid 不同 runId 的两 forked run（summary / memory_extract sibling）→ buffer 物理隔离，零消息交叉
 *     （修前 v0.0.66 按 sid 分桶 → sibling 共享 → SUMMARY trace messages[12] 含 3 套矛盾指令）
 *   - releaseSlot 按 runId 释放：只清该 run 的 buffer，sibling 不受影响（回收 + 隔离）
 *   - 无 opts（runId 缺省）→ 按 sid 分桶（向后兼容 default/UT 路径）
 *   - releaseSlot 幂等
 *
 * 注：SESSION_STORES 是模块级 Map（跨 test 共享），故每 test 用唯一 sid/runId 避免交叉污染。
 */
import { describe, it, expect } from 'vitest';
import InMemorySessionStore from '../store/in_memory_session_store';
import type { Message, MessageInput } from '../../../../server/src/message/types';

function mkMsg(id: string, sid: string, role: 'user' | 'assistant' | 'system', text: string): Message {
  return {
    id,
    sessionId: sid,
    role,
    content: [{ type: 'text', text }],
  } as Message;
}

describe('[v0.0.83] in_memory_session_store per-run 隔离', () => {
  it('同 sid 不同 runId → buffer 物理隔离（sibling 不混）', async () => {
    const store = new InMemorySessionStore('in_memory_session_store', {});
    const sid = 'sess-isolation-1';

    // summary sibling run 写入
    await store.appendMessages(
      sid,
      [mkMsg('m-summary', sid, 'user', 'SUMMARY_DIRECTIVE')] as MessageInput[],
      { runId: 'run-summary' },
    );
    // memory_extract sibling run（同 sid，不同 runId）写入
    await store.appendMessages(
      sid,
      [mkMsg('m-extract', sid, 'user', 'EXTRACT_DIRECTIVE')] as MessageInput[],
      { runId: 'run-extract' },
    );

    // 各自只见到自己的消息——零交叉（修前共享 sid 桶会同时见两条）
    const summaryPage = await store.getMessages(sid, { limit: 100 }, { runId: 'run-summary' });
    const extractPage = await store.getMessages(sid, { limit: 100 }, { runId: 'run-extract' });

    expect(summaryPage.items.map((m) => m.id)).toEqual(['m-summary']);
    expect(extractPage.items.map((m) => m.id)).toEqual(['m-extract']);
    // 负向断言：summary 桶不含 extract 指令（修前的 bug——三套矛盾指令同桶）
    expect(summaryPage.items.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('EXTRACT')))).toBe(false);
  });

  it('多轮 append 同 runId → 同桶累积（per-run 累积正确）', async () => {
    const store = new InMemorySessionStore('in_memory_session_store', {});
    const sid = 'sess-accumulate-1';
    await store.appendMessages(sid, [mkMsg('m1', sid, 'user', 'q')] as MessageInput[], { runId: 'run-A' });
    await store.appendMessages(sid, [mkMsg('m2', sid, 'assistant', 'a')] as MessageInput[], { runId: 'run-A' });

    const page = await store.getMessages(sid, { limit: 100 }, { runId: 'run-A' });
    expect(page.items.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('releaseSlot(sid, {runId}) 只释放该 run 的 buffer（sibling 不受影响）', async () => {
    const store = new InMemorySessionStore('in_memory_session_store', {});
    const sid = 'sess-release-1';
    // runId 全局唯一（模块级 Map 跨 test 共享，避免与其他 test 桶碰撞）
    await store.appendMessages(sid, [mkMsg('m-s-rel', sid, 'user', 's')] as MessageInput[], { runId: 'run-summary-rel' });
    await store.appendMessages(sid, [mkMsg('m-e-rel', sid, 'user', 'e')] as MessageInput[], { runId: 'run-extract-rel' });

    // 回收 summary run 的桶
    await store.releaseSlot(sid, { runId: 'run-summary-rel' });

    // summary 桶已空
    const summaryPage = await store.getMessages(sid, { limit: 100 }, { runId: 'run-summary-rel' });
    expect(summaryPage.items).toEqual([]);
    // extract sibling 桶不受影响（回收不误伤 sibling——per-run 隔离的关键）
    const extractPage = await store.getMessages(sid, { limit: 100 }, { runId: 'run-extract-rel' });
    expect(extractPage.items.map((m) => m.id)).toEqual(['m-e-rel']);
  });

  it('无 opts（runId 缺省）→ 按 sid 分桶（向后兼容 default/UT 路径）', async () => {
    const store = new InMemorySessionStore('in_memory_session_store', {});
    const sid = 'sess-noid-1';
    // 不传 opts（default 路径 / 旧调用方）—— 按 sid 分桶
    await store.appendMessages(sid, [mkMsg('m1', sid, 'user', 'q')] as MessageInput[]);
    const page = await store.getMessages(sid, { limit: 100 });
    expect(page.items.map((m) => m.id)).toEqual(['m1']);
    // releaseSlot 不传 opts 亦按 sid
    await store.releaseSlot(sid);
    const after = await store.getMessages(sid, { limit: 100 });
    expect(after.items).toEqual([]);
  });

  it('releaseSlot 幂等（重复释放不抛错）', async () => {
    const store = new InMemorySessionStore('in_memory_session_store', {});
    const sid = 'sess-idem-1';
    await store.appendMessages(sid, [mkMsg('m1', sid, 'user', 'q')] as MessageInput[], { runId: 'run-X' });
    await store.releaseSlot(sid, { runId: 'run-X' });
    await expect(store.releaseSlot(sid, { runId: 'run-X' })).resolves.toBeUndefined();
    await expect(store.releaseSlot(sid, { runId: 'never-existed' })).resolves.toBeUndefined();
  });

  it('session-meta 方法与 run 无关：getSummary 恒 null / getRatio 恒 1.0 / updateUsage no-op', async () => {
    const store = new InMemorySessionStore('in_memory_session_store', {});
    const sid = 'sess-meta-1';
    await store.appendMessages(sid, [mkMsg('m1', sid, 'user', 'q')] as MessageInput[], { runId: 'run-M' });
    // 这三个方法不接受 opts（session-meta，与 run 无关），行为恒定
    expect(await store.getSummary(sid)).toBeNull();
    expect(await store.getRatio(sid)).toBe(1.0);
    await expect(store.updateUsage(sid, {
      contextWindowUsage: {
        systemTokens: 0, messageTokens: 0, toolTokens: 0,
        totalTokens: 0, maxOutputTokens: 0, tokenLimit: 100000, remainingTokens: 100000,
      } as never,
    })).resolves.toBeUndefined();
    // meta 操作不影响 buffer 桶
    const page = await store.getMessages(sid, { limit: 100 }, { runId: 'run-M' });
    expect(page.items.length).toBe(1);
  });
});
