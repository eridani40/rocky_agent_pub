/**
 * mock-llm-scenarios — mock fetch 的剧本构造函数（从 mock-llm.ts 拆分）
 * 参考: states/v0.0.8/verify/test-plan.md §0（四剧本：mock:text/tool/error/compact）
 *       specs/research/v0.0.3-anthropic-protocol.md §3/§4（anthropic wire 格式）
 *
 * 含两类构造器：
 *   - 流式 SSE 帧（stream:true，client.stream 用）
 *   - 非流式标准 JSON（stream:false，client.call 用）—— BUG-002 修复新增
 *
 * 从 mock-llm.ts 拆出以满足单文件 ≤300 行约束。
 */

/** 构造 message_start 帧前缀（每个剧本共用） */
export function msgStart(): string {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_mock","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}',
    '',
  ].join('\n');
}

/** 构造 text 块（content_block_start + delta + stop，index 由调用方指定） */
export function textBlock(index: number, text: string): string {
  return [
    'event: content_block_start',
    `data: {"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}`,
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
    '',
    'event: content_block_stop',
    `data: {"type":"content_block_stop","index":${index}}`,
    '',
  ].join('\n');
}

/** 构造 tool_use 块（bash echo hi）—— mock:tool 首轮 */
export function toolUseBashBlock(index: number): string {
  return [
    'event: content_block_start',
    `data: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","id":"tool_mock_1","name":"bash","input":{}}}`,
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":${index},"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"echo hi\\"}"}}`,
    '',
    'event: content_block_stop',
    `data: {"type":"content_block_stop","index":${index}}`,
    '',
  ].join('\n');
}

/**
 * 构造 tool_use 块（单 `computer` tool，input = directive 提供的 arguments）。
 * [v0.0.105] mock LLM 见 user 含 @@cu:<json>@@ → 出此 tool_call（name='computer'，arguments=json）。
 * @param index content block 序号
 * @param input directive 解析出的 tool arguments（如 {action:'screenshot'} / {action:'click',element_index:3}）
 */
export function toolUseComputerBlock(index: number, input: unknown): string {
  // input 先序列化成 JSON 串，再作为 partial_json 的字符串值嵌入（与 toolUseBashBlock 同范式）
  const inputJson = JSON.stringify(input);
  return [
    'event: content_block_start',
    `data: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","id":"tool_cu_1","name":"computer","input":{}}}`,
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":${index},"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(inputJson)}}}`,
    '',
    'event: content_block_stop',
    `data: {"type":"content_block_stop","index":${index}}`,
    '',
  ].join('\n');
}

/** 构造 usage + finish 帧后缀（每个剧本共用） */
export function usageAndFinish(stopReason: string, outputTokens: number): string {
  return [
    'event: message_delta',
    `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"input_tokens":10,"output_tokens":${outputTokens}}}`,
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');
}

/** mock:text 剧本（纯文本回复，流式 SSE） */
export function buildTextScenario(): string {
  return [msgStart(), textBlock(0, '你好，我是助手'), usageAndFinish('end_turn', 8)].join('\n');
}

/**
 * mock:tool 剧本（首轮 text+tool_use；续轮纯文本）。
 * @param isFollowup 是否续轮（request 末尾是 role=tool 的 tool_result）
 */
export function buildToolScenario(isFollowup: boolean): string {
  if (isFollowup) {
    return [msgStart(), textBlock(0, '工具执行完毕，结果如上。'), usageAndFinish('end_turn', 10)].join('\n');
  }
  return [
    msgStart(),
    textBlock(0, '我来执行一个命令'),
    toolUseBashBlock(1),
    usageAndFinish('tool_use', 12),
  ].join('\n');
}

/**
 * [v0.0.105] computer use 剧本（单 `computer` tool；首轮 text+computer tool_use；续轮 text end_turn）。
 * mock LLM 见 last user 含 @@cu:<json>@@ 触发（不看 model；directive 驱动）。<json> = tool arguments。
 * json 解析失败 → 返 undefined（mock-llm fail-safe 回退默认剧本）。
 * @param inputJson directive 提取的原始 json 串（未解析）
 * @param isFollowup 是否续轮（request 末尾是 role=tool 的 tool_result，即工具已回灌）
 * @returns SSE 剧本串；json 解析失败返 undefined
 */
export function buildComputerScenario(inputJson: string, isFollowup: boolean): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return undefined; // fail-safe：directive json 非法 → 回退非 directive 分支
  }
  if (isFollowup) {
    return [msgStart(), textBlock(0, '操作已完成，结果如上。'), usageAndFinish('end_turn', 10)].join('\n');
  }
  return [
    msgStart(),
    textBlock(0, '我来操作电脑。'),
    toolUseComputerBlock(1, parsed),
    usageAndFinish('tool_use', 12),
  ].join('\n');
}

/** mock:error 剧本（HTTP 500 + SSE error event） */
export function buildErrorSse(): string {
  return [
    'event: error',
    'data: {"type":"error","error":{"type":"overloaded_error","message":"mock error: server overloaded"}}',
    '',
    '',
  ].join('\n');
}

/**
 * mock:compact 流式剧本（足够长文本，触发 char 估算超阈值）。
 * 长 text 让 inputCharCount 超出 tokenLimit，触发 contextEngine.compact。
 */
export function buildCompactScenario(): string {
  const longText = '这是一个很长的回复用于触发 compact 流程。'.repeat(50);
  return [msgStart(), textBlock(0, longText), usageAndFinish('end_turn', 800)].join('\n');
}

/** v0.0.3 默认流式剧本（兼容既有 mock-llm.test.ts：thinking + text） */
export function buildMockAnthropicSse(): string {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_mock","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我想想"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');
}

// ============================================================
// 非流式响应（BUG-002 修复）：client.call 走 stream:false，mock 返标准 JSON
// ============================================================

/**
 * 构造标准 anthropic 非流式 message 响应（用于 stream:false 的 client.call）。
 * BUG-002：mock-llm 之前无论 stream 字段都返 SSE，导致 compact 路径
 * （用 client.call 非流式）解析失败。此函数返标准 JSON：
 *   { id, type:"message", role:"assistant", content:[{type:"text",text}], stop_reason, usage }
 *
 * @param text 文本内容（compact 路径期望含 <summary>...</summary> 标签）
 * @param stopReason finish reason（默认 end_turn）
 */
export function buildNonStreamingMessage(text: string, stopReason = 'end_turn'): string {
  const msg = {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 8 },
  };
  return JSON.stringify(msg);
}

/**
 * mock:compact 非流式响应：content 含 <summary>...</summary>。
 * compact 解析 extractTag(resp.message.content, "summary") 拿到摘要正文。
 */
export function buildCompactNonStreaming(): string {
  const summary = '这是压缩后的对话摘要：用户讨论了多个话题，助手均已回应。';
  return buildNonStreamingMessage(`<summary>${summary}</summary>`);
}
