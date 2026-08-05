# v0.0.146.tool_desc — Tech Change Log（ToolDefinition 加 intro：system prompt 用短简介，消除 tool 介绍冗余）

> 跨版本发布说明（版本轴）。本目录级变更见 `specs/tech/agent/tools/log.md` + `specs/tech/agent/context/log.md`（位置轴，2026-07-15 块）。
> 权威变更契约见同目录 `change_plan.md`（3 符号行 / types.ts + tool_guidance.ts + 26 tool definition）。

## 概览

完整 tool `description` 此前两处都传：① system prompt 的 `# Tool Guidance` 段（`tool_guidance.ts` mapper 拼 `- \`name\` — description`）；② tool schema（`context-engine.ts:272` `config.tools.map(t=>t.definition)` → snapshot.tools → LLM function calling）。= 冗余。

本版本给 `ToolDefinition` 新增可选 `intro?: string`（一句话短简介），system prompt Tool Guidance 段改用 `intro ?? description`（优先 intro、fallback description）；完整 description 仍留给 tool schema 不变。消除 system prompt 与 tool schema 的 description 冗余。26 个默认 tool 全补 intro。

**设计意图**：system prompt 与 tool schema 两处都发完整 description 是 token 浪费 + 维护双份；intro 让 system prompt 只放一句话定位，细节（输出格式 / 参数 / 模式分支）由 tool schema 承载——LLM function calling 本就读 schema，system prompt 无须复述。可选字段 + fallback 保证向后兼容（外部/非默认 plugin 不强制）。

## §1 ToolDefinition 接口扩展（tools/types）

- **`app/server/src/tools/types.ts` `ToolDefinition`**：新增可选字段 `intro?: string`——一句话短简介，供 system prompt Tool Guidance 用（tool_guidance mapper）；无则 fallback 用 description。去掉 schema 已覆盖的细节（输出格式 / 参数 / 模式分支），避免 system prompt 与 tool schema 重复。
- **约束**：**可选**（外部/非默认 plugin 不强制）；**不删 `description`**（tool schema 仍用）；**不动 `inputSchema`**；向后兼容。
- **intro 写法约定**：真正的一句话短简介，只说"做什么"，去掉 schema 已有的细节。示例：`read` → "Read a text file."（原 description 里 cat -n / offset/limit 细节 schema 已有，不进 intro）；≤~12 词。

## §2 tool_guidance mapper 改逻辑（context / rocky_context plugin）

- **`app/plugins/builtins/rocky_context/prompt/tool_guidance.ts`**：
  - `map()`：tool 列表项优先用 `intro`，无 intro 时 fallback `description`——`const descText = def.intro ?? def.description;`。保留 fallback，**无 intro 的 tool 行为不变**（不丢信息、不破坏外部 plugin）。
  - `readDefinition()`：duck-typed 读 tool.definition 增返 `intro?`（`typeof introRaw === 'string' ? introRaw : undefined`），与 `name` / `description` 并列。
- **ToolGuidanceHandler / `content/tool_guidance.md` 模板不动**：模板仍是 `# Tool Guidance\n\nAvailable tools:\n{{tool_list}}`，`{{tool_list}}` 由 mapper 拼好后经 `vars` 传入；intro 选择逻辑在 mapper 层，handler 纯模板替换不感知。

## §3 默认 tool 补 intro（26 处）

- **`app/server/src/tools/*.ts`、`app/server/src/agent/tools/*.ts`、`tools/computer-use/*.ts` 各 `definition` 对象**：为 `registry.ts defaultTools()` 返回的所有 tool 补 `intro`（一句话，去掉 tool schema 已覆盖的细节如 Output 格式 / 参数 / 模式分支）。**不动 `description` / `inputSchema`**；intro 仅 system prompt 用。

## §4 测试范围

- **UT**（coder 写）：tool_guidance mapper —— ① 有 intro 用 intro；② 无 intro fallback description；③ 空列表不贡献片段。
- **AT 回归**（不新增 case）：现有 system prompt / tool 相关 case，确认 `snapshot.tools` 仍含完整 description（intro 仅新增可选字段，tool schema 不变）。
- 不新增 AT/ET case（用户裁决：需求简单，普通 feature 不进持久用例库）。

## §5 spec 同步清单

| KB / 目录 | 文件 | 变更 |
|---|---|---|
| tools tech | `index.md` | §1 概念表 ToolDefinition 行加 `intro` 字段说明（无则 fallback description）；frontmatter updated → 2026-07-15 |
| tools tech | `[P0]tool_execution_engine.md` | §2 ToolDefinition 注释加 `intro` 字段说明 + 修正 stale `[P0]overall.md §2` ref → `app/server/src/tools/types.ts`（overall.md 已并入 index.md，详细接口权威源 = types.ts） |
| context tech | `[P0]prompt_content_files.md` | §4 `ToolGuidanceHandler` 行 + §5 `tool_guidance.md` 行：`name+description` → `name + (intro ?? description)`；frontmatter updated |
| context tech | `[P0]system_prompt.md` | §4 `tool_guidance` 行：`name+description` → `name + (intro ?? description)` |
| context tech | `[P0]extension point and implementations.md` | §3.4 `tool_guidance` 行补「优先 intro」说明（§5 manifest jsonc 不动——镜像 plugin.json 注册描述，行为契约在 §3.4） |
