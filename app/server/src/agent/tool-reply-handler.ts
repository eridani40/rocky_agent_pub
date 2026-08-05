/**
 * tool-reply-handler — HITL 回填处理（v0.0.101 T4 新增）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 E（pre-process 回填处理）
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §6 §7（handleType 三分发）
 *       specs/tech/agent/tools/[P0]tool_permission.md §6（approval 回填三分发实例化）
 *
 * 职责：处理 drain 出的 tool_reply 消息，按 handleType 三分发编辑占位 ToolResultBlock。
 *
 * 三分发（§6）：
 *   - direct_result：payload（FeedbackAnswer）序列化为文本 → 编辑 block content + status pending→success
 *   - approval：读 payload.decision（allow/allow_always/deny）三路：
 *       allow/allow_always → 补跑 tool.run(originalArgs, ctx) → 编辑 block（status success/fail）
 *       allow_always 额外 approvalManager.recordAlways(sessionId, approvalKey)
 *       deny → isError 结果含「用户拒绝执行：{reason}」，status fail
 *       补跑不再调 checkPermission（INV-P7：已批准不二次拦截）
 *   - callback：调 tool.onReply(payload, ctx) → 用返回的 ToolRunResult 编辑 block + status pending→success/fail
 *
 * 编辑机制（INV-6：编辑而非 append）：
 *   - store.appendMessages 同 id upsert → 读 toolMessage + 改 content[blockIndex] + 写回
 *   - 编辑发生在 LLM 首次消费前（loop 退出后下轮 pre-process 时）；下轮 assemble 读到编辑后内容
 *
 * 单文件 ≤300 行（纯函数 + handleType 分支）。
 */
import type {
  ContentBlock,
  Message,
  MessageInput,
  ToolReplyBlock,
  ToolResultBlock,
} from '../message/types';
import type {
  ApprovalData,
  Tool,
  ToolCtx,
  ToolRunResult,
  ToolSessionConfigLike,
} from '../tools/types';
import { approvalManager } from '../tools/approval-manager';
import type { RunSpec } from './loop-ports';
import type { EmitContext } from './agent-loop-emitters';
import { emitToolResult } from './agent-loop-emitters';

/** handleToolReply 返回值（caller 据此决定后续：续 LLM 还是 emit 下一个 + break） */
export interface HandleToolReplyResult {
  /** 是否成功匹配 + 编辑（false=队首不匹配/message 不是 tool_reply 等） */
  resolved: boolean;
  /** 是否仍有 pending（peek 队首）→ true 时 caller emit require_human_input(队首) + break */
  stillHasPending: boolean;
}

/**
 * 处理一条 tool_reply 消息（handleType 三分发 + 编辑占位 block + resolve 队列）。
 *
 * 流程（§7）：
 *   1. peek 队首 + 校验 toolCallId 匹配
 *   2. 读 resultMessageId 这条 tool message（getMessages by fromId/upToId 取单条）
 *   3. 按 handleType 分发编辑 content[resultBlockIndex]
 *   4. appendMessages 同 id upsert 写回（store 层 upsert 语义）
 *   4.5. [v0.0.124] 持久化后 emitToolResult 补发 SSE（emitCtx 存在时）
 *   5. resolvePendingToolCall（按 toolCallId 删一项）
 *   6. peek 队首返 stillHasPending
 *
 * @param spec    RunSpec（用 wireStore + config.tools）
 * @param message tool_reply message（sender.source==='tool_reply'）
 * @param emitCtx 可选 emit 上下文（存在时持久化后补发 tool_result SSE 给前端）
 */
