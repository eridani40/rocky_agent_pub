# v0.0.331 change_plan：a2a out 信封展开空白（P0+P1+P1'+P2 全做）

> 架构期冻结契约。planner 按此切 task，coder 按此实现，reviewer 按此查偏离。coder/doc-modifier 不改本文件。
> 上游：reqs/[working] v0.0.331.a2a-envelope-out-blank.md + temp/bug-a2a-envelope-out-blank-2026-08-12.md（bug-analyst 337 行实证，§5/§8/§9/§10.4 权威）

## 根因（实证）

v0.0.311（4031f1b9f）out 信封 bodyText 提取源从「后端已 normalize 的 tool_result」切到「LLM 原始 arguments」，但只兼容 `array + block.type==='text'` 一种形态。真实 LLM（glm/deepseek 17-20%）传 `[{"text":"..."}]`（block 缺 type）→ 后端 `normalizeSendMessageInput` 只认 text 字段容错发送成功 → 前端 `filter(c=>c.type==='text')` 全滤 → 展开空白。数据：4451 条 send_message 中缺 type 311 后 38 条（11%）。

## 方案总览（老板裁定全做）

| 优先级 | 方案 | 作用 |
|---|---|---|
| P0 | 前端 `extractSendMessageBody` 容错提取 | 立即止血展示空白（含历史脏数据兜底） |
| P1 | 落库前 normalize arguments.content（缺 type 补 `type:'text'`） | 治本：新数据永不空白 + 切断 LLM 上下文自增强 |
| P1' | `safeParseArgs` 失败加 `_rawTruncated: true` + 前端明确「发送失败（参数截断）」 | 第二类空白可见 |
| P2 | send-message-tool desc 加字面示例 + 强调每 block 必须含 type | 防再生（对 glm/deepseek 部分有效） |

**关键关系**：P1 只修新落库；历史已存缺 type 数据靠 P0 前端容错兜底（两者互补，缺一不可）。

## 公共函数决策（防漂移）

- 在 `send-message-tool.ts` 抽 **`export function normalizeContentBlocks(rawContent: unknown): ContentBlock[]`**（语义来源唯一，与工具定义同文件；normalizeSendMessageInput 内部复用同一函数，落库前 normalize 也 import 它 → 前后端/多处永不漂移）
- 落库前 normalize 只在 `name === 'send_message'` 且 arguments 无 `_raw` 时生效（_raw 半截路径由 P1' 标记，不补 content）
- 发给 LLM 的 tool_use 块形状（protocol-encode-helpers.ts L48-50 `input: b.arguments` 逐字节透传）：normalize 后进入上下文的是**补全形态**（缺 type → 补 `type:'text'`），语义不变，无副作用

## method 级变更清单

### 前端（P0 + P1' 展示）

| # | 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| D1 | web chat-page | `app/web/src/components/chat-page/component-message-stream.tsx` | `extractSendMessageBody(argContent: unknown): string` | 新增 | 文件级导出函数，与后端 normalize 等价容错：①array → 每块 `typeof c==='object' && typeof c.text==='string'` 取 text join('\n')（**不要求 type==='text'**，缺 type 按默认 text）②string → 直接当正文 ③object → 取 `.item ?? obj`，`payload` 为 string 直接用、`payload.text` 为 string 用 text ④其他 → `''` | MUST：只认 text 字段（与 normalizeSendMessageInput 对齐）；MUST NOT：不读 type 字段做过滤；MUST：export 供 UT | bug-analyst §5.1 | ~20 |
| D2 | web chat-page | 同上 | `component-message-stream.tsx` L304-311 bodyText 提取 | 修改 | 内联提取逻辑替换为 `const bodyText = extractSendMessageBody(argContent)` | MUST：行为对 array 正常形态零变化；MUST NOT：改动 errText 逻辑（本 D 只改 bodyText） | D1 | 8→1 |
| D3 | web chat-page | 同上 | errText 分支（L313-319） | 修改 | `envRow.arguments?._rawTruncated === true` 时 errText 显示 `'发送失败（参数截断）'`（优先于 result 提取）；否则原逻辑不变 | MUST：只影响 _rawTruncated 场景；MUST NOT：改正常 error 态展示 | bug-analyst §6.5 P1 | ~4 |

### 后端（P1 + P1' + P2）

