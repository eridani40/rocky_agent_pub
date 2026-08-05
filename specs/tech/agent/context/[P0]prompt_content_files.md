---
type: interface
title: Prompt Content Files（prompt 正文文件化）
priority: P0
status: active
updated: 2026-08-04
since: v0.0.22
---

# Prompt Content Files（prompt 正文文件化）

> 主文档：`[P0]system_prompt.md`（mapper/reducer/builder 权威）、`[P0]context_compact_detail.md`（compact 权威）、`[P0]extension point and implementations.md`（EP impl 索引）。
> 调研依据：`specs/research/v0.0.22-system-prompt-and-compact.md`（§4.1-§4.5）。

## 1. 定位

system prompt 与 compact prompt 的**正文内容源**从「代码内置常量」改为「**文件读取**」。本模块定义 server 核心的「文件读取 + handler 构建层」，由 plugin 层（`rocky_context` 的 prompt mapper、compact runner）委托取内容。

**管什么**：
- prompt **正文 / 模板** 的文件落点（`app/server/src/prompts/content/*.md`，17 个文件，见 §5）。
- `PromptHandler` 抽象基类 + 派生子类构建各 section 的通用骨架（读文件 + 缓存 + 模板替换 + 降级）。
- 文件读取层与既有 mapper/reducer EP 的关系（不引入新 EP，不改 EP 契约）。
- **[v0.0.153] 非 system-prompt 的独立文案模板**：auto-naming 起名提示词 / memory-routing 决策文案 / forked agent reminder / squad heartbeat tick——这些不是 system prompt fragment（不走 mapper/reducer EP），但同样复用 `PromptHandler` 的读取/缓存/模板替换/降级机制（见 §4.2）。
- **打包/部署完整性自检**（`checkPromptContentAssets()`，见 §3.4）——防「content 目录整体缺失导致全链路静默降空」。

**不管什么**：
- mapper/reducer EP 本身（→ `[P0]system_prompt.md` §3）、EP 排序（→ effective order，同上 §2）。
- compact 执行路径（→ `[P0]context_compact_detail.md` §2）、旁路 run 执行器（→ `[P0]agent_loop_side_run.md`）。
- 「条件分支逻辑」（如按 `config.tools` 选 tool、按 model family 注入 guidance）仍留代码（mapper 子类内），**不文件化**（调研 §4.5）。
- 「待压缩内容」段（运行时 transcript serialize）**不文件化**（仅文件化压缩指令模板，调研 §4.5）。

## 2. 模块位置与依赖方向

```
app/server/src/prompts/                  ← 新模块（纯 server 核心）
├── prompt-handler.ts                    PromptHandler 抽象基类 + CRITICAL_CONTENT_FILES + checkPromptContentAssets()（§3.4）
├── routing-decision.ts                  RoutingDecisionHandler（模块私有，不导出）+ 导出常量 ROUTING_DECISION_PROMPT（§4.2）
├── handlers/
│   ├── identity-handler.ts              读 content/identity.md
│   ├── rules-handler.ts                 读 content/rules.md
│   ├── tool-guidance-handler.ts         读 content/tool_guidance.md 模板 + config.tools 数据
│   ├── skills-handler.ts                读 content/skills.md 模板 + skill entries 数据
│   ├── context-files-handler.ts         读 AGENTS.md/CLAUDE.md（项目文件，非 content 目录）
│   ├── memory-handler.ts                no-op（记忆源未建）
│   ├── compact-handler.ts               读 content/compact.md 模板
│   ├── consolidation-handler.ts         读 content/consolidation.md 模板 + {{routing_rules}}/{{agents_paths}}/{{scope_table}}
│   ├── consolidation-tier2-handler.ts  读 content/consolidation_tier2.md 模板（v0.0.151.t2；v0.0.238 加 {{write_scope}}）
│   ├── auto-naming-handler.ts           [v0.0.153] 读 content/auto_naming.md + {{query}}
│   ├── side-run-reminder-handler.ts      [v0.0.153] 读 content/side_run_reminder/*.md（骨架 + 三态 + runKind tail，多段读取）；v0.0.204 rename 自 forked-reminder-handler.ts
│   └── heartbeat-tick-handler.ts        [v0.0.153] 读 content/tick_heartbeat.md（无占位符）
└── content/
    ├── identity.md / rules.md / tool_guidance.md / skills.md / compact.md / consolidation.md / consolidation_tier2.md
    ├── auto_naming.md / routing_decision.md / tick_heartbeat.md            [v0.0.153]
    ├── squad/{leader,mate,squad_chat}.md                                  squad_role mapper 专属（见 ../../squad/[P1]prompt_sections.md §3.1）
    └── side_run_reminder/{skeleton,tools_none,tools_all,
                            mode_tail_summary,mode_tail_consolidate}.md    [v0.0.153] v0.0.204 rename 自 forked_reminder/（mode_tail_memory_extract→mode_tail_consolidate 同 runKind rename）
```

