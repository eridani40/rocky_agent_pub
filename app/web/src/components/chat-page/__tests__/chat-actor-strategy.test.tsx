/**
 * @vitest-environment jsdom
 * chat-actor-strategy 单测 —— 渲染策略谓词/actor/side + deriveRenderStrategy
 * 参考: specs/tech/app/frontend/[P0]chat_session_assembly.md §4（群聊渲染策略链路）
 *       specs/ui/components/chat-page/section-chat-session.md（groupRender 门控矩阵行）
 *
 * [v0.0.216] 自 studio-page/__tests__/squad-chat-helpers.test.ts 随迁（模块迁 chat-page；
 * resolveMemberActorFactory 参数窄化为 {name, role}）+ 新增 deriveRenderStrategy 数据驱动派生用例。
 *
 * 覆盖：
 *   - memberSideResolver：a2a inbox → 'user'（右）；user/assistant/tool → 默认 sideOfMessage
 *   - resolveMemberActorFactory：a2a inbox 头像/名字取 ref（非 peer）；user→you；assistant→peer
 *   - deriveRenderStrategy：groupRender→群聊策略；memberId→单聊策略；缺省→空策略
 */
import { describe, it, expect } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import type { Message } from '../types';
import type { SessionChromeView } from '../../../lib/chat-api';
import {
  memberSideResolver,
  resolveMemberActorFactory,
  resolveGroupActor,
  groupMessageFilter,
  deriveRenderStrategy,
} from '../chat-actor-strategy';
import { sideOfMessage } from '../component-message-stream';

/** 构造 mock message（宽松 sender 支持 agent.ref.{type,name}） */
function mkMsg(over: Omit<Partial<Message>, 'sender'> & { id: string; role?: Message['role']; sender?: unknown }): Message {
  const base = {
    id: over.id,
    sessionId: 'sess-x',
    role: over.role ?? 'user',
    content: over.content ?? [{ type: 'text', text: over.id + '-text' }],
    createdAt: '2026-06-29T00:00:00.000Z',
    sender: over.sender,
  } as unknown as Message;
  return { ...base, ...over } as Message;
}

/** a2a inbox 消息夹具 */
function mkA2a(id: string, refType: string, refName: string): Message {
  return mkMsg({
    id,
    role: 'user',
    sender: {
      source: 'agent',
      agent: { ref: { type: refType, name: refName, sessionId: 's-' + refName }, needReply: false },
    },
  });
}

/** 从 actor 返回的 avatar ReactNode 取 MemberAvatar 的 props（name/role） */
function avatarProps(avatar: unknown): { name: string; role: string } {
  if (!isValidElement(avatar)) throw new Error('avatar 不是合法 React element');
  const el = avatar as ReactElement<{ name: string; role: string }>;
  return { name: el.props.name, role: el.props.role };
}

describe('memberSideResolver（单聊 a2a→右，随迁）', () => {
  it('a2a inbox（leader/mate/subagent 来源）→ "user"（右，与 user 同侧，type-agnostic）', () => {
    expect(memberSideResolver(mkA2a('a2a-1', 'leader', 'captain'))).toBe('user');
    expect(memberSideResolver(mkA2a('a2a-2', 'mate', 'worker'))).toBe('user');
    expect(memberSideResolver(mkA2a('a2a-3', 'subagent', 'explorer-1'))).toBe('user');
  });

  it('human user（source=user）→ "user"；assistant/tool → "assistant"（默认 sideOfMessage）', () => {
    expect(memberSideResolver(mkMsg({ id: 'u1', role: 'user', sender: { source: 'user' } }))).toBe('user');
    expect(memberSideResolver(mkMsg({ id: 'as1', role: 'assistant', content: [{ type: 'text', text: 'r' }] }))).toBe('assistant');
    expect(
      memberSideResolver(
        mkMsg({ id: 't1', role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: [], isError: false }] }),
      ),
    ).toBe('assistant');
  });

  it('边界：source=agent 但无 agent.ref → 非 a2a inbox，默认 sideOfMessage 归 "assistant"（左）', () => {
    const m = mkMsg({ id: 'edge-1', role: 'user', sender: { source: 'agent' } });
    expect(memberSideResolver(m)).toBe('assistant');
  });

  it('对照群聊：a2a inbox 默认 sideOfMessage→"assistant"（群聊不传 sideResolver 的原因）', () => {
    const a2a = mkA2a('diff-1', 'leader', 'captain');
    expect(memberSideResolver(a2a)).toBe('user');
    expect(sideOfMessage(a2a)).toBe('assistant');
  });
});

