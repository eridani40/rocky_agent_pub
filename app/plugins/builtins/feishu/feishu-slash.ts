/**
 * 飞书斜杠指令派发
 * 参考: reqs/[done] v0.0.103.channel/design-feishu.md §3
 *       reqs/[done] v0.0.103.channel/design-usecases.md UC-C1~C6
 *
 * 指令集（D1/D2 用户确认）：
 *   - /listp    列 playground sessions（UC-C1）
 *   - /bindp N  绑定 playground session N（UC-C3）
 *   - /lists    列 studio leaders（UC-C2）
 *   - /binds N  绑定 studio leader session N（UC-C4）
 *   - /unbind   解绑（UC-C5）
 *   - /status   查看当前绑定（UC-C6）
 *
 * 关键约束：
 *   - /bindp /binds 都是绑定，p=playground / s=studio（design §3）
 *   - 命令消息立即派发（跳过去抖，由 caller 控制）
 *   - 输出飞书可发的纯文本回执（含 emoji 数字编号方便用户选 N）
 */

import type { Session } from '../../../server/src/agent/session-store-types';

/** 斜杠派发结果：回执文本（飞书 text 消息发回） */
export interface SlashDispatchResult {
  /** 回执纯文本（用户看到的回复，空字符串=不回执） */
  replyText: string;
  /** 派发是否成功识别（false=未知指令，replyText 含错误提示） */
  recognized: boolean;
}

/** 斜杠派发依赖：注入 base 提供的 helper（list/bind/unbind/getBindedSession） */
export interface SlashDeps {
  /** base.listPlaygroundSessions / listStudioLeaders 透传 */
  listPlaygroundSessions(): Promise<Session[]>;
  listStudioLeaders(): Promise<Session[]>;
  bind(conversationId: string, sessionId: string, by: 'slash' | 'manual'): Promise<void>;
  unbind(conversationId: string): Promise<void>;
  getBindedSession(conversationId: string): Promise<string | null>;
}

/**
 * 派发飞书斜杠指令。
 *
 * @param text 用户消息文本（已剥离 @bot）
 * @param deps helper 注入（由 FeishuChannel 通过 protected base 方法提供）
 * @param conversationId 当前会话 id（绑定时用）
 * @returns 回执文本 + 是否识别
 */
export async function dispatchSlash(
  text: string,
  deps: SlashDeps,
  conversationId: string,
): Promise<SlashDispatchResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { replyText: '', recognized: false };
  }

  // 解析指令 + 参数（空格分隔）
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const arg = parts[1];

  switch (cmd) {
    case 'listp':
      return await handleList(deps.listPlaygroundSessions, 'Playground');
    case 'lists':
      return await handleList(deps.listStudioLeaders, 'Studio Leaders');
    case 'bindp':
    case 'binds': {
      const bizLabel = cmd === 'bindp' ? 'playground' : 'studio leader';
      return await handleBind(cmd, arg, deps, conversationId, bizLabel);
    }
    case 'unbind':
      return await handleUnbind(deps, conversationId);
    case 'status':
      return await handleStatus(deps, conversationId);
    default:
      return {
        replyText:
          `未知指令: /${cmd}\n可用指令:\n` +
          '/listp - 列出 Playground 会话\n' +
          '/lists - 列出 Studio Leader 会话\n' +
          '/bindp N - 绑定第 N 个 Playground 会话\n' +
          '/binds N - 绑定第 N 个 Studio Leader 会话\n' +
          '/unbind - 解绑当前会话\n' +
          '/status - 查看当前绑定',
        recognized: false,
      };
  }
}

/** /listp /lists 通用处理：列出 sessions，1-based 编号 */
async function handleList(
  listFn: () => Promise<Session[]>,
  label: string,
): Promise<SlashDispatchResult> {
  try {
    const sessions = await listFn();
    if (sessions.length === 0) {
      return { replyText: `当前没有可用的 ${label} 会话`, recognized: true };
    }
    const lines = sessions.map((s, idx) => {
      const sid = s.id || '';
      const title = (s as { title?: string }).title?.trim() || 'untitled';
      return `${idx + 1}. ${title} (${sid.slice(0, 8)})`;
    });
    return {
      replyText: `${label} 会话列表:\n${lines.join('\n')}\n\n用 /bindp N 或 /binds N 绑定`,
      recognized: true,
    };
  } catch (e) {
    return {
      replyText: `列表查询失败: ${e instanceof Error ? e.message : String(e)}`,
      recognized: true,
    };
  }
}

/** /bindp N /binds N 处理 */
async function handleBind(
  cmd: 'bindp' | 'binds',
  arg: string | undefined,
  deps: SlashDeps,
  conversationId: string,
  bizLabel: string,
): Promise<SlashDispatchResult> {
  if (!arg || !/^\d+$/.test(arg)) {
    return {
      replyText: `用法: /${cmd} N（N 是 ${bizLabel} 会话编号，从 /list${cmd === 'bindp' ? 'p' : 's'} 查）`,
      recognized: true,
    };
  }
  const n = parseInt(arg, 10);
  if (n < 1) {
    return { replyText: `N 必须 ≥ 1`, recognized: true };
  }

  const sessions = await (cmd === 'bindp'
    ? deps.listPlaygroundSessions()
    : deps.listStudioLeaders());

  if (sessions.length === 0) {
    return { replyText: `当前没有可绑定的 ${bizLabel} 会话`, recognized: true };
  }
  if (n > sessions.length) {
    return {
      replyText: `编号超出范围（1-${sessions.length}）`,
      recognized: true,
    };
  }

  const target = sessions[n - 1];
  if (!target?.id) {
    return { replyText: `会话 #${n} 无 id`, recognized: true };
  }

  try {
    await deps.bind(conversationId, target.id, 'slash');
    return {
      replyText: `已绑定 ${bizLabel} 会话 #${n}（${target.id.slice(0, 8)}）`,
      recognized: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('SESSION_ALREADY_BOUND')) {
      return {
        replyText: `绑定失败：目标会话 ${target.id.slice(0, 8)} 已被其他渠道会话占用（一个 agent session 同时只能绑一个渠道会话）`,
        recognized: true,
      };
    }
    return { replyText: `绑定失败: ${msg}`, recognized: true };
  }
}

/** /unbind 处理 */
async function handleUnbind(
  deps: SlashDeps,
  conversationId: string,
): Promise<SlashDispatchResult> {
  const existing = await deps.getBindedSession(conversationId);
  if (!existing) {
    return { replyText: `当前未绑定任何 agent 会话`, recognized: true };
  }
  try {
    await deps.unbind(conversationId);
    return {
      replyText: `已解绑 agent 会话 ${existing.slice(0, 8)}`,
      recognized: true,
    };
  } catch (e) {
    return {
      replyText: `解绑失败: ${e instanceof Error ? e.message : String(e)}`,
      recognized: true,
    };
  }
}

/** /status 处理 */
async function handleStatus(
  deps: SlashDeps,
  conversationId: string,
): Promise<SlashDispatchResult> {
  const sid = await deps.getBindedSession(conversationId);
  if (!sid) {
    return { replyText: `当前未绑定 agent 会话`, recognized: true };
  }
  return { replyText: `当前绑定: agent 会话 ${sid.slice(0, 8)}（${sid}）`, recognized: true };
}

/** 判断文本是否是斜杠指令（caller 用来决定是否跳过去抖立即派发） */
export function isSlashCommand(text: string): boolean {
  return text.trim().startsWith('/');
}