**依赖方向**（严格，不可反向）：

```
plugin-sdk → plugins (rocky_context prompt mapper) → server (app/server/src/prompts/) → protocol
```

- `app/server/src/prompts/` 是**纯 server 核心模块**：**无 plugin 依赖**（不 import `@easy-harness/plugins` 或 `rocky_context`）、**无 EP 契约依赖**（不 import `SystemPromptMapper` 等接口，避免双向耦合）。
- `rocky_context` 的 prompt mapper（plugin 层）**变薄**：委托 handler 取 content → 自己只包 `PromptFragment`（id/tier/priority）+ 跑 EP。
- compact runner（server 层）委托 `CompactHandler` 取压缩 user message 文本。

## 3. PromptHandler 抽象基类

```typescript
/** handler 构建结果（content + 可选 fragment 元数据 hint） */
interface PromptHandlerResult {
  /** section 正文（已替换占位符、已拼接动态段） */
  content: string;
}

/** 文件内容 + mtime 缓存项 */
interface CachedContent {
  text: string;
  mtimeMs: number;
}

/**
 * PromptHandler 抽象基类（server/src/prompts/prompt-handler.ts）。
 * 子类 override `build()` 提供动态段 + 选 content 文件；基类负责读文件、缓存、模板替换、降级。
 */
abstract class PromptHandler {
  /** content 文件绝对路径（如 .../prompts/content/identity.md）；空表示不读文件 */
  protected abstract readonly contentFile?: string;
  /** 降级常量（读文件失败时用；可选） */
  protected readonly fallback?: string;

  /** 主入口：子类提供动态数据（如 tools/skills/serialized transcript） */
  abstract build(ctx: PromptHandlerContext): PromptHandlerResult;

  /**
   * 子类调：读 content 文件（带 mtime 缓存）。
   * @param relPath [v0.0.153] 可选，指定读取 content/ 下的哪个相对路径文件；缺省 = this.contentFile。
   *                子类需在同一实例内读取多个 content 段时传入（如 SideRunReminderHandler 读
   *                skeleton.md 之外的 tools_none.md/mode_tail_*.md）；不传时向后兼容原有零参调用。
   */
  protected readContent(relPath: string | undefined = this.contentFile): string {
    // dev: mtime 变 → 重读；prod: once cache（启动读一次后不重读）
    // 失败 → 返 this.fallback ?? ''
  }

  /** 子类调：模板替换 {{placeholder}} → ctx.vars 值 */
  protected fillTemplate(template: string, vars: Record<string, string>): string {
    // 形如 `{{tools}}` 替换为 vars['tools']；未提供 → 替换为空串
  }
}

/** handler 通用上下文（不依赖 SessionConfig/EP 契约，避免反向耦合） */
interface PromptHandlerContext {
  /** 动态数据：tools / skills / serialized transcript / 老 summary 等（子类按需读） */
  vars: Record<string, string>;
  /** 项目工作目录（context_files handler 读 AGENTS.md 用） */
  cwd?: string;
}
```

### 3.1 缓存策略

| 环境 | 策略 | 失效 key |
|------|------|---------|
| dev（`NODE_ENV=development` 或缺省） | mtime 检测 | 文件 `mtimeMs` 变 → 重读 |
| prod（`NODE_ENV=production`） | once cache | 启动读一次，整进程不重读（除非显式 `invalidate()`） |

> **cache 友好**：stable tier 内容文件（identity/rules/tool_guidance 模板/skills 模板）极少变 → prompt cache 命中。mtime 仅作 dev 失效 key（不进 prompt 文本，避免破 cache）。

### 3.2 模板替换

