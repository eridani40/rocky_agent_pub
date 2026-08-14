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
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContentBlock, FlattenedView, LoadingPhase, Message, RunFinish, RunRetryStatus } from './types';
import { flattenAndGroup } from './message-flatten';
import { buildRenderRows } from './build-render-rows';
import type { RenderRow } from './build-render-rows';
import { ComponentToolBatch } from './component-tool-batch';
import { ScrollGuideBubble } from './component-scroll-guide-bubble';
import { PrimitiveBubble } from '../common/primitive-bubble';
import { PrimitiveMarkdownView } from '../common/primitive-markdown-view';
// [v0.0.295] a2a 消息信封折叠渲染
import { isA2aInbox, a2aRefOf } from './chat-actor-strategy';
import { ComponentA2aEnvelope } from './component-a2a-envelope';
import { ComponentRunFinish } from './component-run-finish';
import { MentionRender } from './component-mention-render';
import { ComponentLoadingStatus } from './component-loading-status';
import { useMessageScrollPagination } from './use-message-scroll-pagination';
import { DefaultAgentAvatar, DefaultUserAvatar } from './component-message-stream-avatars';
import { MsgTime } from './component-msg-time';
// [v0.0.253] chat 链接 Context Provider（[v0.0.320 D12] 弹层退役：12 格式复用预览区 openTab，image 保留内置 viewer 弹层）
import { ChatLinkHandlerProvider } from './chat-link-handler-context';
import { ComponentWsImageViewer, type WsImageTarget } from './component-ws-image-viewer';
import { usePreviewArea } from './preview-area-context';
import { openLocalPath } from '../../lib/open-local-path';
import { openWorkspaceItem } from '../../lib/chat-api';
// [CHAT-DEBUG] 临时观测（定位 tool_call 回放渲染缺失；排查完连同 lib/chat-debug-log 整体删除）
import { chatDebug } from '../../lib/chat-debug-log';

/** [CHAT-DEBUG] 渲染计数序号（跨 render 递增，看 render 风暴用） */
let renderSeq = 0;

/**
 * [v0.0.331 P0] 提取 send_message arguments.content 的正文文本（渲染侧容错，与后端 normalize 等价）。
 * 根因：v0.0.311 起 out 信封 bodyText 从后端已 normalize 的 tool_result 切到 LLM 原始 arguments，
 * 但只兼容 `array + block.type==='text'` 一种形态；真实 LLM（glm/deepseek 17-20%）传
 * `[{"text":"..."}]`（block 缺 type）→ 后端容错发送成功，前端 filter(c=>c.type==='text') 全滤 → 展开空白。
 * 本函数只认 text 字段、不读 type 做过滤（与后端 normalizeContentBlocks 对齐），历史脏数据兜底。
 * 形态：
 *   ① string → 直接当正文
 *   ② array  → 每块 object 且 text 为 string → join('\n')（缺 type 按默认 text，不要求 type==='text'）
 *   ③ object → 取 `.item ?? obj` 解包：payload 为 string 直接用、payload.text 为 string 用 text、
 *               payload 为 array 递归提取（对齐后端「单 block 包数组」语义）
 *   ④ 其他   → ''
 */