| # | 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| D4 | server tools | `app/server/src/agent/tools/send-message-tool.ts` | `normalizeContentBlocks(rawContent: unknown): ContentBlock[]` | 新增+导出 | 抽公共函数：把现有 normalizeSendMessageInput L253-276 的 block 循环（object 校验 text 是 string + 缺 type 补 `type:'text'` + 未知 type 不透传）抽成独立导出函数；string → 包数组、object → `.item ?? obj` 解包、单 block object → 包数组，均在此函数内完成 | MUST：与现 normalize 行为逐字段一致（有 send-message-tool.test.ts 兜底）；MUST NOT：改变 error 语义（text 非 string → 返回 error 形态由调用方处理） | bug-analyst §5.2 落点①；leader 架构判断「公共函数抽取位置」 | ~25 |
| D5 | server tools | 同上 | `normalizeSendMessageInput` L206-276 | 修改 | 内部 content 处理改为调用 `normalizeContentBlocks`（删重复循环），行为零变化 | MUST：回归全绿（send-message-tool.test.ts 现有用例全过）；MUST NOT：改 target/needReply/inReplyTo 处理 | D4 | -15 |
| D6 | server tools | 同上 | description L28 | 修改 | `'content is an array of {type:"text", text:string} blocks. '` → `'content is an array of {type:"text", text:string} blocks, e.g. [{"type":"text","text":"hi"}]. Each block MUST include the "type" field. '` | MUST：只改 content 相关 desc 行；MUST NOT：改其他 desc/schema | bug-analyst §5.3 | 1 |
| D7 | server agent | `app/server/src/agent/agent-loop-stream.ts` | `closeActive()` L246-253 | 修改 | `const args = safeParseArgs(a.argumentsBuf)` 后加：`const finalArgs = a.toolName === 'send_message' && args._raw === undefined ? { ...args, content: normalizeContentBlocks(args.content) } : args;`，block.arguments 用 finalArgs | MUST：仅 send_message 且非 _raw 时 normalize；MUST NOT：改其他工具/其他字段；MUST：import normalizeContentBlocks from tools/send-message-tool（无循环依赖） | bug-analyst §5.2 落点① | ~4 |
| D8 | server agent | 同上 | `safeParseArgs` L295-306 | 修改 | parse 失败返回 `{ _raw: buf, _rawTruncated: true }`（加标记） | MUST：_raw 保留原值；MUST NOT：改 parse 成功路径 | bug-analyst §6.5 P1 | 1 |
| D9 | server agent | `app/server/src/agent/replay-collector.ts` | reconstitute L175-178 | 修改 | `arguments: safeParseArgs(_argumentsBuf)` 后加同 D7 normalize（`rest.name === 'send_message'` 且无 _raw → 补 content） | MUST：与 D7 同语义；MUST NOT：改其他 block 类型 | bug-analyst §5.2 落点① | ~4 |
| D10 | server agent | 同上 | `safeParseArgs` L191-202 | 修改 | parse 失败返回 `{ _raw: buf, _rawTruncated: true }`（与 D8 同构） | MUST：与 D8 同 | bug-analyst §6.5 P1 | 1 |

### UT（同步更新）

| # | 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| D11 | server test | `app/server/src/agent/__tests__/replay-collector.test.ts` | L111-122 `_raw` 断言 | 修改 | `expect(tc.arguments).toEqual({ _raw: '...' })` → `{ _raw: '...', _rawTruncated: true }`；新增 send_message 缺 type arguments 落库后补 `type:'text'` 断言 | MUST：同步 _raw 形态；MUST NOT：删既有半截用例 | D8/D10 | ~6 |
| D12 | server test | `app/server/src/agent/tools/__tests__/send-message-tool.test.ts` | normalize 用例 | 修改 | 新增 `normalizeContentBlocks` 直接用例（array 缺 type→补 text / string→包数组 / object item 解包 / text 非 string→error / 空） | MUST：覆盖 D4 全部形态 | D4 | ~15 |
| D13 | web test | `app/web/src/components/chat-page/__tests__/component-message-stream-strategy.test.tsx`（或 components.test.tsx） | extractSendMessageBody 用例 | 新增 | 用例：array 正常 / array 缺 type / string / object（item 包裹）/ 空 / _rawTruncated 展示「发送失败（参数截断）」 | MUST：覆盖 D1/D3 全部形态 | D1/D3 | ~20 |

## 不做（范围边界）

- 不改发送链路（后端 normalizeSendMessageInput 已正确，对端接收正常）
- 不改 protocol-encode / clean-view / context-compact（normalize 后透传的是补全形态，无需改动）
- 不做 P3（容错带 warning 反馈）——可选长期收敛，本轮不实现
- 不动 message-flatten.ts（arguments 原样透传给 envelope，提取容错在 D1）
- 不改历史数据（存量脏数据靠 P0 前端兜底，不做数据迁移）

## 影响面

- normalize 只影响 `send_message` 的 arguments.content，其他工具零动
- `_rawTruncated` 是新字段，仅前端 D3 消费；`_raw` 内容不变（不进 LLM 上下文的部分依旧不进）
- 发给 LLM 的 tool_use.input 为补全形态（缺 type → `type:'text'`），语义不变