content 文件可含 `{{placeholder}}` 占位符（如 `{{tool_list}}`、`{{skills_list}}`）。子类 `build()` 内调 `fillTemplate(template, vars)` 替换。未提供 vars → 占位符替换为空串（不报错）。**[v0.0.54] `compact.md` 不再含任何占位符**（改纯 directive，见 §4 CompactHandler 条目）。

### 3.3 降级策略（MANDATORY — 不中断 builder）

| 场景 | 行为 |
|------|------|
| content 文件不存在 | 用 `this.fallback`（若声明）→ 否则返空串（`content: ''`） |
| 读文件抛错（权限/编码） | 同上，记 warn log，不抛 |
| 模板替换部分变量缺失 | 占位符替空串，不抛 |
| 子类动态数据缺失（如 `config.tools` 空） | 子类自行决定（如 tool_guidance 返空 → mapper 不贡献 fragment） |

> **单 mapper 失败降级为「不贡献」**（`[P0]system_prompt.md §9.4`）—— handler 返空 content → mapper 见空数组不贡献 fragment，不中断整个 builder。

### 3.4 打包完整性自检（MANDATORY — v0.0.153 起）

**背景（BUG-001 教训）**：单文件读失败静默降级为空串（§3.3）在「意外读不到一个文件」场景是合理容错；但当**整个 `content/` 目录**因打包/部署遗漏而不存在（如 `app/server` build 脚本忘记把 `src/prompts/content/**/*.md` 复制进 `dist/`），同一降级策略会让所有 handler 全链路静默降空——dev 直接读 `src` 能命中，packaged 读 `dist` 全 miss，AT/ET 测不到（详见 `../../app/package/[P0]packaging_toolchain.md §3.8`）。

```typescript
/** 关键 content 文件清单（与各 Handler 的 contentFile 声明保持同步，见 §5，共 17 项） */
export const CRITICAL_CONTENT_FILES: readonly string[];

/** 查询关键 content 文件是否齐全；纯查询、无副作用（不 log、不抛异常，只用 existsSync） */
export function checkPromptContentAssets(contentDir?: string): {
  ok: boolean;
  contentDirExists: boolean;
  missing: string[];
};
```

- **`contentDir` 可选参数**：仅供 UT 注入临时目录测「目录缺失 / 部分缺失 / 全齐全」三态（避免真去改名/删共享的 `src/prompts/content`——vitest 并行跑多文件会撞其他并发测试文件读同目录）；真实调用处（bootstrap）零参用默认 `CONTENT_DIR`，语义与设计零变化。
- **bootstrap 接入点**：`bootstrap.ts bootstrapBuiltinPlugins()` 函数体最开头调用；`!ok` 时 `console.error('[bootstrap] prompt content assets missing...')`——**只 log 不抛错**（不中断启动：即便 content 缺失也应尽力起来让用户看到错误日志，而非直接崩溃）。dev/test 下 `CONTENT_DIR` 解析到 `src/prompts/content` 且文件齐全，不会误报；`bootstrapBuiltinPlugins` 由 `router.ts getBootstrap()` 首次 HTTP 请求时惰性触发（Promise 缓存单次），自检语义="首次真实使用前完成"。
- **build 期资源镜像是第一道防线，本自检是第二道运行期兜底**：`app/server` 的 `bun run build` 末尾跑 `scripts/check-server-build-assets.sh`（src→dist 镜像比对，缺失直接 build fail，不留到运行期才发现），见 `../../app/package/[P0]packaging_toolchain.md §3.8`。

## 4. 派生 Handler 清单

### 4.1 system_prompt_mapper 消费的 Handler

| Handler | content 文件 | 动态数据 | tier | 调用方（plugin 层） |
|---------|-------------|---------|------|-------------------|
| `IdentityHandler` | `content/identity.md` | — | stable | `rocky_context` identity mapper |
| `RulesHandler` | `content/rules.md` | — | stable | rules mapper |
| `ToolGuidanceHandler` | `content/tool_guidance.md` | `{{tool_list}}` ← `config.tools` 各 definition `name + (intro ?? description)`（[v0.0.146] 优先 intro 短简介、无则 fallback description） | stable | tool_guidance mapper |
| `SkillsHandler` | `content/skills.md` | `{{skills_list}}` ← `config.skills.entries`（name+description） | stable | skills mapper |
| `ContextFilesHandler` | —（读项目 `AGENTS.md`/`CLAUDE.md` + squad 个人差异文件，非 content 目录） | 项目文件正文（两级：团队 + 个人） | context | context_files mapper |
| `MemoryHandler` | —（no-op） | — | volatile | memory mapper（D1.1 缺失 → 空 content） |

