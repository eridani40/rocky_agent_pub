/**
 * @vitest-environment jsdom
 * chat-actor-strategy 单测 —— 渲染策略谓词/actor/side + deriveRenderStrategy
 * 参考: specs/tech/app/frontend/[P0]chat_session_assembly.md §4（群聊渲染策略链路）
 *       specs/ui/components/chat-page/section-chat-session.md（groupRender 门控矩阵行）
 *
 * [v0.0.216] 自 studio-page/__tests__/squad-chat-helpers.test.ts 随迁（模块迁 chat-page；
 * resolveMemberActorFactory 参数窄化为 {name, role}）+ 新增 deriveRenderStrategy 数据驱动派生用例。
 * [v0.0.295] a2a 消息从右侧（user）改回左侧（assistant），与群聊行为对齐；
 *   resolveMemberActorFactory a2a 返回加 showNameAsPrefix=true。
 * [v0.0.301] a2a inbox avatar=null（信封行左侧无头像）；name/showNameAsPrefix 保留。
 *
 * 覆盖：
 *   - memberSideResolver：a2a inbox → 'assistant'（左，v0.0.295）；user→右；assistant/tool→左
 *   - resolveMemberActorFactory：a2a inbox avatar=null + 名字取 ref + showNameAsPrefix=true（v0.0.301）
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
  a2aRefOf,
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
function mkA2a(id: string, refType: string, refName: string, refSessionId?: string): Message {
  return mkMsg({
    id,
    role: 'user',
    sender: {
      source: 'agent',
      agent: { ref: { type: refType, name: refName, sessionId: refSessionId ?? 's-' + refName }, needReply: false },
    },
  });
}

/** 从 actor 返回的 avatar ReactNode 取 MemberAvatar 的 props（name/role/id） */
function avatarProps(avatar: unknown): { name: string; role: string; id?: string } {
  if (!isValidElement(avatar)) throw new Error('avatar 不是合法 React element');
  const el = avatar as ReactElement<{ name: string; role: string; id?: string }>;
  return { name: el.props.name, role: el.props.role, id: el.props.id };
}

/** [v0.0.301] 从 a2a invisible 头像取内部 MemberAvatar props：外层 div 必须含 invisible（保真布局） */
function avatarMemberProps(avatar: unknown): { name: string; role: string; id?: string } {
  if (!isValidElement(avatar)) throw new Error('avatar 不是合法 React element');
  const wrapper = avatar as ReactElement<{ className?: string; children?: unknown }>;
  expect(wrapper.type).toBe('div');
  expect(wrapper.props.className).toContain('invisible');
  expect(wrapper.props.className).toContain('w-9');
  expect(wrapper.props.className).toContain('shrink-0');
  const inner = wrapper.props.children;
  if (!isValidElement(inner)) throw new Error('avatar 内部不是合法 React element（应为 MemberAvatar）');
  return avatarProps(inner);
}