export async function handleToolReply(
  spec: RunSpec,
  message: Message,
  emitCtx?: EmitContext,
): Promise<HandleToolReplyResult> {
  const sender = message.sender;
  if (!sender || sender.source !== 'tool_reply') {
    return { resolved: false, stillHasPending: false };
  }
  const sid = spec.config.sessionId;
  const store = spec.wireStore;
  if (!store) throw new Error('handleToolReply: spec.wireStore not wired (main only)');

  const { toolCallId } = sender.tool_reply;

  // peek 队首 + 校验 toolCallId 匹配（队首串行展示 INV-4：只处理队首）
  const head = await store.peekPendingToolCall(sid);
  if (!head || head.toolCallId !== toolCallId) {
    // 队列为空 / 队首不是本 toolCallId（乱序）：本版简化不处理非队首项。
    // 仍返队列状态让 caller 决定（队列空 → stillHasPending=false 续 LLM）。
    return { resolved: false, stillHasPending: head != null };
  }

  const resultMessageId = head.resultMessageId;
  const resultBlockIndex = head.resultBlockIndex;
  if (!resultMessageId || resultBlockIndex === undefined || resultBlockIndex < 0) {
    throw new Error(
      `handleToolReply: pending missing resultMessageId/resultBlockIndex (toolCallId=${toolCallId})`,
    );
  }

  // 找 message 内对应的 tool_reply block（payload 来源）
  const replyBlock = message.content.find(
    (b): b is ToolReplyBlock => b.type === 'tool_reply' && b.toolCallId === toolCallId,
  );
  if (!replyBlock) {
    throw new Error(
      `handleToolReply: message has no tool_reply block for toolCallId=${toolCallId}`,
    );
  }

  // 读 resultMessageId 对应的 tool message（fromId/upToId 取单条）
  const page = await store.getMessages(sid, {
    fromId: resultMessageId,
    upToId: resultMessageId,
    limit: 1,
  });
  const toolMsg = page.items[0];
  if (!toolMsg) {
    throw new Error(
      `handleToolReply: tool message ${resultMessageId} not found in store`,
    );
  }

  // 按 handleType 三分发，产出新的 content block 替换占位
  const { newBlock } = await dispatchByHandleType(spec, head, replyBlock);

  // 编辑 content[resultBlockIndex]（拷贝数组 + 替换一项，防 mutate 原数组）
  const newContent: ContentBlock[] = toolMsg.content.slice();
  newContent[resultBlockIndex] = newBlock;

  // 同 id upsert 写回（store.appendMessages 同 id 视为更新）
  const updatedMsg: MessageInput = {
    id: toolMsg.id,
    sessionId: toolMsg.sessionId,
    role: toolMsg.role,
    content: newContent,
    ...(toolMsg.runId !== undefined ? { runId: toolMsg.runId } : {}),
    ...(toolMsg.sender !== undefined ? { sender: toolMsg.sender } : {}),
    ...(toolMsg.metadata !== undefined ? { metadata: toolMsg.metadata } : {}),
  };
  await store.appendMessages(sid, [updatedMsg]);

  // [v0.0.124] 持久化后补发 tool_result SSE（与正常路径 emitToolResult 结构一致）：
  //   HITL 路径缺少 emit → 前端虽持久化正确但不更新，需在此补发三帧（start/delta/end）。
  //   所有 handleType 分支（allow/deny/callback/direct_result）统一在此补，无需分 branch 处理。
  if (emitCtx) {
    emitToolResult(emitCtx, newBlock);
  }

  // resolve 队列（删一项）
  await store.resolvePendingToolCall(sid, toolCallId);

  // peek 队首看是否仍有 pending
  const next = await store.peekPendingToolCall(sid);
  return { resolved: true, stillHasPending: next != null };
}

/**
 * 按 toolName 从 spec.config.tools 查 tool（复用现有 downcast pattern）。
 * spec.config.tools 类型声明为 ToolDefinition[]（SessionConfig 字段），实际运行时是
 * Tool[]（resolveTools 返完整 Tool[]；类型上窄化以兼容历史接口）。此处 downcast 取运行时 Tool。
 * @param kind 错误信息前缀（approval/callback），未注册时抛错定位用
 */
function findTool(spec: RunSpec, toolName: string, kind: string): Tool {
  const tools = spec.config.tools as unknown as Tool[];
  const tool = tools.find((t) => t.definition?.name === toolName);
  if (!tool) {
    throw new Error(`handleToolReply: ${kind} tool '${toolName}' not registered`);
  }
  return tool;
}

/**
 * 构造补跑/回调用 ToolCtx（config + workdir；signal 省略——回填补跑无 loop abort）。
 * spec.config 是 SessionConfig（结构化兼容 ToolSessionConfigLike，tools 字段运行时为 Tool[]）。
 */
function buildToolCtx(spec: RunSpec): ToolCtx {
  return {
    config: spec.config as unknown as ToolSessionConfigLike,
    workdir: (spec.config.workdir as string | undefined) ?? '',
  };
}

