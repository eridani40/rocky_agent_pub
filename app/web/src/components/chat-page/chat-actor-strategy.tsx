/**
 * chat-actor-strategy —— chrome 驱动的消息渲染策略（谓词 + actor 解析 + 策略派生）
 * 参考: specs/tech/app/frontend/[P0]chat_session_assembly.md §4（群聊渲染策略链路）
 *       specs/ui/components/chat-page/section-chat-session.md（groupRender 门控矩阵行）
 *
 * [v0.0.216] 自 studio-page/squad-chat-helpers.tsx 逐行等价迁移（chat-page 禁 import
 * studio-page）；resolveMemberActorFactory 参数窄化为 {name, role}（数据来自
 * chrome.members + chrome.memberId，不再依赖 studio Member 实体）。
 *
 * 数据层分类（源自后端 source code 验证，权威）：
 *   - human user 消息 = role:'user' + sender.source:'user'（session-messages.ts 永远赋值）
 *   - a2a inbox 消息 = role:'user' + sender.source:'agent' + sender.agent.ref
 *     ★ role 是 'user' 不是 'assistant'！
 *   - assistant answer（agent loop 自产）= role:'assistant'，无 sender.source:'agent'
 *   - tool_call / tool_result = role:'assistant' content / role:'tool'
 *
 * 边界：纯函数，无副作用；不读 store。仅依赖 chat-page Message 类型 + common MemberAvatar。
 */
import type { ReactNode } from 'react';
import type { Message } from './types';
import type { SessionChromeView } from '../../lib/chat-api';
import { MemberAvatar } from '../common/member-avatar';
// 复用内核默认 side 判定（保持单一来源；群聊不传 sideResolver = 内核默认 a2a→左）
import { sideOfMessage } from './component-message-stream';

/**
 * 判定 a2a inbox 消息：sender.source='agent' 且有 agent.ref（ref.type∈{leader,mate,...}）。
 * 这类消息 role 是 'user' 但语义是「另一个 agent 发来的 a2a 消息」。
 */
export function isA2aInbox(msg: Message): boolean {
  const s = msg.sender;
  return !!s && s.source === 'agent' && !!s.agent?.ref;
}

/**
 * 判定 human user 消息。
 * ★ 必须先排除 a2a inbox（a2a 也 role='user'），不能裸用 role==='user'。
 * 兜底：sender 缺失时按 role==='user' 且非 a2a 判（历史数据兼容）。
 */
export function isUser(msg: Message): boolean {
  const s = msg.sender;
  if (s?.source === 'user') return true;
  if (isA2aInbox(msg)) return false;
  return msg.role === 'user';
}

/** 群聊白名单：只留 human user + a2a inbox（mute assistant answer + tool + system） */
export function groupMessageFilter(msg: Message): boolean {
  return isUser(msg) || isA2aInbox(msg);
}

/** 从 a2a inbox message 取 sender.agent.ref（type/name/sessionId）；非 a2a 返 null */
export function a2aRefOf(msg: Message): { type: string; name: string; sessionId: string } | null {
  const s = msg.sender;
  if (!s || s.source !== 'agent' || !s.agent?.ref) return null;
  return { type: s.agent.ref.type, name: s.agent.ref.name, sessionId: s.agent.ref.sessionId };
}

/**
 * 群聊 actor 解析（resolveActor）：
 *   - human user → MemberAvatar(role='user', name='you')，右侧
 *   - a2a inbox → 原 MemberAvatar 对象 invisible（[v0.0.301] 外层 w-9 shrink-0 invisible 包裹，保真布局、信封位置不动），
 *     name=ref.name + showNameAsPrefix=true 保留
 *   - 兜底（理论不达：白名单已滤）→ user 头像
 */
export function resolveGroupActor(msg: Message): { avatar: ReactNode; name?: string; showNameAsPrefix?: boolean } {
  if (isA2aInbox(msg)) {
    const ref = a2aRefOf(msg)!;
    const role = ref.type === 'leader' ? 'leader' : ref.type === 'mate' ? 'mate' : 'mate';
    return {
      // [v0.0.301] 原 MemberAvatar 对象 invisible（保留原对象，位置 100% 保真 + 未来恢复容易）；外层 w-9 列同 MemberAvatar md 尺寸
      avatar: (
        <div className="w-9 shrink-0 invisible">
          <MemberAvatar name={ref.name} role={role} id={ref.sessionId} />
        </div>
      ),
      name: ref.name,
      showNameAsPrefix: true,
    };
  }
  return { avatar: <MemberAvatar name="you" role="user" /> };
}

