/**
 * ChannelBindingStore 单测：双向索引 + 反向唯一 + 删除兜底
 * 参考: specs/tech/channel/[P0]channel_manager.md §3.4 / §3.8
 *       reqs/[done] v0.0.103.channel/design.md §3.2（D6 binding 双向唯一）
 *
 * 覆盖：
 *   1. upsert + get（正向）
 *   2. findBySession（反向）
 *   3. delete（正向）
 *   4. deleteBySession（反向删，孤儿清理）
 *   5. deleteByInstance（清该 config 全部 binding）
 *   6. rebuildReverseIndex（启动恢复反向索引）
 *   7. countByInstance（GET /config/channels 聚合用）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelBindingStore, bindingId } from '../channel-binding-store';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'channel-binding-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ChannelBindingStore', () => {
  it('upsert + get（正向查）', () => {
    const store = new ChannelBindingStore({ root: tmpRoot });
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1',
      conversationId: 'chat1',
      sessionId: 'sess1',
      boundBy: 'slash',
      boundAt: 1000,
    });
    const b = store.get('cfg1', 'chat1');
    expect(b).not.toBeNull();
    expect(b?.sessionId).toBe('sess1');
    expect(b?.boundBy).toBe('slash');
  });

  it('findBySession（反向查）', () => {
    const store = new ChannelBindingStore({ root: tmpRoot });
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1',
      conversationId: 'chat1',
      sessionId: 'sess1',
      boundBy: 'slash',
      boundAt: 1000,
    });
    const b = store.findBySession('sess1');
    expect(b?.configId).toBe('cfg1');
    expect(b?.conversationId).toBe('chat1');
    // 未绑返 null
    expect(store.findBySession('unknown')).toBeNull();
  });

  it('delete（正向删）', () => {
    const store = new ChannelBindingStore({ root: tmpRoot });
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1',
      conversationId: 'chat1',
      sessionId: 'sess1',
      boundBy: 'slash',
      boundAt: 1000,
    });
    store.delete('cfg1', 'chat1');
    expect(store.get('cfg1', 'chat1')).toBeNull();
    expect(store.findBySession('sess1')).toBeNull();
  });

  it('deleteBySession（反向删，孤儿清理；返被清的 (configId,conv) 列表）', () => {
    const store = new ChannelBindingStore({ root: tmpRoot });
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1', conversationId: 'chat1', sessionId: 'sess1',
      boundBy: 'slash', boundAt: 1000,
    });
    store.upsert({
      id: bindingId('cfg2', 'chat2'),
      configId: 'cfg2', conversationId: 'chat2', sessionId: 'sess2',
      boundBy: 'manual', boundAt: 2000,
    });
    const cleared = store.deleteBySession('sess1');
    expect(cleared).toEqual([{ configId: 'cfg1', conversationId: 'chat1' }]);
    expect(store.get('cfg1', 'chat1')).toBeNull();
    expect(store.findBySession('sess1')).toBeNull();
    // 其他 binding 不受影响
    expect(store.findBySession('sess2')).not.toBeNull();
  });

  it('deleteByInstance（清该 config 全部 binding；返被清 sessionId 列表）', () => {
    const store = new ChannelBindingStore({ root: tmpRoot });
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1', conversationId: 'chat1', sessionId: 'sess1',
      boundBy: 'slash', boundAt: 1000,
    });
    store.upsert({
      id: bindingId('cfg1', 'chat2'),
      configId: 'cfg1', conversationId: 'chat2', sessionId: 'sess2',
      boundBy: 'slash', boundAt: 2000,
    });
    store.upsert({
      id: bindingId('cfg2', 'chatX'),
      configId: 'cfg2', conversationId: 'chatX', sessionId: 'sess3',
      boundBy: 'slash', boundAt: 3000,
    });
    const cleared = store.deleteByInstance('cfg1');
    expect(cleared.sort()).toEqual(['sess1', 'sess2']);
    expect(store.get('cfg1', 'chat1')).toBeNull();
    expect(store.get('cfg1', 'chat2')).toBeNull();
    // cfg2 不受影响
    expect(store.get('cfg2', 'chatX')).not.toBeNull();
  });

  it('upsert 覆盖同 (configId,conv) 旧 sessionId 时清旧反向索引', () => {
    const store = new ChannelBindingStore({ root: tmpRoot });
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1', conversationId: 'chat1', sessionId: 'sess_old',
      boundBy: 'slash', boundAt: 1000,
    });
    // 同 (configId,conv) 换 sessionId（/bindp 覆盖）
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1', conversationId: 'chat1', sessionId: 'sess_new',
      boundBy: 'slash', boundAt: 2000,
    });
    expect(store.findBySession('sess_old')).toBeNull();
    expect(store.findBySession('sess_new')?.configId).toBe('cfg1');
  });

  it('countByInstance（GET list 聚合用）', () => {
    const store = new ChannelBindingStore({ root: tmpRoot });
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1', conversationId: 'chat1', sessionId: 's1',
      boundBy: 'slash', boundAt: 1000,
    });
    store.upsert({
      id: bindingId('cfg1', 'chat2'),
      configId: 'cfg1', conversationId: 'chat2', sessionId: 's2',
      boundBy: 'slash', boundAt: 2000,
    });
    expect(store.countByInstance('cfg1')).toBe(2);
    expect(store.countByInstance('cfg2')).toBe(0);
  });

  it('rebuildReverseIndex（重启后从盘恢复反向索引）', () => {
    // 先写一些 binding
    let store = new ChannelBindingStore({ root: tmpRoot });
    store.upsert({
      id: bindingId('cfg1', 'chat1'),
      configId: 'cfg1', conversationId: 'chat1', sessionId: 'sess1',
      boundBy: 'slash', boundAt: 1000,
    });
    store.upsert({
      id: bindingId('cfg2', 'chat2'),
      configId: 'cfg2', conversationId: 'chat2', sessionId: 'sess2',
      boundBy: 'manual', boundAt: 2000,
    });
    // 模拟重启：new 一个新的 store（同 root）
    store = new ChannelBindingStore({ root: tmpRoot });
    // rebuild 前反向索引为空
    expect(store.findBySession('sess1')).toBeNull();
    store.rebuildReverseIndex();
    // rebuild 后恢复
    expect(store.findBySession('sess1')?.configId).toBe('cfg1');
    expect(store.findBySession('sess2')?.configId).toBe('cfg2');
  });
});
