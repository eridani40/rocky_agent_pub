# v0.0.22 技术变更日志

> 概述：**prompts refine**（纯后端 infra 版本，**无 UI 改动、无新 API**）。三件事：(1) system prompt 内容优化（identity 5 要素 + rules 拆 3 section）；(2) compact prompt 结构化（CC 口径 NO_TOOLS 双保险 + 9 板块 + analysis/summary 双 block + identifier 保留）；(3) **prompt 正文文件化**——新增 `app/server/src/prompts/` 模块（`PromptHandler` 基类 + 派生 handler + content/*.md 文件），plugin 层 mapper 变薄委托 handler 取 content。
> 概念权威源（本期新增）：`specs/tech/agent/context/[P0]prompt_content_files.md`（v1.0 新建）；更新：`[P0]system_prompt.md`（0.5→0.6）、`[P0]context_compact_detail.md`（3.1→3.2）。PRD：`specs/prd/version_logs/v0.0.22/change_log.md`。调研：`specs/research/v0.0.22-system-prompt-and-compact.md`。

## 1. 锁定决策（对齐 PRD §1.2 + orchestrator 已定）

| # | 决策 | 落地 |
|---|------|------|
| 1 | 保留 mapper/reducer 双 EP（不破坏概念权威） | EP 契约、cardinality、effective order、tier_sort/dedup/budget_truncate、manifest 26 impl 全保持；仅在其下新增「文件读取层」 |
| 2 | 新模块 location = `app/server/src/prompts/`（用户需求指定） | 纯 server 核心模块，**无 plugin 依赖、无 EP 契约依赖**；覆盖 researcher §4.5「与 mapper 同目录」建议 |
| 3 | 分层：server 核心（prompts）+ plugin 层 mapper 变薄 | mapper 委托 handler.build() 取 content → 自己包 PromptFragment（id/tier/priority）+ 跑 EP；mapper 仍属 plugin impl |
| 4 | compact CC 口径 | NO_TOOLS preamble + trailer 双保险（补缺的 trailer）+ 9 板块（§3.3 通用化）+ analysis/summary 双 block + strip analysis（regex）+ identifier 保留；compact.md 模板经 CompactHandler 读，待压缩 transcript 运行时 serialize 不文件化 |
| 5 | 无新 API | `GET /session/:id/debug/system-prompt`（test gate，已存在 `app/server/src/handlers/session-debug.ts`）AT 复用验注入 |

## 2. tech spec 改动清单（concept-first 已完成）

| spec | version | 改动摘要 |
|------|---------|---------|
| `agent/context/[P0]prompt_content_files.md` | — 新建 1.0 | 新模块概念权威：定位 / 模块位置与依赖方向 / PromptHandler 抽象基类（缓存 mtime/once + 模板替换 + 降级）/ 7 派生 handler 清单 / 6 content 文件方向 / 与 mapper/reducer EP 兼容性结论 / 边界坑 |
| `agent/context/[P0]system_prompt.md` | 0.5 → 0.6 | §3 PromptCtx 注释更新；§4 内置 mapper 清单「内容来源」列更新——identity/rules 改「`prompts/content/*.md`（经 PromptHandler 读取）」；tool_guidance/skills 标「模板文件 + 运行时数据」；context_files 标「项目文件」；新增 §11 v0.0.22 变更说明 |
| `agent/context/[P0]context_compact_detail.md` | 3.1 → 3.2 | §3 重写为 CC 口径（§3.0 模板来源 / §3.1 双 block / §3.2 user message + NO_TOOLS 双保险补 trailer / §3.3 9 板块 / §3.4 identifier 保留 / §3.5 可选 merge 提示）；顶部 v0.0.13 注释标 v0.0.22 升级 |
| `agent/context/[P0]extension point and implementations.md` | 沿用 | mapper/reducer EP + 26 impl 不变（manifest 不改），仅 impl 内部委托 handler |

## 3. 落地清单（文件级变更，MANDATORY — 精确到文件/函数）

### 3.1 新增：`app/server/src/prompts/` 模块（server 核心）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/prompts/prompt-handler.ts` | 新增 | `PromptHandler` 抽象基类：`abstract build(ctx)` / `protected readContent()`（mtime 缓存 + dev 失效 / prod once）/ `protected fillTemplate(tpl, vars)`（`{{name}}` 替换）；`PromptHandlerResult` / `CachedContent` / `PromptHandlerContext` 接口 |
| `app/server/src/prompts/handlers/identity-handler.ts` | 新增 | `IdentityHandler extends PromptHandler`：`contentFile='content/identity.md'`，无动态数据，`build()` 调 `readContent()` 返正文 |
| `app/server/src/prompts/handlers/rules-handler.ts` | 新增 | `RulesHandler`：`contentFile='content/rules.md'`，无动态数据 |
| `app/server/src/prompts/handlers/tool-guidance-handler.ts` | 新增 | `ToolGuidanceHandler`：`contentFile='content/tool_guidance.md'`，`build({vars})` 从 `vars.tool_list`（调用方从 `config.tools` 拼）替换 `{{tool_list}}`；空 list → 返空 content（mapper 不贡献） |
| `app/server/src/prompts/handlers/skills-handler.ts` | 新增 | `SkillsHandler`：`contentFile='content/skills.md'`，`build({vars})` 从 `vars.skills_list` 替换 `{{skills_list}}` |
| `app/server/src/prompts/handlers/context-files-handler.ts` | 新增 | `ContextFilesHandler`：无 contentFile（读项目 `AGENTS.md`/`CLAUDE.md`），从 `ctx.cwd` 读首个存在文件 + 20000 char 截断（行为对齐既有 `context_files.ts` `readFirst`/`MAX_FILE_CHARS`） |
| `app/server/src/prompts/handlers/memory-handler.ts` | 新增 | `MemoryHandler`：no-op（D1.1 long_term_memory 未建），`build()` 返空 content |
| `app/server/src/prompts/handlers/compact-handler.ts` | 新增 | `CompactHandler`：`contentFile='content/compact.md'`，`build({vars})` 替换 `{{serialized_transcript}}`（运行时 serialize）+ 可选 `{{old_summary}}`（merge 提示铺路）；返完整压缩 user message 文本 |
| `app/server/src/prompts/content/identity.md` | 新增 | identity 正文（5 要素，≤8 行）：定位 + 能力范围 + 协作方式 + 风格基线 + 诚实性红线 |
| `app/server/src/prompts/content/rules.md` | 新增 | rules 正文（3 section，≤20 行）：`# Operating Rules` / `# Doing Tasks` / `# Tool Use` |
| `app/server/src/prompts/content/tool_guidance.md` | 新增 | tool_guidance 模板：`# Tool Guidance\n\nAvailable tools:\n{{tool_list}}` |
| `app/server/src/prompts/content/skills.md` | 新增 | skills 模板：`# Skills\n\nAvailable skills (call the \`skill\` tool by name to load full SKILL.md):\n\n{{skills_list}}` |
| `app/server/src/prompts/content/compact.md` | 新增 | compact 指令模板：NO_TOOLS preamble（CRITICAL: TEXT ONLY + 4 bullet）+ 9 板块指令（§3.3 通用化）+ 输出约束（analysis/summary 双 block）+ identifier 保留 + 可选 `{{old_summary}}` merge 提示 + NO_TOOLS trailer（REMINDER，双保险）+ `{{serialized_transcript}}` 占位符 |

### 3.2 修改：plugin 层 mapper 变薄（委托 handler）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/plugins/builtins/rocky_context/prompt/identity.ts` | 修改 | 删 `IDENTITY_CONTENT` 常量；`map()` 改为 `new IdentityHandler().build({vars:{}}).content` → 包 `{id:'identity',tier:'stable',content,priority:1000}`；保留 `IdentityMapper extends ContextImplBase implements SystemPromptMapper` 签名 |
| `app/plugins/builtins/rocky_context/prompt/rules.ts` | 修改 | 同上，委托 `RulesHandler`；保留 fragment metadata |
| `app/plugins/builtins/rocky_context/prompt/tool_guidance.ts` | 修改 | 删硬编码 `readDefinition` 拼装；`map(ctx)` 内拼 `tool_list`（从 `config.tools` 读 definition name/description）→ 传 `ToolGuidanceHandler.build({vars:{tool_list}})`；空 list → 仍返 [] |
| `app/plugins/builtins/rocky_context/prompt/skills.ts` | 修改 | 委托 `SkillsHandler`；拼 `skills_list` 从 `ctx.config.skills.entries` |
| `app/plugins/builtins/rocky_context/prompt/context_files.ts` | 修改 | 删 `CANDIDATE_FILES`/`MAX_FILE_CHARS`/`readFirst`/`resolveCwd`（迁到 `ContextFilesHandler`）；`map(ctx)` 改为 `new ContextFilesHandler().build({cwd: resolveCwd(ctx)}).content` → 包 fragment；找不到文件 → 返 [] |
| `app/plugins/builtins/rocky_context/prompt/memory.ts` | 修改 | 委托 `MemoryHandler`（no-op，行为不变，仍返 []） |

> **manifest 不改**（`plugin.json` 26 impl 的 implId / point / impl 路径 / tier / order / configSchema 全保持，仅 impl 内部委托 handler）。

### 3.3 修改：compact runner 委托 CompactHandler

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/agent/context-compact-runner.ts` | 修改 | 删 `COMPACT_PROMPT_PREFIX` 常量；`runCompact()` 内构造 taskMessage 时改为 `const compactText = new CompactHandler().build({vars:{serialized_transcript: serialized, old_summary: oldSummary?.content ?? ''}}).content`；`text: compactText`（含 NO_TOOLS preamble + 9 板块 + trailer + serialized transcript）；其余流程（markSummaryRunning CAS / forkedRunner / extractTag / setSummary / appendMessages / markSummaryDone）全保持 |

### 3.4 不变（兼容性证据）

| 文件 | 状态 | 说明 |
|------|------|------|
| `app/server/src/agent/system-prompt-builder.ts` | 不变 | `buildSystemPrompt()` 仍 mapper 链 concat → reducer 链 reduce → `\n\n`.join；fallback `config.systemPrompt` 不变 |
| `app/server/src/handlers/session-debug.ts` | 不变 | `GET /session/:id/debug/system-prompt`（test gate）仍走 `buildSystemPrompt()`，AT 复用 |
| `app/plugins/builtins/rocky_context/plugin.json` | 不变 | manifest 26 impl 不改 |
| `app/plugins/builtins/rocky_context/prompt/tier_sort.ts` / `dedup.ts` / `budget_truncate.ts` | 不变 | reducer 链全保持 |

## 4. 文件树（新模块）

```
app/server/src/prompts/                            ← 新模块（server 核心，无 plugin/EP 依赖）
├── prompt-handler.ts                              PromptHandler 抽象基类（readContent/fillTemplate/cache/降级）
├── handlers/
│   ├── identity-handler.ts                        读 content/identity.md
│   ├── rules-handler.ts                           读 content/rules.md
│   ├── tool-guidance-handler.ts                   读 content/tool_guidance.md + {{tool_list}}
│   ├── skills-handler.ts                          读 content/skills.md + {{skills_list}}
│   ├── context-files-handler.ts                   读项目 AGENTS.md/CLAUDE.md（cwd）
│   ├── memory-handler.ts                          no-op（记忆源未建）
│   └── compact-handler.ts                         读 content/compact.md + {{serialized_transcript}} [+ {{old_summary}}]
└── content/
    ├── identity.md                                identity 正文（5 要素，≤8 行）
    ├── rules.md                                   rules 正文（3 section，≤20 行）
    ├── tool_guidance.md                           tool_guidance 模板（{{tool_list}}）
    ├── skills.md                                  skills 模板（{{skills_list}}）
    └── compact.md                                 compact 指令模板（NO_TOOLS 双保险 + 9 板块 + 双 block + identifier 保留 + {{serialized_transcript}} [+ {{old_summary}}]）
```

## 5. mapper 改薄对照表（前/后）

| mapper | 前（v0.0.21） | 后（v0.0.22） |
|--------|---------------|--------------|
| identity | `map()` 返硬编码 `IDENTITY_CONTENT` 常量 | `map()` 调 `new IdentityHandler().build({}).content` → 包 fragment |
| rules | 返硬编码 `RULES_CONTENT` 常量（5 bullet） | 调 `RulesHandler`（读 rules.md，3 section 扩充） |
| tool_guidance | 内部 `readDefinition` 拼 `- \`name\` — desc` 列表 + 硬编码 header | mapper 拼 `tool_list` 传 handler；handler 读模板 + 替换 `{{tool_list}}` |
| skills | 内部 `readSkillEntries` 拼 L0 list + 硬编码 header | mapper 拼 `skills_list` 传 handler；handler 读模板 + 替换 `{{skills_list}}` |
| context_files | 内部 `readFirst`/`resolveCwd`/`MAX_FILE_CHARS` | 逻辑迁 `ContextFilesHandler`；mapper 调 handler.build({cwd}) |
| memory | no-op 返 [] | 委托 `MemoryHandler`（no-op，行为不变） |

> **tier / order / priority / configSchema 全保持**——mapper 改的是 content 来源，不是 EP 元数据。

## 6. compact 模板结构（compact.md）

```
NO_TOOLS preamble（CRITICAL: TEXT ONLY + 4 bullet：禁工具/已有 context/REJECTED 浪费 turn/必须 analysis+summary 双 block）
    ↓
主体指令（任务说明 + 按时间顺序 analysis 提示）
    ↓
9 板块要求（§3.3 通用化：会话目标/关键事实决策/已完成工作/错误修正/问题进展/用户消息要点/待办/当前状态/续作上下文）
    ↓
输出约束（<analysis>...</analysis> 后 <summary>...</summary>；analysis 会被 strip 不落库）
    ↓
identifier 保留（UUID/path/URL/hostnames/IDs 不缩写、不重构）
    ↓
[可选] {{old_summary}} merge 提示（铺路 §4 future；本期 coder 决定是否启用）
    ↓
NO_TOOLS trailer（REMINDER: Do NOT call any tools，双保险，放最末）
    ↓
{{serialized_transcript}}（运行时 serializeMessages 拼接，不文件化）
```

## 7. 降级策略（MANDATORY — 不中断 builder）

| 场景 | 行为 |
|------|------|
| content 文件不存在 | handler 用 `fallback` 常量（若声明）→ 否则返空 content |
| 读文件抛错（权限/编码） | 同上 + warn log，不抛 |
| 模板变量缺失 | 占位符替空串，不抛 |
| 子类动态数据缺失（tools 空 / skills 空） | handler 返空 → mapper 不贡献 fragment |
| compact handler 失败 | compact runner catch 走 markSummaryFailed（既有路径不变） |

> 单 mapper 失败 → 「不贡献」（system_prompt §9.4）—— handler 异常都返空 content，让上游 mapper 决定。

## 8. 测试要点

### 8.1 UT（白盒）

| 模块 | case 方向 |
|------|----------|
| `PromptHandler` 基类 | readContent mtime 缓存命中 / dev 失效（改 mtime 重读）/ prod once（不重读）；fillTemplate `{{x}}` 替换 / 缺失变量替空；缺文件降级返 fallback / 空 |
| IdentityHandler / RulesHandler | 读对应 content 文件成功 → content 非空；缺文件 → 降级 |
| ToolGuidanceHandler | `tool_list` 非空 → 模板替换含列表；空 → 返空 |
| SkillsHandler | 同上（skills_list） |
| ContextFilesHandler | cwd 有 AGENTS.md → 读到；无 → 返空；超大文件 → 截断 |
| CompactHandler | `serialized_transcript` 替换；含 NO_TOOLS preamble + trailer；缺变量 → 占位符替空 |
| mapper 委托（identity/rules/tool_guidance/skills/context_files/memory） | map() 返 fragment 含 handler.build().content；metadata（id/tier/priority）保持；动态数据缺失 → 返 [] |
| compact runner | `COMPACT_PROMPT_PREFIX` 删除 → taskMessage.text 来自 CompactHandler；含 NO_TOOLS preamble+trailer；其余流程（CAS/forkedRunner/extractTag/setSummary/appendMessages/markSummaryDone）不回归 |

### 8.2 AT（黑盒，真服务）

| 路径 | case 方向 | 端点 |
|------|----------|------|
| 路径 4（注入验证） | debug 端点返 systemPrompt 含 identity 5 要素关键句 + rules 3 section header + tool_guidance 列表 + skills 列表（若有）；文件化内容被正确注入 | `GET /session/:id/debug/system-prompt`（test gate，已存在） |
| 路径 1（发消息收回复） | 真 LLM 主链路 PASS；agent 行为符合优化后规则（如不编造） | `POST /session/:id/chat`（SSE） |
| 路径 3（手动 compact） | 手动触发 forked agent；summary 含结构化板块；transcript 插 `compact_notice` system message（metadata.kind=compact_notice） | `POST /session/:id/compact`（202 / 409） |
| 路径 2（自动 compact） | 多轮超阈值 → 自动 compact 成功；summary 落库；续对话正常 | 真 LLM 多轮 |

> **AT 复用 `tests/api/` 既有 case**（health / chat / compact / debug-system-prompt），新 case 视情况增补到 `tests/api/{module}/`。无新 API 故 API spec 不改。

### 8.3 E2E

无 UI 改动 → E2E 视觉门禁跳过。E2E 主要做对话 + compact 主链路行为回归（真 LLM 不可控，弱覆盖）。

## 9. 与既有 mapper/reducer 概念的兼容性结论

| 维度 | 兼容性 |
|------|--------|
| EP 契约（`SystemPromptMapper.map` / `SystemPromptReducer.reduce`） | ✅ 不变 |
| EP cardinality / effective order | ✅ 不变 |
| PromptFragment 结构（id/tier/content/priority） | ✅ 不变 |
| tier_sort / dedup / budget_truncate reducer | ✅ 不变 |
| builder（`buildSystemPrompt` `\n\n`.join + fallback） | ✅ 不变 |
| manifest（26 impl 的 implId/point/impl 路径/tier/order/configSchema） | ✅ 不变 |
| debug 端点（`GET /session/:id/debug/system-prompt`） | ✅ 不变（AT 复用） |
| compact 执行路径（CAS / forkedRunner / extractTag / setSummary / appendMessages / markSummaryDone） | ✅ 不变（仅 taskMessage.text 来源从常量改 handler） |
| 新增依赖方向 | ✅ plugin → server（mapper 反向依赖 handler 是正常方向）；server 核心 prompts 模块**不**反向依赖 plugin / EP 契约 |

**结论**：本版本是「内容优化 + 加文件读取层」，不破坏任何既有概念权威。mapper/reducer 双 EP 仍是 system prompt 构建的权威扩展点；新模块 `app/server/src/prompts/` 是其下的「正文内容源」实现层。

## 10. 版本

version: v0.0.22（prompts refine — system prompt 内容优化 + compact 结构化 + prompt 文件化；纯后端 infra，无 UI、无新 API；concept-first 已完成：`[P0]prompt_content_files.md` v1.0 新建 + `[P0]system_prompt.md` 0.6 + `[P0]context_compact_detail.md` 3.2）