/** 单聊对端身份最小子集（数据来自 chrome.members find memberId；role 非 leader 一律按 mate 配色） */
export interface PeerActorInfo {
  name: string;
  role: string;
  /** 稳定 id（member.id），传给 MemberAvatar 保证同 member 恒同色 */
  id: string;
}

/**
 * 单聊 actor 解析（resolveActor）：
 *   - human user → MemberAvatar(role='user', name='you')，右侧
 *   - a2a inbox → 原 MemberAvatar 对象 invisible（[v0.0.301] 外层 w-9 shrink-0 invisible 包裹，保真布局、信封位置不动），
 *     name=ref.name + showNameAsPrefix=true 保留（发送方是另一 agent，名字取 sender.agent.ref，**非** peer）
 *   - 其他（assistant answer/tool）→ MemberAvatar(role=peer.role, name=peer.name)，左侧
 * 单聊对端固定一个 member，非 user 非 a2a 消息统一用该 member 头像。
 */
export function resolveMemberActorFactory(peer: PeerActorInfo): (msg: Message) => { avatar: ReactNode; name?: string; showNameAsPrefix?: boolean } {
  const role: 'leader' | 'mate' = peer.role === 'leader' ? 'leader' : 'mate';
  const name = peer.name;
  const peerId = peer.id;
  return (msg: Message) => {
    if (isUser(msg) && !isA2aInbox(msg)) {
      return { avatar: <MemberAvatar name="you" role="user" /> };
    }
    // a2a inbox：发送方是另一 agent，名字取 sender.agent.ref（非 peer）。
    // [v0.0.295] showNameAsPrefix=true 供信封组件显示发送方名字
    // [v0.0.301] 原 MemberAvatar 对象 invisible（保真布局，恢复容易）
    if (isA2aInbox(msg)) {
      const ref = a2aRefOf(msg)!;
      const refRole: 'leader' | 'mate' = ref.type === 'leader' ? 'leader' : 'mate';
      return {
        avatar: (
          <div className="w-9 shrink-0 invisible">
            <MemberAvatar name={ref.name} role={refRole} id={ref.sessionId} />
          </div>
        ),
        name: ref.name,
        showNameAsPrefix: true,
      };
    }
    return { avatar: <MemberAvatar name={name} role={role} id={peerId} /> };
  };
}

/**
 * 单聊 sideResolver（消息 → 左右侧判定）：
 *   - 全部走内核默认 sideOfMessage（a2a→assistant 左侧，与群聊一致）
 *   - 单一职责：只控「左右侧」；头像/名字仍由 resolveMemberActorFactory 决定（解耦）。
 * 群聊不传 sideResolver —— 沿用内核默认 a2a→左。
 * [v0.0.295] a2a 消息从右侧（user）改回左侧（assistant），与群聊行为对齐。
 */
export function memberSideResolver(msg: Message): 'user' | 'assistant' {
  return sideOfMessage(msg);
}

/** 渲染策略产物（三项都可缺省 = 默认渲染，即 playground/academy 同款） */
export interface RenderStrategy {
  messageFilter?: (msg: Message) => boolean;
  resolveActor?: (msg: Message) => { avatar: ReactNode; name?: string; showNameAsPrefix?: boolean };
  sideResolver?: (msg: Message) => 'user' | 'assistant';
}

/**
 * 按 chrome 数据派生渲染策略（纯数据驱动，零 kind 字面分支）：
 *   - capabilities.groupRender=true → 群聊策略（白名单 filter + a2a actor；不传 sideResolver=内核默认）
 *   - memberId 非空（studio 单聊）→ 对端 actor + memberSideResolver
 *     （对端在 members 中缺失 → 空策略兜底，默认渲染）
 *   - 其余 → 空策略（默认渲染）
 */
export function deriveRenderStrategy(chrome: SessionChromeView): RenderStrategy {
  if (chrome.capabilities.groupRender) {
    return { messageFilter: groupMessageFilter, resolveActor: resolveGroupActor };
  }
  if (chrome.memberId) {
    const peer = chrome.members.find((m) => m.id === chrome.memberId);
    if (peer) {
      return {
        resolveActor: resolveMemberActorFactory({ name: peer.name, role: peer.role, id: peer.id }),
        sideResolver: memberSideResolver,
      };
    }
  }
  return {};
}