> **memory handler no-op**：long_term_memory 记忆源未建（同 v0.0.13 D1.1 决策），handler 存在仅为占位 + 后续记忆源就位后填肉，当前返空 content。

### 4.2 其他消费方 Handler（task message / 工具描述 / compact 派生模板，非 system prompt fragment）

这组 handler **不走 mapper/reducer EP**——产出直接喂给各自 caller 组的 message/description 文本，不经 `PromptFragment`/tier/priority/budget_truncate。

| Handler | content 文件 | 动态数据 | 消费方 |
|---------|-------------|---------|--------|
| `CompactHandler` | `content/compact.md` | —（[v0.0.54] 纯 directive，无占位符。snapshot.messages 已在 side-run buffer，prompt 不复述——见 `[P0]context_compact_detail.md §3.0`） | compact runner（`context-compact-runner.ts`），产出 compact user message，不进 system prompt |
| `ConsolidationHandler` | `content/consolidation.md` | `{{routing_rules}}`（← `ROUTING_DECISION_PROMPT`，同源不复制粘贴）；**[v0.0.238] 新增 `{{agents_paths}}`（← caller 按主 session kind 渲染 AGENTS.md 整理对象路径：studio 团队+个人 / playground 单份 / academy 固定 OUT 行）+ `{{scope_table}}`（← caller 按主 session biz 渲染可用 scope 表，来自 `biz-scope-rules.renderScopeTableForPrompt`）；删 `{{serialized_transcript}}`**（v0.0.204 起，同 summary 同 directive-only 契约，对话历史由 snapshot 经旁路 buffer 唯一承载）；**[v0.0.238] 删 fork-override「默认翻 session」段**（被 scope 必填取代） | `memory_skill_consolidation` post-compact handler（consolidate 整理 task message，详 `../memory/[P0]consolidation_tier1.md §3/§4`）；v0.0.238 起新占位符承载**静态配置**（AGENTS.md 路径 + biz scope 表），旁路不变量保持（不复述 transcript） |
| `ConsolidationTier2Handler`（v0.0.151.t2；**[v0.0.238] 加 `{{write_scope}}`**） | `content/consolidation_tier2.md` | `{{domain}}`/`{{capacity_limit}}`/`{{entries_list}}`/`{{session_memory_full}}`/`{{session_summary}}`/`{{routing_rules}}`（同上 4 处同源）；**[v0.0.238] 加 `{{write_scope}}`**（← `ctx.vars.write_scope`，caller 传入：全局 skill/memory 块='global' / 单 session memory 块='session'；缺省 'global'）——scope 必填后 tier2 的 memory_manage/skill_manage 调用由 LLM 发起，须告知该传哪个 scope | tier2 三段整理 task message（详 `../memory/[P0]consolidation_tier2.md §6`）；caller = `consolidation-tier2/{global-skill,global-memory,session-memory}.ts`，各自传 `write_scope` |
| `AutoNamingHandler`（[v0.0.153]） | `content/auto_naming.md` | `{{query}}` ← 用户首条 query 原文 | `auto-naming-service.ts applyAiName()`（session 自动起名 LLM 调用） |
| `RoutingDecisionHandler`（[v0.0.153]，模块私有类，不导出） | `content/routing_decision.md` | —（无占位符） | 仅供 `routing-decision.ts` 内部**模块顶层即时求值**导出常量 `ROUTING_DECISION_PROMPT`（`new RoutingDecisionHandler().build({}).content.trimEnd()`）。**单一源不变量**：`memory-manage.ts` 工具描述 / `skill-manage.ts` 工具描述 / `ConsolidationHandler` 三处共读同一常量，措辞不复制粘贴。即时求值（非每次调用重算）与旧内联字面量常量的求值时机一致——`memory-manage.ts`/`skill-manage.ts` 的 `Tool` 定义是模块级单例对象，description 在 import 时一次性拼好，改惰性求值会破坏这一前提。 |
| `SideRunReminderHandler`（[v0.0.153]） | `content/side_run_reminder/skeleton.md`（骨架，必读）+ 按需 `tools_none.md` / `tools_all.md` / `mode_tail_summary.md` / `mode_tail_consolidate.md` | `{{mode_key}}` + `{{actual_tools_description}}`（骨架占位符）；`readToolsNone()`/`readToolsAll()` 两个一行 helper 供三态选择 | `side-run-reminder-injector.ts buildReminderText()`——**三态 / runKind「选哪个」的业务判断逻辑留在调用方**，handler 只负责「按 key 取 md 段 + 拼接」，详见 `../agent_interface_and_loop/[P0]side_run_reminder.md §3` |
| `HeartbeatTickHandler`（[v0.0.153]） | `content/tick_heartbeat.md` | —（无占位符） | `tick-message.ts buildHeartbeatTickMessage()`；姊妹函数 `buildTickUserMessage()`（file-watch 共用）未文件化、不受影响 |

