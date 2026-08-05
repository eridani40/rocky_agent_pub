/**
 * [v0.0.161] agent-loop user msg drain 时序 UT — msgId 单调递增不变量
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §6.4（msgId 分配契约）
 *       specs/tech/agent/message/[P0]agent_message_interface.md §7（drain 权威分配）
 *
 * 修复背景 & 断言目的：
 *   v0.0.161 之前 drainAndPartition 对 source=user 保留 entry.message.id（HTTP-in 时刻的
 *   throwaway ulid），与 agent/system/approval 分支「drain 时 reissue newId=ulid()」不对称。
 *   → user msgId 锚 HTTP-in 时钟，agent/tool msgId 锚 drain 时钟。当 HTTP-in 早于上一 run 末尾时，
 *   ULID 字典序排 transcript 时 user msg 位置错乱到"过去"（v0.0.173 前的旧 base_builder.appendNew
 *   集合 diff 逻辑会裁掉，v0.0.173 已删 appendNew 走永远 rebuild 后由 transcript 单调性根治），
 *   永久不进 LLM context（真实 prod bug）。
 *
 *   修复 A（对称化 reissue）从**源头**保证：drain 处理顺序 = msgId 顺序。本 UT 在集成层验证：
 *   两次独立 drain（每次一条 user msg）之间，reissue 出的 msgId **单调递增**——即使两条 user
 *   msg 的 throwaway id 是逆序（BB 早于 AA），drain 后的 newId 仍按调用顺序单调（drain 时钟）。
 *   这是修复 A 在真实 drain 路径生效的最小充分证据（drain-and-partition-sender.test.ts UT-1
 *   只测单次 drain 内三处 id 一致，本 UT 覆盖跨 drain 的时序不变量）。
 *
 *   进一步说明：不再假设 throwaway id 有序（旧实现下 user msg id = throwaway id → 保序靠
 *   HTTP-in 时钟单调；本修复后 drain-time ulid 保序不依赖 throwaway id 顺序）。故本 UT 特意
 *   构造 throwaway id 逆序（BB < AA 也无所谓）：只关心 reissue 后的 newId 单调。
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../../message/types';
import { drainAndPartition } from '../agent-loop-stage-pre';
import { InboxStore } from '../inbox';

function mkUserMsg(throwawayId: string): Message {
  return {
    id: throwawayId,
    sessionId: '01SIDV0161TEST00000000000',
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    sender: { source: 'user' },
  };
}

describe('[v0.0.161] agent-loop user msg drain — reissue 后 msgId 单调递增（drain 时钟）', () => {
  it('两次独立 drain 后 reissue 出的 user msgId 单调递增（跨 drain 时序不变量）', () => {
    const inbox = new InboxStore();
    const sid = '01SIDV0161TEST00000000000';

    // Round 1：enqueue user msg with throwaway id 'ZZ'（故意选个字典序大的，证明 drain 不看 throwaway）
    const throwaway1 = '01ZZUSERTHROWAWAY000000001';
    inbox.enqueue(sid, [mkUserMsg(throwaway1)]);
    const r1 = drainAndPartition(inbox, sid);
    expect(r1.userMessages).toHaveLength(1);
    const newId1 = r1.userMessages[0]!.message.id;
    // reissue 生效：newId1 不等于 throwaway1
    expect(newId1).not.toBe(throwaway1);
    // ulid 26 位
    expect(newId1.length).toBe(26);

    // Round 2：enqueue user msg with throwaway id 'AA'（字典序小于 ZZ；旧实现下 newMessages[0].id
    //   会保留 'AA'，故 newId2 = 'AA' < 'ZZ' = newId1，非单调）
    const throwaway2 = '01AAUSERTHROWAWAY000000002';
    inbox.enqueue(sid, [mkUserMsg(throwaway2)]);
    const r2 = drainAndPartition(inbox, sid);
    expect(r2.userMessages).toHaveLength(1);
    const newId2 = r2.userMessages[0]!.message.id;
    expect(newId2).not.toBe(throwaway2);

    // 关键断言：两次 drain 出的 newId 单调递增（drain 时钟顺序），
    //   与 throwaway id 顺序无关（本 UT throwaway2='01AA' < throwaway1='01ZZ' 逆序）
    expect(newId2 > newId1).toBe(true);
  });

  it('单批多条 user msg drain — 逐条 reissue，同批内 msgId 单调（drain 循环内 ulid 递增）', () => {
    // 补充覆盖：同批多条也保持单调（inbox 保序 + drain 循环内 ulid 时钟单调）
    const inbox = new InboxStore();
    const sid = '01SIDV0161BATCH0000000000';
    // 三条 user msg，throwaway id 故意逆序
    inbox.enqueue(sid, [
      mkUserMsg('01ZZ01'),
      mkUserMsg('01MM01'),
      mkUserMsg('01AA01'),
    ]);

    const result = drainAndPartition(inbox, sid);
    expect(result.userMessages).toHaveLength(3);
    const ids = result.userMessages.map((u) => u.message.id);
    // 全部被 reissue
    for (const id of ids) {
      expect(id.length).toBe(26);
    }
    // 严格单调递增（drain 循环内每次调 ulid() 时钟递增）
    expect(ids[1]! > ids[0]!).toBe(true);
    expect(ids[2]! > ids[1]!).toBe(true);
  });
});
