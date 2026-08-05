/**
 * component-message-stream —— 视图层合并核心渲染（三 chat 页共享内核）
 * 参考: specs/ui/components/chat-page/_overview.md §2 rule5/6 + §4.10
 *       specs/ui/components/studio-page/squad-chat-page.md「渲染策略契约」
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.6/§3.7
 *
 * 职责：Message[] → flattenAndGroup → user/assistant 气泡 + tool-batch + run-finish；
 *   参数化 resolveActor/messageFilter/blockFilter/sideResolver；run 态可选（squad 轮询不传）。
 * side 判定：sender.source='agent'（a2a inbox）→ assistant 侧；其余按 role。playground 无 a2a 零回归。
 * hasMore：顶部 hidden sentinel + onScroll 触发 loadMore；副作用抽到 useMessageScrollPagination hook。
 * 消息 bubble 后追加 <MsgTime/>（三页共享，独立 primitive，见 component-msg-time.tsx）。
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContentBlock, FlattenedView, LoadingPhase, Message, RunFinish, RunRetryStatus, ViewElement } from './types';
import { flattenAndGroup } from './message-flatten';
import { ComponentToolBatch } from './component-tool-batch';
import { PrimitiveBubble } from '../common/primitive-bubble';
import { PrimitiveMarkdownView } from '../common/primitive-markdown-view';
import { ComponentRunFinish } from './component-run-finish';
import { MentionRender } from './component-mention-render';
import { ComponentLoadingStatus } from './component-loading-status';
import { useMessageScrollPagination } from './use-message-scroll-pagination';
import { DefaultAgentAvatar, DefaultUserAvatar } from './component-message-stream-avatars';
import { MsgTime } from './component-msg-time';
// v0.0.253: chat 链接 viewer 挂载 + Context Provider（primitive-markdown-view `<a>` onClick 经 Context 拿 onLocalViewer）
import { ComponentChatLinkViewer, ChatLinkHandlerProvider } from './component-chat-link-viewer';
import type { ChatLinkTarget } from '../../lib/link-target';
// [CHAT-DEBUG] 临时观测（定位 tool_call 回放渲染缺失；排查完连同 lib/chat-debug-log 整体删除）
import { chatDebug } from '../../lib/chat-debug-log';

/** [CHAT-DEBUG] 渲染计数序号（跨 render 递增，看 render 风暴用） */
let renderSeq = 0;
/** actor 解析返回：头像节点 + 名字 + 是否把名字渲为气泡上方前缀行（群聊 a2a 用） */
export interface ActorInfo {
  avatar: ReactNode;
  name?: string;
  /** true = 名字作为气泡上方前缀行渲染（群聊 a2a sender）；false/不传 = 名字作 avatar 下方 label */
  showNameAsPrefix?: boolean;
}