## 5. content 文件清单（正文方向，coder 落地具体措辞）

| 文件 | 内容方向（参考调研 §4） | 约束 |
|------|----------------------|------|
| `identity.md` | 5 要素：定位（who/by whom/做什么）+ 能力范围（对话/工具/代码/分析/创意）+ 协作方式（through conversation and tool use）+ 风格基线（concise/direct/admit uncertainty/genuinely useful over verbose）+ 诚实性红线（一行，如 `Do not fabricate tool outputs or facts; report uncertainty honestly.`） | ≤ 8 行（cache 友好，调研 §4.1） |
| `rules.md` | 3 section（`# Operating Rules` / `# Doing Tasks` / `# Tool Use`）：系统层（注入可疑 flag / 工具失败不重试 / 自动压缩历史）+ 任务层（反 stub-stop / 反 fabricate / 改文件前先读 / 失败诊断根因 / 不超范围改码）+ 工具层（优先 dedicated tool / 并行调用纪律 / 引用文件路径或 URL 用 markdown 链接语法 `[文本](路径或URL)` 不输出裸路径——前端可渲染可点击，分发见 chat-page `component-chat-link-viewer.md`） | ≤ 20 行（调研 §4.2） |
| `tool_guidance.md` | 模板：`# Tool Guidance\n\nAvailable tools:\n{{tool_list}}`；`{{tool_list}}` 由 mapper 从 `config.tools` 拼 `- \`<name>\` — <intro ?? description>` 列表（[v0.0.146] 优先 `ToolDefinition.intro`，无则 fallback description；完整 description 仍由 tool schema 传递） | — |
| `skills.md` | 模板：`# Skills\n\nAvailable skills (call the \`skill\tool by name to load full SKILL.md):\n\n{{skills_list}}` | — |
| `compact.md` | CC 口径（调研 §3.1 + §4.4）：**NO_TOOLS preamble**（CRITICAL: TEXT ONLY + 4 条 bullet）+ 9 板块指令（spec `[P0]context_compact_detail.md §3.3` 通用化）+ analysis/summary 双 block 输出约束 + **NO_TOOLS trailer**（REMINDER，放最末，双保险）。**[v0.0.54] 整删 `{{serialized_transcript}}` + `{{old_summary}}` 占位符**——compact prompt 改纯 directive（forked 不变量，见 `[P0]context_compact_detail.md §3.0`）：对话历史已在 forked buffer 中（snapshot 单一信息源），prompt 只下「概括上面对话历史」指令，不复述、不注入。 | — |
| `consolidation.md` | consolidate 记忆/技能整理 task message 模板（`{{routing_rules}}` 占位符；v0.0.204 删 `{{serialized_transcript}}`，同 summary 同 directive-only 契约；**v0.0.238 加 `{{agents_paths}}` + `{{scope_table}}`** 承载 AGENTS.md 整理对象路径 + biz 可用 scope 表这类静态配置；删 fork-override 默认翻 session 段——被 scope 必填取代；新增 5 条整理标准 + 红线声明），内容方向详见 `../memory/[P0]consolidation_tier1.md §3/§4/§6` | — |
| `consolidation_tier2.md`（v0.0.151.t2；**v0.0.238 加 `{{write_scope}}`**） | tier2 三段整理 task message 模板（4 阶段：Orient/Gather/Consolidate/Prune + Phase 2.5 quality review）；占位符 `{{domain}}`/`{{capacity_limit}}`/`{{entries_list}}`/`{{session_memory_full}}`/`{{session_summary}}`/`{{routing_rules}}`/`{{write_scope}}`（详 `../memory/[P0]consolidation_tier2.md §6`） | — |
| `auto_naming.md`（[v0.0.153]） | session 自动起名提示词：4 条要求 bullet + 末尾 `用户问题：{{query}}` 占位符（原 `NAMING_PROMPT` 逐字迁移；原实现拼接无分隔符，占位符替换等价还原） | 仅一个占位符 `{{query}}`；措辞与原常量逐字一致 |
| `routing_decision.md`（[v0.0.153]；**v0.0.238 Step 2 重写**） | 记忆/技能路由两步决策文案（Step 1 判断写 skill/memory/都不写；Step 2 判断 scope：v0.0.238 起为「三层语义 + scope 必填无默认 + 全 biz 静态可用表三行 + 错误引导」），无占位符 | 措辞与 `ROUTING_DECISION_PROMPT` 常量逐字一致（**4 处消费方**：`memory-manage.ts`/`skill-manage.ts`/`consolidation.md`/`consolidation-tier2-handler.ts` 自动同源更新）；本文件是 ROUTING_DECISION_PROMPT 内容源 |
| `tick_heartbeat.md`（[v0.0.153]） | squad 心跳 tick 提示词，含 `<EOS>` 软出口引导句（**文案内容，非 stop token**），无占位符 | 措辞与原 `HEARTBEAT_TICK_PROMPT` 常量逐字一致 |
| `side_run_reminder/skeleton.md`（[v0.0.153]） | 旁路 run reminder 通用骨架（`[Side Run Context]` 起始行 + Key facts 4 bullet），`{{mode_key}}` + `{{actual_tools_description}}` 占位符 | 内容方向详见 `../agent_interface_and_loop/[P0]side_run_reminder.md §3.1` |
| `side_run_reminder/tools_none.md` / `tools_all.md`（[v0.0.153]） | 三态 `actualToolsDescription` 中的两个固定短语（零工具 / 不强制全工具），无占位符 | 同上 §3.2 |
| `side_run_reminder/mode_tail_summary.md` / `mode_tail_consolidate.md`（[v0.0.153]） | `runKind` 微调追加行（compaction run / memory extraction run 各一句指令），无占位符 | 同上 §3.3 |
| `squad/leader.md` / `mate.md` / `squad_chat.md` | squad_role mapper 专属正文（角色人设 + rules + 协作规则），不是本文档管理范围 | 内容方向详见 `../../squad/[P1]prompt_sections.md §3.1`（不重复维护两处） |