describe('memberSideResolver（v0.0.295: a2a→左，与群聊对齐）', () => {
  it('a2a inbox（leader/mate/subagent 来源）→ "assistant"（左，type-agnostic）', () => {
    expect(memberSideResolver(mkA2a('a2a-1', 'leader', 'captain'))).toBe('assistant');
    expect(memberSideResolver(mkA2a('a2a-2', 'mate', 'worker'))).toBe('assistant');
    expect(memberSideResolver(mkA2a('a2a-3', 'subagent', 'explorer-1'))).toBe('assistant');
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

  it('对照群聊：a2a inbox memberSideResolver==sideOfMessage（单聊 v0.0.295 对齐群聊）', () => {
    const a2a = mkA2a('diff-1', 'leader', 'captain');
    expect(memberSideResolver(a2a)).toBe('assistant');
    expect(sideOfMessage(a2a)).toBe('assistant');
  });
});

describe('resolveMemberActorFactory（参数含 id；[v0.0.301] a2a 原对象 invisible、名字取 ref 非 peer）', () => {
  const peerB = { name: 'b', role: 'mate', id: 'peer-b-id' };

  it('[v0.0.301] a2a inbox（ref.type=mate, name=alice）→ avatar 为原 MemberAvatar invisible（外层 div 含 invisible，内部 MemberAvatar name=alice/role=mate/id=sess-alice），name=ref.name（非 peer.name=b）', () => {
    const factory = resolveMemberActorFactory(peerB);
    const result = factory(mkA2a('a2a-alice', 'mate', 'alice', 'sess-alice'));
    expect(avatarMemberProps(result.avatar)).toEqual({ name: 'alice', role: 'mate', id: 'sess-alice' });
    expect(result.name).toBe('alice');
  });

  it('[v0.0.301] a2a inbox（ref.type=leader → role=leader；subagent → 兜底 mate）→ 均原 MemberAvatar invisible', () => {
    const factory = resolveMemberActorFactory(peerB);
    expect(avatarMemberProps(factory(mkA2a('a2a-cap', 'leader', 'captain', 'sess-cap')).avatar)).toEqual({ name: 'captain', role: 'leader', id: 'sess-cap' });
    expect(avatarMemberProps(factory(mkA2a('a2a-sub', 'subagent', 'explorer', 'sess-sub')).avatar)).toEqual({ name: 'explorer', role: 'mate', id: 'sess-sub' });
  });

  it('human user → you/user（无 id）；assistant answer → peer.name/peer.role/id（零回归）', () => {
    const factory = resolveMemberActorFactory(peerB);
    const userProps = avatarProps(factory(mkMsg({ id: 'u1', role: 'user', sender: { source: 'user' } })).avatar);
    expect(userProps.name).toBe('you');
    expect(userProps.role).toBe('user');
    expect(userProps.id).toBeUndefined();
    const asProps = avatarProps(factory(mkMsg({ id: 'as1', role: 'assistant', content: [{ type: 'text', text: 'r' }] })).avatar);
    expect(asProps.name).toBe('b');
    expect(asProps.role).toBe('mate');
    expect(asProps.id).toBe('peer-b-id');
  });

  it('peer.role=leader → assistant answer 用 leader 配色 + peer.id', () => {
    const factory = resolveMemberActorFactory({ name: 'cap', role: 'leader', id: 'cap-id' });
    const props = avatarProps(factory(mkMsg({ id: 'as2', role: 'assistant', content: [{ type: 'text', text: 'r' }] })).avatar);
    expect(props.name).toBe('cap');
    expect(props.role).toBe('leader');
    expect(props.id).toBe('cap-id');
  });

  it('v0.0.295: a2a 返回 showNameAsPrefix=true（信封旁显示发送方名字）', () => {
    const factory = resolveMemberActorFactory(peerB);
    const result = factory(mkA2a('a2a-prefix', 'mate', 'alice'));
    expect((result as { showNameAsPrefix?: boolean }).showNameAsPrefix).toBe(true);
  });
});

describe('a2aRefOf（v0.0.297: 返回含 sessionId）', () => {
  it('a2a inbox 消息 → 返回 type/name/sessionId', () => {
    const ref = a2aRefOf(mkA2a('a2a-1', 'mate', 'alice', 'sess-alice-001'));
    expect(ref).toEqual({ type: 'mate', name: 'alice', sessionId: 'sess-alice-001' });
  });

  it('非 a2a 消息（human user）→ null', () => {
    expect(a2aRefOf(mkMsg({ id: 'u1', role: 'user', sender: { source: 'user' } }))).toBeNull();
  });
});

describe('resolveGroupActor（[v0.0.301] a2a 原对象 invisible；human user 头像保留）', () => {
  it('[v0.0.301] a2a inbox → avatar 为原 MemberAvatar invisible（外层 div 含 invisible + w-9，内部 MemberAvatar name/role/id 正确），name=ref.name 保留', () => {
    const result = resolveGroupActor(mkA2a('a2a-g', 'mate', 'alice', 'sess-g-alice'));
    expect(avatarMemberProps(result.avatar)).toEqual({ name: 'alice', role: 'mate', id: 'sess-g-alice' });
    expect(result.name).toBe('alice');
  });

  it('a2a inbox → showNameAsPrefix 仍为 true（信封旁名字前缀逻辑保留）', () => {
    const result = resolveGroupActor(mkA2a('a2a-g2', 'leader', 'captain'));
    expect((result as { showNameAsPrefix?: boolean }).showNameAsPrefix).toBe(true);
  });

  it('human user → avatar 无 id（name=you，零回归）', () => {
    const result = resolveGroupActor(mkMsg({ id: 'u-g', role: 'user', sender: { source: 'user' } }));
    const props = avatarProps(result.avatar);
    expect(props.name).toBe('you');
    expect(props.role).toBe('user');
    expect(props.id).toBeUndefined();
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
      defaultRoutingPlan: null,
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
    // actor 用对端 alice/leader（assistant answer 走 peer 头像），id=peer.id
    const props = avatarProps(s.resolveActor!(mkMsg({ id: 'as', role: 'assistant', content: [{ type: 'text', text: 'r' }] })).avatar);
    expect(props).toEqual({ name: 'alice', role: 'leader', id: 'm1' });
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
