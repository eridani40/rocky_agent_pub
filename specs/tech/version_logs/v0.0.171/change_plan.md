# v0.0.171 change_plan — 空 content 兜底（read 越界 error + assemble reducer）

## 背景
prod 会话 read 工具 offset 越界返回 Success + 空 text block，发给 LLM 撞 Anthropic 400 `text content is empty`。
- **Fix1**：read offset 越界 → 返回 error（isError:true + 描述实际行数）
- **Fix2**：assemble 链新增 reducer，把 user / tool(success) message 里 `text===''` 的 content block 兜底成 `"empty"`，命中写 error log（gate `enableErrorLog`）

纯技术修复，无用户可感知行为/UI 变化 → 免 PRD。免 AT/ET，仅 UT。

## change_plan（method 级，8 列）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| tools | app/server/src/tools/file-read.ts | fileReadTool.run | 修改 | offset 越界（`startIdx>=lines.length`）→ `return errorResult('[invalid_input] offset N out of range (file has M lines): <path>')`，复用 ToolErrorCode.INVALID_INPUT | 末尾换行致 lines 含尾空串，报实际内容行数时 `raw.endsWith('\n')?-1`；不破坏正常分页 / 空文件提示分支 | types.ts:322 errorResult / :290 ToolErrorCode.INVALID_INPUT | 79-94 |
| tools | app/server/src/tools/types.ts | — | 参考 | 复用 errorResult / ToolErrorCode.INVALID_INPUT，不改 | — | — | — |
| context-assemble | app/plugins/builtins/rocky_context/assemble/fill_empty_text.ts | FillEmptyText (class) | 新增 | `AssembleReducer`：`input===null→[]`；遍历 message，`role==='user'` 或 `role==='tool'`（含 `isError:false` tool_result）→ 把 `text===''` block 兜底 `"empty"`；命中且 `enableErrorLog` 开 → 写 error log | 两层结构：user 在 `message.content[i].text`；tool 嵌套 `message.content[i].content[j].text`（tool_result.content 内），都要处理；不改 DB 存储（assembly 层 transform）；不动 error tool / 非空 block / assistant | empty_message.ts:27-30 参考；ContextImplBase（types.ts:269）+ AssembleReducer 接口 | 新文件 |
| context-assemble | app/plugins/builtins/rocky_context/plugin.json | extImpls | 修改 | 加 `{implId:"fill_empty_text", point:"context_assemble_reducer", impl:"./assemble/fill_empty_text.ts", description:"__MSG_...__"}` | — | think_remove 条目（:204-209）参考 | extImpls 段 |
| context-assemble | app/plugins/scopes/default.yaml + forked.yaml | context_assemble_reducer.impls | 修改 | 插 `fill_empty_text` 于 `think_remove` 之后、`empty_message` 之前 | **两文件都改**（order 即生效序，未列会漂移） | yaml :41-48 | 同 |
| i18n | app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json | — | 新增 | `plugin.builtin.rocky_context.impl.fill_empty_text.description` | 中英两份都加 | 现有 impl 描述 key 模式 | — |
| spec-tools | specs/tech/agent/tools/[P0]file_op_tools.md | §2 错误集 | 修改 | 加「offset 越界 → invalid_input」 | doc-modifier 阶段同步 | §2 :40 | §2 |
| spec-context | specs/tech/agent/context/[P0]context_assemble_detail.md | §5 reducer 表 | 修改 | 加 fill_empty_text 行 + 顺带对齐 order 漂移（登记序 ↔ yaml 生效序） | doc-modifier 阶段同步 | §5 | §5 |

## UT（仅 UT，免 AT/ET）
- `app/server/src/tools/__tests__/tools.test.ts`：加 read offset 越界 case（返 `isError:true` + 含行数文案）；保留现有正常分页 case
- `app/plugins/builtins/rocky_context/__tests__/assemble-reducers.test.ts`：加 fill_empty_text case — user 空→"empty" / tool success 空→"empty" / tool error 空**不动** / 非空不动 / `input===null→[]`

## 不覆盖（明确排除）
- **AT/ET**：纯内部机制修复，无 API 契约/页面变更 → 用户豁免，仅 UT
- **assistant message 空 text**：本 reducer 限定 user / tool(success)，不动 assistant（按设计）
- **空 message（content 数组为空 `[]`）**：归 `empty_message` reducer 清除，不在本 reducer 职责
