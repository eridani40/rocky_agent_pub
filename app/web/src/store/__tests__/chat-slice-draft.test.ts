// @vitest-environment node
/**
 * chat-slice 输入草稿缓存单测（v0.0.267 T1 store 层）
 * 参考: specs/tech/version_logs/v0.0.267/change_plan.md（DraftContent / drafts / saveDraft / clearDraft 行）
 *       specs/prd/version_logs/v0.0.267.input_draft_cache/prd.md §2.2/§3.1/§3.4（空草稿不写 / 值相同不 set / 发送后清除）
 *
 * 覆盖 acceptanceCriteria：
 *   - DraftContent = string（serializeEditorContent 序列化字符串形）
 *   - drafts: Record<string, DraftContent> 内存级（无 persist）
 *   - saveDraft 非空写不可变更新（spread 新建，原 drafts 不被 mutate）
 *   - saveDraft 空内容（!content.trim()）删 key 等价清除
 *   - saveDraft 值相同不 set（subscribe spy 断言不触发）
 *   - clearDraft 删 key；key 不存在 no-op 不 set（幂等）
 *   - 用 createChatSliceStore() 工厂独立实例（不碰 useChatStore 单例）
 */
import { describe, it, expect, vi } from 'vitest';
import { createChatSliceStore, type DraftContent } from '../chat-slice';

describe('chat-slice drafts 字段（v0.0.267）', () => {
  it('初始 drafts 为空对象（内存级，无 persist）', () => {
    const store = createChatSliceStore();
    expect(store.getState().drafts).toEqual({});
  });

  it('DraftContent 为 string 形（可存序列化文本 + 多行）', () => {
    // 类型层面 DraftContent = string；运行时可存多行序列化内容（\n 段落分隔）
    const draft: DraftContent = '第一行\n<mention data-address="agent-1"/> 你好';
    const store = createChatSliceStore();
    store.getState().saveDraft('s1', draft);
    expect(store.getState().drafts['s1']).toBe(draft);
    expect(typeof store.getState().drafts['s1']).toBe('string');
  });
});

describe('chat-slice saveDraft action（v0.0.267）', () => {
  it('saveDraft 非空写：drafts[sessionId] = content，其他 session 不动', () => {
    const store = createChatSliceStore();
    store.getState().saveDraft('s1', 'hello');
    store.getState().saveDraft('s2', 'world');
    expect(store.getState().drafts).toEqual({ s1: 'hello', s2: 'world' });
  });

  it('saveDraft 不可变更新：原 drafts 对象不被 mutate（spread 新建）', () => {
    const store = createChatSliceStore();
    store.getState().saveDraft('s1', 'a');
    const before = store.getState().drafts;
    store.getState().saveDraft('s2', 'b');
    // 原对象引用不变、内容不变；新状态是新对象
    expect(before.s1).toBe('a');
    expect(before.s2).toBeUndefined();
    expect(store.getState().drafts).not.toBe(before);
    expect(store.getState().drafts).toEqual({ s1: 'a', s2: 'b' });
  });

  it('saveDraft 值相同不 set：subscribe spy 不重复触发（幂等）', () => {
    const store = createChatSliceStore();
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    store.getState().saveDraft('s1', 'same');
    expect(spy).toHaveBeenCalledTimes(1);
    // 同值再写 → 不 set → 不触发订阅
    store.getState().saveDraft('s1', 'same');
    expect(spy).toHaveBeenCalledTimes(1);
    // 不同值 → set
    store.getState().saveDraft('s1', 'changed');
    expect(spy).toHaveBeenCalledTimes(2);
    unsub();
  });

  it('saveDraft 空内容（"" / 空白）→ 删 key 等价清除', () => {
    const store = createChatSliceStore();
    store.getState().saveDraft('s1', 'hello');
    store.getState().saveDraft('s1', '');
    expect(store.getState().drafts).toEqual({});
    // 空白串同样清除
    store.getState().saveDraft('s2', 'world');
    store.getState().saveDraft('s2', '   ');
    expect(store.getState().drafts).toEqual({});
  });

  it('saveDraft 空内容且 key 不存在 → no-op 不 set（幂等）', () => {
    const store = createChatSliceStore();
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    store.getState().saveDraft('not-exist', '');
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });
});

describe('chat-slice clearDraft action（v0.0.267）', () => {
  it('clearDraft 删 key：drafts 中该 session 消失，其他 session 保留', () => {
    const store = createChatSliceStore();
    store.getState().saveDraft('s1', 'a');
    store.getState().saveDraft('s2', 'b');
    store.getState().clearDraft('s1');
    expect(store.getState().drafts).toEqual({ s2: 'b' });
  });

  it('clearDraft 不可变更新：原 drafts 不被 mutate', () => {
    const store = createChatSliceStore();
    store.getState().saveDraft('s1', 'a');
    const before = store.getState().drafts;
    store.getState().clearDraft('s1');
    expect(before.s1).toBe('a');
    expect(store.getState().drafts).not.toBe(before);
    expect(store.getState().drafts).toEqual({});
  });

  it('clearDraft key 不存在 → no-op 不 set（幂等）', () => {
    const store = createChatSliceStore();
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    store.getState().clearDraft('not-exist');
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });

  it('clearDraft 重复调用幂等：第二次不 set', () => {
    const store = createChatSliceStore();
    store.getState().saveDraft('s1', 'a');
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    store.getState().clearDraft('s1');
    expect(spy).toHaveBeenCalledTimes(1);
    store.getState().clearDraft('s1');
    expect(spy).toHaveBeenCalledTimes(1);
    unsub();
  });
});
