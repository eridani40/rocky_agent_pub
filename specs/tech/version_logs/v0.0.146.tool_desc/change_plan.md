# v0.0.146.tool_desc change_plan — system prompt 用短 intro，消除 tool 介绍冗余

## 背景
完整 tool `description` 当前两处都传：
1. system prompt 的 `# Tool Guidance` 段（`tool_guidance.ts` mapper 拼 `- \`name\` — description`）
2. tool schema（`context-engine.ts:272` `config.tools.map(t=>t.definition)` → snapshot.tools → LLM function calling）

= 冗余。诉求：system prompt 只放一句话短简介（intro），完整 description 留给 tool schema。

## 变更（method/符号级，8 列）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|----------|------|---------|------|------|--------|
| tools/types | app/server/src/tools/types.ts | `ToolDefinition` | 接口扩展 | 新增可选字段 `intro?: string`（一句话短简介，供 system prompt Tool Guidance 用） | 可选；**不删** `description`；向后兼容（外部/非默认 plugin 不强制） | req.md | `ToolDefinition` 块 +1 行 |
| context/prompt | app/plugins/builtins/rocky_context/prompt/tool_guidance.ts | `map` + `readDefinition` | 改逻辑 | tool 列表项优先用 `intro`，无 intro 时 fallback `description`；`readDefinition` 增读 `intro` | 保留 fallback，无 intro 的 tool 行为不变（不丢信息、不破坏外部 plugin） | req.md | `map` ~3 行 / `readDefinition` ~3 行 |
| tools-defs | app/server/src/tools/*.ts、app/server/src/agent/tools/*.ts、computer-use | 各 `definition` 对象 | 补字段 | 为 `registry.ts defaultTools()` 返回的所有 tool 补 `intro`（一句话 ≤~12 词，去掉 tool schema 已覆盖的细节如 Output 格式/参数） | **不动** description/inputSchema；intro 仅 system prompt 用 | req.md | ~26 处 `definition` |

## intro 写法约定
- intro = 真正的一句话短简介，只说"做什么"，**去掉** schema 已有的细节（输出格式、参数、模式分支）。
- 示例：`read` → "Read a text file."（原 description 里 cat -n / offset/limit 细节 schema 已有，不进 intro）。
- coder 按 `defaultTools()` 清单逐个补，参考各 tool 现有 description 提炼。

## 测试范围
- **UT（coder 写）**：tool_guidance mapper —— ① 有 intro 用 intro；② 无 intro fallback description；③ 空列表不贡献片段。
- **AT 回归**（不新增 case）：现有 system prompt / tool 相关 case，确认 snapshot.tools 仍含完整 description（intro 仅新增可选字段，tool schema 不变）。
- 不新增 AT/ET case（用户裁决：需求简单）。

## spec 同步（doc-modifier 阶段）
- specs/tech/agent/context/[P0]prompt_content_files.md §4（tool_guidance 用 intro）
- specs/tech/agent/context/[P0]extension point and implementations.md §3.4（如涉及 mapper 读 intro）
- specs/tech/agent/tools/ ToolDefinition 权威定义（加 intro 字段）