> **compact.md 模板边界**：只文件化「压缩指令模板」（NO_TOOLS preamble + 9 板块指令 + 输出约束 + NO_TOOLS trailer）。**[v0.0.54] 起 prompt 是纯 directive，无占位符、无运行时拼接**——v0.0.22-0.0.53 实现曾把 `serializeMessages(snap.messages)` 塞 prompt（违 forked 不变量），已修复。

## 6. 与既有 mapper/reducer EP 的关系（兼容性 — MUST NOT VIOLATE）

**不破坏 mapper/reducer 双 EP**（`[P0]system_prompt.md §3` 权威），仅在其下新增「文件读取层」：

| 层 | 职责 | 改动 |
|----|------|------|
| **EP 层**（`SystemPromptMapper` / `SystemPromptReducer`） | mapper 贡献 `PromptFragment[]`、reducer 链式 reduce、builder `\n\n`.join | **不变**（契约、cardinality、effective order、tier_sort/dedup/budget_truncate 全保持） |
| **plugin 层**（`rocky_context` prompt mapper） | mapper.map(ctx) 包 fragment + 跑 EP | **变薄**：mapper 内部委托 `handler.build()` 取 content → 包 `{ id, tier, content, priority }`；mapper 仍属 plugin impl（manifest 不变） |
| **server 核心层**（`app/server/src/prompts/`） | 读 content 文件 + 缓存 + 模板替换 + 降级 | **新增**（本模块） |
| **compact runner**（`context-compact-runner.ts`） | runCompact 拼压缩 user message | **变薄**：`COMPACT_PROMPT_PREFIX` 常量删 → 委托 `CompactHandler.build()` 取完整压缩 user message 文本 |