interface MessageStreamProps {
  /** v0.0.253: chat 链接 viewer 按 source 分流取内容用；缺省 '' 兼容旧测试，生产 caller 必传 */
  sessionId?: string;
  /** 当前 session 全量 messages（升序，含 role='tool'） */
  messages: Message[];
  /** 外部预计算的 flatten 结果（caller 用 useFlattenedView 单次 flatten，
   *  同源分发给 minimap deriveMinimapBars，保证 bar 与气泡恒等）；不传 = 内部按
   *  messageFilter/blockFilter 自算 flattenAndGroup（零回归，渲染逻辑不变） */
  flattened?: FlattenedView;
  /** run 进行中（tool-batch 进度 + 末尾 on-message spinner 挂载）；不传 = false */
  runActive?: boolean;
  /** session 是否 running（门控 run-finish 渲染）；不传 = 不显示 */
  sessionRunning?: boolean;
  /** 最近一次 run 结束态（仅 last run 渲染）；不传 = 不渲染 */
  lastRunFinish?: RunFinish | null;
  /** run 层 loading phase；不传 = 兜底 thinking。两层分离见 _overview §4.10 */
  loadingPhase?: LoadingPhase | null;
  /**
   * [v0.0.130.hang] 当前执行中的 tool 名列表（loadingPhase='tool_executing' 时透传给
   * ComponentLoadingStatus 渲染「运行工具: X」）；不传 = 不显示具体 tool 名。
   */
  runningToolNames?: string[];
  /**
   * [v0.0.144] 「重试中」叠加态（透传给 ComponentLoadingStatus）；不传/null = 不显示重试态（原 4 态零回归）。
   */
  retryStatus?: RunRetryStatus | null;
  /** actor 解析（头像 + 名字）；不传 = 默认 Rocky/U，playground 零回归 */
  resolveActor?: (msg: Message) => ActorInfo;
  /** 消息 → 渲染侧判定覆盖（不传 = 默认 sideOfMessage）；只控左右侧，actor 仍由 resolveActor 决定 */
  sideResolver?: (msg: Message) => 'user' | 'assistant';
  /** 消息级白名单（群聊用）；不传 = 全展示 */
  messageFilter?: (msg: Message) => boolean;
  /** block 级过滤；不传 = 默认滤 isSystemReminder text block */
  blockFilter?: (block: ContentBlock, msg: Message) => boolean;
  /** 还有更旧消息（hasMore=true 时渲顶部 hidden sentinel + onScroll 触发 loadMore） */
  hasMore?: boolean;
  /** 上滑到顶续载回调（scrollTop<threshold(120px) 触发） */
  onLoadMore?: () => void;
  /** loadMore 进行中（跳过自动滚底 + 触发 prepend 保持位置 effect） */
  isLoadingMore?: boolean;
}

/** 渲染单元；user-text.name=[v0.0.107] IM 渠道来源徽标（非 client type，如 'feishu'；client/无 channel=undefined 不渲染） */
type RenderRow =
  | { type: 'user-text'; key: string; messageId: string; text: string; name?: string }
  | { type: 'agent-answer'; key: string; messageId: string; textIndex: number; text: string }
  | { type: 'tool-batch'; key: string; messageId: string; calls: Extract<ViewElement, { kind: 'tool-call-item' }>[] };

/**
 * 消息 → 渲染侧判定（默认判定，导出供 caller 复用，保持单一来源）。
 * a2a inbox（sender.source='agent'）→ assistant 侧（左），即便 role='user'（后端 a2a 存 role='user'）；
 * 其余按 role：role='user'→user 侧（右），其他→assistant 侧（左）。msg 缺失兜底 assistant。
 * 用例：memberSideResolver = `msg => isA2aInbox(msg) ? 'user' : sideOfMessage(msg)`。
 */
export function sideOfMessage(msg: Message | undefined): 'user' | 'assistant' {
  if (!msg) return 'assistant';
  const s = msg.sender;
  if (s?.source === 'agent') return 'assistant'; // a2a inbox → 左侧
  return msg.role === 'user' ? 'user' : 'assistant';
}

/**
 * 消息流渲染：拍平 + 分组 + 单遍渲染。sideResolver 覆盖默认 sideOfMessage；末尾 runActive 时挂 spinner。
 * hasMore=true 时顶部 hidden sentinel + onScroll 触发 onLoadMore；
 *   isLoadingMore 期间跳过滚底 + prepend 保持位置（副作用抽到 useMessageScrollPagination hook）。
 */