export function extractSendMessageBody(argContent: unknown): string {
  // ① string → 直接当正文
  if (typeof argContent === 'string') return argContent;
  // ② array → 每块取 text（不要求 type==='text'，与后端 normalize 对齐）
  if (Array.isArray(argContent)) {
    return argContent
      .filter(
        (c): c is { text: string } =>
          typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).text === 'string',
      )
      .map((c) => c.text)
      .join('\n');
  }
  // ③ object → 取 .item ?? obj 解包（LLM 实测形态）
  if (argContent !== null && typeof argContent === 'object') {
    const obj = argContent as Record<string, unknown>;
    const payload: unknown = obj.item ?? obj;
    if (typeof payload === 'string') return payload;
    if (payload !== null && typeof payload === 'object') {
      if (Array.isArray(payload)) return extractSendMessageBody(payload); // item 是数组 → 递归
      if (typeof (payload as Record<string, unknown>).text === 'string') {
        return (payload as { text: string }).text;
      }
    }
  }
  // ④ 其他（null/undefined/number/bool）→ ''
  return '';
}
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
  /**
   * [v0.0.311] squad 成员列表（用于 send_message 信封 target sessionId → 可读名解析）。
   * 不传 = Playground 零回归（buildRenderRows 不收 resolveSessionName，string 原样返回）。
   */
  members?: { id: string; name: string }[];
}

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
  members,
}: MessageStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation('chat');
  // [v0.0.320 D12] 弹层退役：image 分支保留内置 viewer 弹层（12 格式走预览区 openTab / 无 Provider 降级系统打开）
  const [wsImageTarget, setWsImageTarget] = useState<WsImageTarget | null>(null);
  // [Task 3 偏离③] 有预览区 Provider → chat 链接 12 格式 openTab；无 → 系统打开（image 仍走弹层）
  const preview = usePreviewArea();
  // [v0.0.311] 追踪信封展开的行 key（展开→渲染时间戳，收起→隐藏）
  const [expandedEnvelopes, setExpandedEnvelopes] = useState<Set<string>>(new Set());
  const { elements, batches, elementBatch } = flattened ?? flattenAndGroup(messages, { messageFilter, blockFilter });

  // [v0.0.311] send_message 信封 target sessionId → 可读名解析闭包（members 非空时构造，空=undefined 零回归）
  const resolveSessionName = useMemo(
    () => (members && members.length > 0 ? (sid: string) => members.find((m) => m.id === sid)?.name : undefined),
    [members],
  );
  // [CHAT-DEBUG] 渲染入口核对：toolCallItems 是 flatten 产出的 tool_call 视图节点数。
  //   与 reducer 的 toolCallBlocks 对照：blocks=133 而 toolCallItems<K = 断在 flatten/过滤；
  //   toolCallItems=133 而屏幕上少 = 断在折叠/滚动（看 tool-batch 行的 open/calls）
  const dbgToolCallItems = elements.reduce((n, e) => (e.kind === 'tool-call-item' ? n + 1 : n), 0);
  chatDebug(
    `render #${++renderSeq} messages=${messages.length} elements=${elements.length} ` +
      `toolCallItems=${dbgToolCallItems} batches=${batches.length}`,
  );

  // batch key → 该 batch 内的 tool-call-item 组（rows 折叠用，见 build-render-rows.ts）
  const rows = buildRenderRows(elements, elementBatch, batches, resolveSessionName);

  // messageId → Message（actor 解析 + side 判定都需要，始终构建）
  const msgById = new Map<string, Message>();
  for (const m of messages) msgById.set(m.id, m);

  // 取某 messageId 对应 actor（resolveActor 不传或 msg 找不到 = 用默认头像）
  const actorOf = (messageId: string): ActorInfo | undefined => {
    if (!resolveActor) return undefined;
    return resolveActor(msgById.get(messageId) ?? ({} as Message));
  };

  // 滚动分页副作用抽到 useMessageScrollPagination hook
  // [v0.0.262] 内容签名 = `${rows.length}:${textLenSum}`（行数 + text 长度和；tool-batch 无 text 跳过）。
  //   流式 text_block_delta 更新同一条消息内容时 rows.length 不变但 text 长度变 → 签名变 → autoScroll effect 触发滚底
  //   （跟丢修复核心：旧依赖 rows.length 单维度，delta 只更新内容不增行 → effect 不触发）。
  //   useMemo 依赖 rows（change_plan 行 3 契约：contentSignature 为纯计算，基于已构建 rows）。
  const contentSignature = useMemo(() => {
    let textLenSum = 0;
    for (const row of rows) {
      // tool-batch / send-message-envelope 行无 text，跳过
      if (row.type === 'tool-batch' || row.type === 'send-message-envelope') continue;
      textLenSum += row.text.length;
    }
    return `${rows.length}:${textLenSum}`;
  }, [rows]);
  const { onScroll, nearBottom, scrollToBottom, markUserInteract } = useMessageScrollPagination({
    scrollRef, hasMore, isLoadingMore, onLoadMore,
    messagesLength: messages.length,
    autoScrollDeps: [contentSignature, lastRunFinish, runActive],
  });


  return (
    <ChatLinkHandlerProvider
      value={{
        sessionId,
        // [v0.0.320 D12] 弹层退役：chat 链接复用 openLocalPath 共享分流（≡ 右侧文件区）
        //   image → 内置 viewer 弹层保留；12 格式 → preview.openTab（有 Provider）/ 系统打开（无 Provider 降级偏离③）
        onLocalViewer: (target) => {
          openLocalPath(target.path, {
            sessionId,
            source: target.source,
            onEditor: preview
              ? (t) => preview.openTab(t)
              : (t) => {
                  // 无 Provider 降级：系统打开（对齐无 onLocalViewer 消费方行为）
                  if (target.source === 'workspace') {
                    void openWorkspaceItem(sessionId, { path: t.path, kind: 'file' }).catch((e) =>
                      console.warn('openWorkspaceItem failed:', e),
                    );
                  } else if (typeof window !== 'undefined' && window.rockyShell) {
                    void window.rockyShell.openPath(t.path).catch((e) => console.warn('openPath failed:', e));
                  }
                },
            onImageViewer: (t) => setWsImageTarget({ path: t.path, fileName: t.fileName, subtitle: t.subtitle }),
          });
        },
      }}
    >
      {/* [v0.0.262] relative wrapper：为 absolute 气泡提供定位上下文（scroll 容器内部不能挂——
          absolute 随内容滚动）；scroll div className 原样保留（布局稳定性），气泡不占文档流 */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={markUserInteract}
        onTouchMove={markUserInteract}
        onKeyDown={markUserInteract}
        tabIndex={0}
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
          const isSendMsgEnvelope = row.type === 'send-message-envelope';
          // text 仅 tool-batch / send-message-envelope 无；user-text / agent-answer 都有
          const text = isToolBatch || isSendMsgEnvelope ? '' : (row as { text: string }).text;
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
              {/* out 信封（send-message-envelope）左侧头像隐藏，用空占位保布局（和 in 信封一致） */}
              {isSendMsgEnvelope ? (
                <div className="w-9 shrink-0" aria-hidden />
              ) : (
                actor ? actor.avatar : <DefaultAgentAvatar messageId={row.messageId} />
              )}
              <div className="flex-1 min-w-0 flex flex-col items-start gap-1.5 pt-0.5">
                {/* a2a 角色名前缀行（群聊：actor.showNameAsPrefix 时渲染） */}
                {actor?.showNameAsPrefix && actor.name && !isA2aInbox(msg as Message) && (
                  <div className="font-mono text-[11px] text-accent">
                    {actor.name}:
                  </div>
                )}
                {isToolBatch ? (
                  <ComponentToolBatch calls={row.calls} runActive={runActive} />
                ) : isSendMsgEnvelope ? (
                  /* send_message 信封：out 方向信封渲染 */
                  (() => {
                    const envRow = row as Extract<RenderRow, { type: 'send-message-envelope' }>;
                    // [v0.0.311] done 态展开正文从 arguments.content[].text 提取（发送的消息内容）
                    // [v0.0.331 P0] 改调 extractSendMessageBody 容错提取（array 缺 type / string / object.item 解包，
                    //   与后端 normalizeContentBlocks 对齐；历史脏数据兜底，修复展开空白）
                    const argContent = envRow.arguments['content'];
                    const bodyText = extractSendMessageBody(argContent);
                    // error 态仍从 result 提取失败原因（不是发送内容）
                    // [v0.0.331 P1'] _rawTruncated（参数截断）时明确提示「发送失败（参数截断）」，优先于 result 提取
                    const errText =
                      envRow.status === 'error'
                        ? envRow.arguments?._rawTruncated === true
                          ? '发送失败（参数截断）'
                          : envRow.result?.content
                              ?.filter((c) => c.type === 'text')
                              .map((c) => (c as { type: 'text'; text: string }).text)
                              .join('\n') ?? '发送失败'
                        : undefined;
                    return (
                      <ComponentA2aEnvelope
                        direction="out"
                        senderName={envRow.targetName}
                        status={envRow.status}
                        errorContent={errText}
                        onToggle={(exp) =>
                          setExpandedEnvelopes((prev) => {
                            const next = new Set(prev);
                            if (exp) next.add(row.key);
                            else next.delete(row.key);
                            return next;
                          })
                        }
                      >
                        {bodyText}
                      </ComponentA2aEnvelope>
                    );
                  })()
                ) : isA2aInbox(msg as Message) ? (
                  /* [v0.0.295] a2a 消息用信封折叠组件，替代普通 assistant 气泡 */
                  <ComponentA2aEnvelope
                    senderName={a2aRefOf(msg as Message)?.name ?? actor?.name ?? ''}
                    onToggle={(exp) =>
                      setExpandedEnvelopes((prev) => {
                        const next = new Set(prev);
                        if (exp) next.add(row.key);
                        else next.delete(row.key);
                        return next;
                      })
                    }
                  >
                    {text}
                  </ComponentA2aEnvelope>
                ) : (
                  <PrimitiveBubble variant="assistant">
                    <PrimitiveMarkdownView source={text} />
                  </PrimitiveBubble>
                )}
                {/* 消息时间行：普通消息始终显示；信封仅在展开时显示（tool-batch 不加） */}
                {!isToolBatch && !isSendMsgEnvelope && !isA2aInbox(msg as Message) && (
                  <MsgTime iso={msg?.createdAt ?? ''} side="assistant" />
                )}
                {/* [v0.0.311] 信封行（in/out）展开时在信封外部下方渲染时间戳 */}
                {(isSendMsgEnvelope || isA2aInbox(msg as Message)) && expandedEnvelopes.has(row.key) && (
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
        {/* [v0.0.320 D12] 弹层退役：仅 image 分支保留内置 viewer 弹层（12 格式已走预览区 openTab） */}
        <ComponentWsImageViewer sessionId={sessionId} target={wsImageTarget} onClose={() => setWsImageTarget(null)} />
      </div></div>
      {/* [v0.0.262] 滚动引导气泡：用户不在底部时显示（新消息/回到底部），点击平滑滚底。
          absolute 定位不占文档流（wrapper 提供定位上下文）；nearBottom/scrollToBottom 来自 hook（行 1/2 扩展） */}
      <ScrollGuideBubble
        nearBottom={nearBottom}
        runActive={runActive}
        hasMessages={messages.length > 0}
        onScrollToBottom={() => scrollToBottom('smooth')}
      />
      </div>
    </ChatLinkHandlerProvider>
  );
}

export default ComponentMessageStream;