/**
 * handleType 三分发核心（§6）。
 *
 * - direct_result：payload（FeedbackAnswer）序列化为 text → status=success / isError=false
 * - approval：读 payload.decision 三路（tool_permission.md §6）：
 *     allow/allow_always → 查 spec.config.tools 按 head.toolName 取 tool
 *                          → 补跑 tool.run(head.data.arguments, ctx)（INV-P7 不再调 checkPermission）
 *                          → 编辑 block（status success/fail）
 *     allow_always 额外：approvalManager.recordAlways(head.sessionId, head.data.approvalKey)
 *     deny → isError block「用户拒绝执行：{reason}」status fail
 * - callback：调 tool.onReply(payload, ctx) → ToolRunResult → status=success/fail
 *
 * head 类型含 data:ApprovalData + sessionId（PendingToolCall 子集，调用方 handleToolReply 中
 * peekPendingToolCall 返的 head 本就含这些字段，无需新增 store 读取）。
 *
 * @returns newBlock：替换占位的 ToolResultBlock（content + status + isError + 保留 toolCallId）
 */
async function dispatchByHandleType(
  spec: RunSpec,
  head: {
    handleType: string;
    toolName: string;
    toolCallId: string;
    /** approval 分支需读 data（ApprovalData.arguments/reason/approvalKey） */
    data: { questions?: unknown } | ApprovalData;
    /** approval allow_always 分支需读 sessionId */
    sessionId: string;
  },
  replyBlock: ToolReplyBlock,
): Promise<{ newBlock: ToolResultBlock }> {
  const baseResult: ToolResultBlock = {
    type: 'tool_result',
    toolCallId: head.toolCallId,
    content: [],
    isError: false,
  };

  if (head.handleType === 'direct_result') {
    // payload（FeedbackAnswer）序列化为 JSON 文本（LLM 可读）
    const payloadText = JSON.stringify(replyBlock.payload, null, 2);
    return {
      newBlock: {
        ...baseResult,
        content: [{ type: 'text', text: payloadText }],
        status: 'success',
        isError: false,
      },
    };
  }

  if (head.handleType === 'approval') {
    const approvalPayload = replyBlock.payload as { decision: 'allow' | 'allow_always' | 'deny' };
    const decision = approvalPayload.decision;

    // deny：不执行，产 isError block（tool_permission.md §6 deny 行）
    if (decision === 'deny') {
      const approvalData = head.data as ApprovalData;
      const reason = approvalData.reason ?? '用户拒绝';
      return {
        newBlock: {
          ...baseResult,
          content: [{ type: 'text', text: `用户拒绝执行：${reason}` }],
          status: 'fail',
          isError: true,
        },
      };
    }

    // allow / allow_always：查 tool + 补跑 tool.run（INV-P7 不再调 checkPermission）
    const tool = findTool(spec, head.toolName, 'approval');
    const approvalData = head.data as ApprovalData;

    // allow_always 额外记录「永远同意」（先记录再补跑，确保下次同 key 直接 fall through）
    // [v0.0.148] recordAlways async（cache-through write-through store）
    if (decision === 'allow_always') {
      await approvalManager.recordAlways(head.sessionId, approvalData.approvalKey ?? '');
    }

    // 补跑真实 tool.run，直接用 ApprovalData.arguments 作为工具输入
    // 注：不再调 checkPermission（INV-P7 已批准不二次拦截）
    const result: ToolRunResult = await tool.run(
      approvalData.arguments as Record<string, unknown>,
      buildToolCtx(spec),
    );

    return {
      newBlock: {
        ...baseResult,
        content: result.content,
        status: result.isError ? 'fail' : 'success',
        isError: result.isError,
      },
    };
  }

  // callback：调 tool.onReply(payload, ctx) → ToolRunResult
  const tool = findTool(spec, head.toolName, 'callback');
  if (!tool.onReply) {
    throw new Error(
      `handleToolReply: callback tool '${head.toolName}' has no onReply method`,
    );
  }
  const result: ToolRunResult = await tool.onReply(replyBlock.payload, buildToolCtx(spec));
  return {
    newBlock: {
      ...baseResult,
      content: result.content,
      status: result.isError ? 'fail' : 'success',
      isError: result.isError,
    },
  };
}