export function ComponentMessageStream({
  sessionId = '',
  messages,
  flattened,
  runActive = false,
  sessionRunning = false,
  lastRunFinish = null,
  loadingPhase = null,
  runningToolNames,
  retryStatus,
  resolveActor,
  sideResolver,
  messageFilter,
  blockFilter,
  hasMore = false,
  onLoadMore,
  isLoadingMore = false,
}: MessageStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation('chat');
  const [chatLinkTarget, setChatLinkTarget] = useState<ChatLinkTarget | null>(null);
  const { elements, batches, elementBatch } = flattened ?? flattenAndGroup(messages, { messageFilter, blockFilter });
  // [CHAT-DEBUG] 渲染入口核对：toolCallItems 是 flatten 产出的 tool_call 视图节点数。
  //   与 reducer 的 toolCallBlocks 对照：blocks=133 而 toolCallItems<K = 断在 flatten/过滤；
  //   toolCallItems=133 而屏幕上少 = 断在折叠/滚动（看 tool-batch 行的 open/calls）
  const dbgToolCallItems = elements.reduce((n, e) => (e.kind === 'tool-call-item' ? n + 1 : n), 0);
  chatDebug(
    `render #${++renderSeq} messages=${messages.length} elements=${elements.length} ` +
      `toolCallItems=${dbgToolCallItems} batches=${batches.length}`,
  );

  // batch key → 该 batch 内的 tool-call-item 组
  const batchCallsByKey = new Map<string, Extract<ViewElement, { kind: 'tool-call-item' }>[]>();
  for (const b of batches) {
    const calls: Extract<ViewElement, { kind: 'tool-call-item' }>[] = [];
    for (const ek of b.elementKeys) {
      const e = elements.find((x) => x.key === ek);
      if (e && e.kind === 'tool-call-item') calls.push(e);
    }
    batchCallsByKey.set(b.key, calls);
  }

  // messageId → Message（actor 解析 + side 判定都需要，始终构建）
  const msgById = new Map<string, Message>();
  for (const m of messages) msgById.set(m.id, m);

  // 取某 messageId 对应 actor（resolveActor 不传或 msg 找不到 = 用默认头像）
  const actorOf = (messageId: string): ActorInfo | undefined => {
    if (!resolveActor) return undefined;
    return resolveActor(msgById.get(messageId) ?? ({} as Message));
  };

  // 把 elements 折叠为 RenderRow 序列：连续 tool-call-item 合并为一条 tool-batch row
  const rows: RenderRow[] = [];
  let i = 0;
  while (i < elements.length) {
    const el = elements[i]!;
    if (el.kind === 'tool-call-item') {
      const batchKey = elementBatch.get(el.key);
      if (batchKey) {
        const calls = batchCallsByKey.get(batchKey) ?? [];
        rows.push({
          type: 'tool-batch',
          key: `row-${batchKey}`,
          messageId: calls[0]?.messageId ?? el.messageId,
          calls,
        });
        while (i < elements.length && elementBatch.get(elements[i]!.key) === batchKey) i++;
        continue;
      }
      i++;
      continue;
    }
    if (el.kind === 'user-text') {
      rows.push({
        type: 'user-text',
        key: el.key,
        messageId: el.messageId,
        text: el.text,
        name: el.name,
      });
    } else if (el.kind === 'agent-answer') {
      rows.push({ type: 'agent-answer', key: el.key, messageId: el.messageId, textIndex: el.textIndex, text: el.text });
    }
    i++;
  }

  // 滚动分页副作用抽到 useMessageScrollPagination hook
  const { onScroll } = useMessageScrollPagination({
    scrollRef, hasMore, isLoadingMore, onLoadMore,
    messagesLength: messages.length,
    autoScrollDeps: [rows.length, lastRunFinish, runActive],
  });


  return (
    <ChatLinkHandlerProvider value={{ onLocalViewer: setChatLinkTarget, sessionId }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto py-6 pl-8 pr-[80px] pb-[60px] flex flex-col gap-7"
      >
      <div className="max-w-[820px] mx-auto w-full flex flex-col gap-7">
        {/* 顶部 hidden sentinel（hasMore=true 时存在）。
            studio 群聊/subagent 只读页 hasMore 不传 = 不渲。 */}
        {hasMore && <div aria-hidden className="hidden" />}
        {rows.map((row) => {
          const msg = msgById.get(row.messageId);
          // sideResolver 覆盖默认 sideOfMessage；不传 = 默认逻辑。
          // msg 缺失（理论不达）兜底 assistant（sideOfMessage 已处理 undefined）。
          const side = msg && sideResolver ? sideResolver(msg) : sideOfMessage(msg);
          const actor = actorOf(row.messageId);
          const isToolBatch = row.type === 'tool-batch';
          // text 仅 tool-batch 无；user-text / agent-answer 都有
          const text = isToolBatch ? '' : (row as { text: string }).text;
          // 三区布局：user=左空占位|内容|右头像；assistant=左头像|内容|右空占位
          if (side === 'user') {
            // [v0.0.107] 来源徽标：非 client channel（flatten 派生的 row.name）→ 气泡下渲「来自 {type}」muted 小字。
            //   client/无 channel（name=undefined）不渲染，避免「来自 client」噪声。
            const originName = row.type === 'user-text' ? row.name : undefined;
            return (
              <div
                key={row.key}
                id={`msg-${row.messageId}`}
                className="flex gap-2.5 self-end max-w-[600px] w-full"
              >
                <div className="w-9 shrink-0" aria-hidden />
                <div className="flex-1 min-w-0 flex flex-col items-end">
                  <PrimitiveBubble variant="user">
                    <MentionRender text={text} />
                  </PrimitiveBubble>
                  {/* 消息时间行（bubble 后，origin 前）；无效 createdAt→组件返 null 不占位 */}
                  <MsgTime iso={msg?.createdAt ?? ''} side="user" />
                  {originName && (
                    <div

                      className="text-[10px] text-muted mt-0.5 pr-1"
                    >
                      {t('origin.from', { name: originName })}
                    </div>
                  )}
                </div>
                {actor ? actor.avatar : <DefaultUserAvatar messageId={row.messageId} />}
              </div>
            );
          }
          return (
            <div
              key={row.key}
              id={`msg-${row.messageId}`}
              className="flex gap-2.5 max-w-[820px] w-full"
            >
              {actor ? actor.avatar : <DefaultAgentAvatar messageId={row.messageId} />}
              <div className="flex-1 min-w-0 flex flex-col items-start gap-1.5 pt-0.5">
                {/* a2a 角色名前缀行（群聊：actor.showNameAsPrefix 时渲染） */}
                {actor?.showNameAsPrefix && actor.name && (
                  <div className="font-mono text-[11px] text-accent">
                    {actor.name}:
                  </div>
                )}
                {isToolBatch ? (
                  <ComponentToolBatch calls={row.calls} runActive={runActive} />
                ) : (
                  <PrimitiveBubble variant="assistant">
                    <PrimitiveMarkdownView source={text} />
                  </PrimitiveBubble>
                )}
                {/* 消息时间行（仅 answer bubble 后；tool-batch 组不加，非「消息」语义） */}
                {!isToolBatch && (
                  <MsgTime iso={msg?.createdAt ?? ''} side="assistant" />
                )}
              </div>
              <div className="w-9 shrink-0" aria-hidden />
            </div>
          );
        })}

        {/* on-message spinner (§3.7)：runActive||sessionRunning 双源门控；phase=null 兜底 thinking（run_start 后、首条 content 前）；
            sessionRunning 兜底：切会话/SSE 重连 sticky replay 失效时 REST 仍驱动 spinner。两层分离见 _overview §4.10 */}
        {(runActive || sessionRunning) && (
          <ComponentLoadingStatus phase={loadingPhase ?? 'thinking'} toolNames={runningToolNames} retryStatus={retryStatus} />
        )}

        {/* sessionRunning 门控 run-finish（不传 sessionRunning = false = 不显示） */}
        {!sessionRunning && lastRunFinish && <ComponentRunFinish finish={lastRunFinish} />}
        <ComponentChatLinkViewer target={chatLinkTarget} sessionId={sessionId} onClose={() => setChatLinkTarget(null)} />
      </div></div>
    </ChatLinkHandlerProvider>
  );
}

export default ComponentMessageStream;