describe('resolveMemberActorFactory（参数窄化 {name, role}；a2a 头像/名字取 ref 非 peer）', () => {
  const peerB = { name: 'b', role: 'mate' };

  it('a2a inbox（ref.type=mate, name=alice）→ avatar 名字=alice（非 peer.name=b）', () => {
    const factory = resolveMemberActorFactory(peerB);
    const props = avatarProps(factory(mkA2a('a2a-alice', 'mate', 'alice')).avatar);
    expect(props.name).toBe('alice');
    expect(props.role).toBe('mate');
  });

  it('a2a inbox（ref.type=leader）→ role=leader；subagent → 兜底 mate', () => {
    const factory = resolveMemberActorFactory(peerB);
    expect(avatarProps(factory(mkA2a('a2a-cap', 'leader', 'captain')).avatar)).toEqual({ name: 'captain', role: 'leader' });
    expect(avatarProps(factory(mkA2a('a2a-sub', 'subagent', 'explorer')).avatar)).toEqual({ name: 'explorer', role: 'mate' });
  });

  it('human user → you/user；assistant answer → peer.name/peer.role', () => {
    const factory = resolveMemberActorFactory(peerB);
    expect(avatarProps(factory(mkMsg({ id: 'u1', role: 'user', sender: { source: 'user' } })).avatar)).toEqual({
      name: 'you',
      role: 'user',
    });
    expect(avatarProps(factory(mkMsg({ id: 'as1', role: 'assistant', content: [{ type: 'text', text: 'r' }] })).avatar)).toEqual({
      name: 'b',
      role: 'mate',
    });
  });

  it('peer.role=leader → assistant answer 用 leader 配色', () => {
    const factory = resolveMemberActorFactory({ name: 'cap', role: 'leader' });
    expect(avatarProps(factory(mkMsg({ id: 'as2', role: 'assistant', content: [{ type: 'text', text: 'r' }] })).avatar)).toEqual({
      name: 'cap',
      role: 'leader',
    });
  });

  it('单聊无 showNameAsPrefix（与群聊 a2a 前缀行区别）', () => {
    const factory = resolveMemberActorFactory(peerB);
    const result = factory(mkA2a('a2a-noprefix', 'mate', 'alice'));
    expect((result as { showNameAsPrefix?: boolean }).showNameAsPrefix).toBeUndefined();
  });
});

describe('deriveRenderStrategy（chrome 数据驱动，零 kind 分支）', () => {
  /** 最小 chrome 夹具 */
  function mkChrome(over: Partial<SessionChromeView>): SessionChromeView {
    return {
      sessionId: 's1',
      kind: 'playground',
      readOnly: false,
      title: 't',
      titled: false,
      tag: '',
      sessionModel: null,
      defaultModel: null,
      effort: null,
      approvalMode: null,
      members: [],
      memberId: null,
      capabilities: {
        runState: true, hitl: true, enqueue: true, effortPicker: true, approvalPicker: true,
        usage: true, compact: true, clear: true, minimap: true, floatMenu: true, cron: true,
        groupRender: false,
      },
      ...over,
    };
  }

  it('groupRender=true → 群聊策略（filter=groupMessageFilter + actor=resolveGroupActor，无 sideResolver）', () => {
    const chrome = mkChrome({});
    chrome.capabilities.groupRender = true;
    const s = deriveRenderStrategy(chrome);
    expect(s.messageFilter).toBe(groupMessageFilter);
    expect(s.resolveActor).toBe(resolveGroupActor);
    expect(s.sideResolver).toBeUndefined();
  });

  it('memberId 非空且对端在 members → 单聊策略（对端 actor + memberSideResolver，无 filter）', () => {
    const chrome = mkChrome({
      memberId: 'm1',
      members: [
        { id: 'm1', name: 'alice', role: 'leader' },
        { id: 'm2', name: 'bob', role: 'mate' },
      ],
    });
    const s = deriveRenderStrategy(chrome);
    expect(s.messageFilter).toBeUndefined();
    expect(s.sideResolver).toBe(memberSideResolver);
    // actor 用对端 alice/leader（assistant answer 走 peer 头像）
    const props = avatarProps(s.resolveActor!(mkMsg({ id: 'as', role: 'assistant', content: [{ type: 'text', text: 'r' }] })).avatar);
    expect(props).toEqual({ name: 'alice', role: 'leader' });
  });

  it('memberId 非空但 members 无匹配（数据不一致）→ 空策略兜底（默认渲染）', () => {
    const chrome = mkChrome({ memberId: 'ghost', members: [{ id: 'm1', name: 'alice', role: 'leader' }] });
    const s = deriveRenderStrategy(chrome);
    expect(s.messageFilter).toBeUndefined();
    expect(s.resolveActor).toBeUndefined();
    expect(s.sideResolver).toBeUndefined();
  });

  it('playground/academy 形态（memberId=null + groupRender=false）→ 空策略（默认渲染）', () => {
    const s = deriveRenderStrategy(mkChrome({}));
    expect(s).toEqual({});
  });

  it('群聊白名单：human user + a2a inbox 通过，assistant/tool 被滤', () => {
    expect(groupMessageFilter(mkMsg({ id: 'u', role: 'user', sender: { source: 'user' } }))).toBe(true);
    expect(groupMessageFilter(mkA2a('a', 'mate', 'alice'))).toBe(true);
    expect(groupMessageFilter(mkMsg({ id: 'as', role: 'assistant', content: [{ type: 'text', text: 'r' }] }))).toBe(false);
    expect(
      groupMessageFilter(
        mkMsg({ id: 't', role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c', content: [], isError: false }] }),
      ),
    ).toBe(false);
  });
});