**关键兼容性结论**：
1. **不引入新 EP**（不增加 `system_prompt_*` 之外的 point）。
2. **不改 mapper/reducer 契约**（`map()` / `reduce()` 签名不变）。
3. **不改 manifest**（`identity/rules/tool_guidance/...` 6 mapper + 3 reducer implId / tier / order / configSchema 全保持，仅 impl 内部委托 handler）。
4. **不破坏 builder**（`buildSystemPrompt()` 仍 `\n\n`.join；fallback 到 `config.systemPrompt` 不变）。
5. **不破坏 debug 端点**（`GET /session/:id/debug/system-prompt` 仍走 `buildSystemPrompt()`，AT 复用此端点验注入）。
6. **server 核心不反向依赖 plugin**（`app/server/src/prompts/` 不 import `rocky_context` 或 EP 契约；mapper 反向依赖 handler 是 plugin → server 的正常方向）。

## 7. 边界与坑

1. **条件分支逻辑留代码**（调研 §4.5）：纯文件读取不够，mapper/handler 内仍按 `config.tools`、model family、enabled skill 等条件拼装。content 文件抽的是「正文/模板骨架」，不是「全部 prompt 逻辑」。
2. **[v0.0.54] compact prompt 纯 directive 不复述**（forked 不变量）：v0.0.22-0.0.53 实现曾把 `serializeMessages(snap.messages)` 塞 prompt（违 forked 不变量——对话历史发两遍），v0.0.54 整删。`serializeMessages` 函数已删（无消费方 → 死代码清除）。compact prompt 是纯指令，对话历史由 forked buffer 直接承载。
3. **mtime 仅 dev 失效 key，不进 prompt 文本**（避免破 prompt cache）：prod once cache。
4. **占位符语法 `{{name}}`**（双花括号 + 标识符）：避免与 markdown `{{...}}` 模板语法冲突时，handler 用 `{{placeholder}}` 标识符命名约定（仅字母数字下划线）。
5. **降级优先于报错**：任何 handler 异常都返空 content，让上游 mapper 决定「不贡献 fragment」或「贡献空」，不抛中断 builder。
6. **ContentFilesHandler 读项目文件不走 content 目录**：项目 `AGENTS.md`/`CLAUDE.md` 是用户资产，handler 仍按既有 `CANDIDATE_FILES` + `MAX_FILE_CHARS` 逻辑读 cwd（仅委托取 content 的代码从 mapper 抽到 handler，行为不变）。
7. **AGENTS.md 两级读取（squad）**：`ContextFilesHandler.build(ctx)` 的 `PromptHandlerContext` 扩展可选 `personalContextFile?: string`（绝对路径，由 context_files mapper 按 kind/sessionContext/studioContext 计算并做存在性检测后传入，详见 `[P1]agent_profile.md` §4 个人文件后缀扫描规则）。两份文件各自独立读取截断、各自带来源标注，拼接顺序 = 团队（cwd 主文件）在前、个人在后（语义「个人叠加团队」）。个人文件截断上限 `MAX_PERSONAL_FILE_CHARS = 8000`（个人差异是小文件；团队主文件保持 `MAX_FILE_CHARS = 20000`——两级合计 ≤28000，与 memory_session 在 budget floor 40000 内共存，见 `[P0]system_prompt.md` §7）。academy/playground 无个人文件（mapper 不传），维持单份注入不回归。
8. **[v0.0.153] §4.2 的 handler 不是 `PromptFragment` 生产者**：不进 mapper/reducer EP、不参与 tier/priority/budget_truncate；产出直接喂给各自 caller 的 message/description 文本。与 §4.1 共用同一套读取/缓存/模板替换机制是**代码复用**，不是概念扩张——§6 的 EP 兼容性结论只约束 §4.1。
9. **content 文件末尾换行 vs 原字面量常量无尾随换行**：仓库惯例 `.md` 文件以换行结尾，但被迁移的原 TS 字面量常量大多无尾随换行（直接拼接下一段）。迁移后的 handler 统一在 `build()` 内部对 `readContent()` 结果调 `.trimEnd()` 补偿，确保产出与原常量逐字节相同（`auto-naming-handler.ts`/`heartbeat-tick-handler.ts`/`side-run-reminder-handler.ts` 骨架、`routing-decision.ts` 模块顶层皆如此）——新增 content 文件迁移时须同样处理，否则产出比原常量多一个换行符。

## 8. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
