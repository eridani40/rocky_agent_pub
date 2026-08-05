# v0.0.153 变更计划书 — packaged prompt content 打包修复 + 硬编码 prompt md 化 + build 期资源自检

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 范围：T1 打包修复 + T2 启动自检护栏 + T3 硬编码 prompt 迁 md（4 处）+ T4 build 期资源自检。**不含**：b 类结构渲染模板迁移、c 类 DB 种子迁移、打包链全面 review、specs 打包护栏文档（归阶段 5 doc-modifier）。

## 列定义

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 |
| 影响行 | +N / -M |

## 变更清单

### T1 + T4：build toolchain（package.json cp 修复 + 资源自检脚本）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| app_package | app/server/package.json | `scripts.build` | 修改 | 补 `cp -r src/prompts/content dist/prompts/`（整目录递归，squad/ 等子目录随行，与既有 migration yaml cp 同款风格）+ 追加调用 `bash ../../scripts/check-server-build-assets.sh` 收尾校验 | MUST cp 在 `tsc -b` 之后（`dist/prompts/` 须已由 tsc 生成才有落点）；MUST 校验脚本作为 build 脚本最后一步，非 0 退出即整个 `bun run build` 失败 | req.md T1；`specs/tech/agent/context/[P0]prompt_content_files.md §2` | +1/-1 |
| app_package | scripts/check-server-build-assets.sh | `check_mirror()` | 新增 | 内部函数：入参 `src_dir dist_dir pattern`，`find` 递归枚举 `src_dir` 下匹配 `pattern` 的文件，逐个核对 `dist_dir` 下同相对路径文件存在，缺失则 `echo MISSING: <dist_dir>/<rel>（源: <src_dir>/<rel>）` 到 stderr 并置全局 `missing=1` | MUST NOT 硬编码文件名清单（镜像比对 src→dist，新增 .md/.yaml 资源自动纳入校验，防「新增文件忘记进 dist」复发）；MUST 用 `find -print0`/`read -d ''` 防文件名含空格出错 | req.md T4；CLAUDE.md「持续可打包护栏」新类型：编译期资源复制缺失 | +34 |
| app_package | scripts/check-server-build-assets.sh | 主流程（顶层脚本体） | 新增 | `cd app/server` 后调用两次 `check_mirror`：`(src/prompts/content, dist/prompts/content, *.md)` + `(src/migration/handlers, dist/migration/handlers, *.yaml)`；`missing` 非 0 时打印汇总 FAILED 信息并 `exit 1`，否则打印 OK 并 `exit 0` | MUST 零新依赖（纯 bash + coreutils + find，不装 npm 包）；MUST `set -euo pipefail`；失败信息必须逐条列出具体缺失相对路径（不许只报「资源缺失」不指名） | 同上 | 含于上行 |

### T2：启动自检护栏（CONTENT_DIR + 关键 content 文件缺失显式 error log）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| prompt_content_files | app/server/src/prompts/prompt-handler.ts | `readContent()` | 修改 | 签名加可选参数 `relPath: string \| undefined = this.contentFile`（原逻辑体不变，仅解析入参从 `this.contentFile` 改为 `relPath`），使子类可读取「非主 contentFile」的其余 content 文件（T3 forked-reminder 多段 md 复用同一实例） | MUST 向后兼容：所有既有 `this.readContent()` 无参调用行为零变化；MUST NOT 改变 dev mtime / prod once cache / fallback 降级语义 | `specs/tech/agent/context/[P0]prompt_content_files.md §3` | +2/-2 |
| prompt_content_files | app/server/src/prompts/prompt-handler.ts | `CRITICAL_CONTENT_FILES` | 新增 | 模块级只读字符串数组常量：`identity.md/rules.md/tool_guidance.md/skills.md/compact.md/consolidation.md/squad/leader.md/squad/mate.md/squad/squad_chat.md/auto_naming.md/routing_decision.md/forked_reminder/skeleton.md/tick_heartbeat.md`（本版本新增的 T3 四文件同步纳入） | MUST 与 §4 Handler 清单 + T3 新增文件保持同步（新增/删除 content 文件时一并维护本清单） | 同上 §4；本计划 T3 各行 | +14 |
| prompt_content_files | app/server/src/prompts/prompt-handler.ts | `checkPromptContentAssets()` | 新增 | 导出函数，返回 `{ ok, contentDirExists, missing }`：`fs.existsSync(CONTENT_DIR)` 判目录存在；目录不存在则 `missing=CRITICAL_CONTENT_FILES` 整表、`ok=false`；目录存在则逐个 `fs.existsSync(path.join(CONTENT_DIR, rel))` 过滤缺失项 | MUST NOT 抛异常（内部只用 `existsSync`，不 `readFileSync`，无 try/catch 需求）；MUST 纯查询、无副作用（不 log，log 由调用方决定） | 同上；req.md T2 | +12 |
| bootstrap | app/server/src/bootstrap.ts | `bootstrapBuiltinPlugins()` | 修改 | 函数体最开头（`const registry = new Registry();` 之前）调用 `checkPromptContentAssets()`；`!ok` 时 `console.error('[bootstrap] prompt content assets missing (packaging/deploy broken): contentDirExists=..., missing=[...]')`（沿用文件内既有 `console.error('[bootstrap] ...')` 前缀风格） | MUST NOT 抛错/中断启动（仅 log，不 throw）；MUST 只在 `!ok` 时打印（dev/test 下 CONTENT_DIR 解析到 src 且文件齐全，不触发，不得误报）；MUST 复用 bootstrap 既有一次性初始化时机（`getBootstrap` 已做 Promise 缓存，天然只跑一次） | 同上；`app/server/src/router.ts:126-136`（bootstrapCache 缓存单次语义） | +5 |

### T3-a：auto-naming NAMING_PROMPT → md

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| auto_naming | app/server/src/prompts/content/auto_naming.md | — | 新增 | 正文 = 现 `NAMING_PROMPT` 模板字面量原文逐字迁移（4 条要求 bullet），末尾改 `用户问题：{{query}}` 占位符（原实现是裸字符串拼接 `NAMING_PROMPT + plainText` 无分隔符，改用显式占位符替换等价拼接，避免文件尾随换行导致的拼接歧义） | MUST 与原 `NAMING_PROMPT` 措辞逐字一致（不改写文案）；MUST 仅一个占位符 `{{query}}` | req.md T3；`[P0]prompt_content_files.md §3.2` 占位符语法 | +9 |
| auto_naming | app/server/src/prompts/handlers/auto-naming-handler.ts | `AutoNamingHandler` | 新增 | `extends PromptHandler`，`contentFile='auto_naming.md'` | 风格与 `IdentityHandler`/`RulesHandler` 一致 | `app/server/src/prompts/handlers/identity-handler.ts` | +3 |
| auto_naming | app/server/src/prompts/handlers/auto-naming-handler.ts | `AutoNamingHandler.build()` | 新增 | `build(ctx)`：`fillTemplate(readContent(), { query: ctx.vars?.query ?? '' })` | MUST 保持 `plainText` 原样拼接语义（不裁剪/不加额外分隔符） | 同上 | +4 |
| auto_naming | app/server/src/agent/auto-naming-service.ts | `NAMING_PROMPT` | 删除 | 删该模块级常量（68-74 行含注释块），改由 `AutoNamingHandler` 提供正文 | MUST NOT 保留死常量 | req.md T3；CLAUDE.md 架构原则「不遗留死代码」 | -12 |
| auto_naming | app/server/src/agent/auto-naming-service.ts | `applyAiName()` | 修改 | `baseReq.messages[0].content` 的 `text` 字段从 `NAMING_PROMPT + plainText` 改为 `new AutoNamingHandler().build({ vars: { query: plainText } }).content` | MUST NOT 改动本方法其余逻辑（LlmCaller.invoke/CAS/observability 全不变，见文件头「不变量」1-5） | `app/server/src/agent/auto-naming-service.ts` 头部不变量注释；`app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts:104` `new XHandler().build()` 调用惯例 | +1/-1 |

### T3-b：routing-decision.ts ROUTING_DECISION_PROMPT → md（单一源不变）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory_routing | app/server/src/prompts/content/routing_decision.md | — | 新增 | 正文 = 现 `ROUTING_DECISION_PROMPT` 模板字面量原文逐字迁移（Step 1/Step 2 两步决策文案），无占位符 | MUST 与原常量措辞逐字一致（`routing-decision.test.ts` 断言 `step 1`/`step 2`/`global`/`skill`/`memory`/`default` 等关键词依赖原文） | req.md T3；`app/server/src/prompts/__tests__/routing-decision.test.ts` | +12 |
| memory_routing | app/server/src/prompts/routing-decision.ts | `RoutingDecisionHandler`（模块私有类，不导出） | 新增 | `extends PromptHandler`，`contentFile='routing_decision.md'`，`build()` 返 `{content: readContent()}` | 仅本文件内部使用，不导出（避免多一个公共符号） | 同上 | +8 |
| memory_routing | app/server/src/prompts/routing-decision.ts | `ROUTING_DECISION_PROMPT` | 修改 | 从内联模板字面量改为 `new RoutingDecisionHandler().build({}).content.trimEnd()`（模块顶层即时求值，导出符号名/类型/三处消费方式**完全不变**） | MUST 导出 API 零变化：`memory-manage.ts:144`、`skill-manage.ts:129`、`consolidation-handler.ts:29` 三处消费点**零代码改动**（单一源不变量#6，见 `routing-decision.ts` 头注释）；MUST NOT 引入循环依赖（`routing-decision.ts → prompt-handler.ts` 单向，`prompt-handler.ts` 不反向 import） | `app/server/src/prompts/routing-decision.ts` 头部「单一源（不变量#6）」注释 | +1/-13 |

### T3-c：forked-reminder-injector.ts buildReminderText → md（骨架 + 条件段）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent_loop_forked | app/server/src/prompts/content/forked_reminder/skeleton.md | — | 新增 | 通用骨架正文（现 `buildReminderText` 前 8 行 `lines` 数组，含 `[Forked Agent Context]` 起始行 + Key facts 4 bullet），插入 `{{mode_key}}`（替代 `modeKey=${modeKey}`）+ `{{actual_tools_description}}`（替代 `${actualToolsDescription}`）两占位符 | MUST 与原 `lines` 数组拼接结果逐字一致（仅动态段换成占位符） | req.md T3；`specs/tech/agent/agent_interface_and_loop/[P0]forked_reminder.md §3.1` | +9 |
| agent_loop_forked | app/server/src/prompts/content/forked_reminder/tools_none.md | — | 新增 | 正文 = 原三态之一固定短语 `[] (no tools allowed — output summary text directly)` | 逐字一致 | 同上 §3.2 | +1 |
| agent_loop_forked | app/server/src/prompts/content/forked_reminder/tools_all.md | — | 新增 | 正文 = 原三态之一固定短语 `all tools in your tool definitions (bound of this run's role)` | 逐字一致 | 同上 | +1 |
| agent_loop_forked | app/server/src/prompts/content/forked_reminder/mode_tail_summary.md | — | 新增 | 正文 = 原 `modeKey==='summary'` 追加行 `This is a compaction run: produce a concise summary of the conversation so far as your final answer. Do NOT call any tools.` | 逐字一致 | 同上 §3.3 | +1 |
| agent_loop_forked | app/server/src/prompts/content/forked_reminder/mode_tail_memory_extract.md | — | 新增 | 正文 = 原 `modeKey==='memory_extract'` 追加行 `This is a memory extraction run: use the allowed tools to extract and persist long-term memory, then output a brief status as final answer.` | 逐字一致 | 同上 | +1 |
| agent_loop_forked | app/server/src/prompts/handlers/forked-reminder-handler.ts | `ForkedReminderHandler` | 新增 | `extends PromptHandler`，`contentFile='forked_reminder/skeleton.md'` | — | `[P0]prompt_content_files.md §3` | +3 |
| agent_loop_forked | app/server/src/prompts/handlers/forked-reminder-handler.ts | `ForkedReminderHandler.build()` | 新增 | `build(ctx)`：`fillTemplate(readContent(), {mode_key, actual_tools_description})` 拼骨架；`ctx.vars.mode_tail_key` 为 `'summary'`/`'memory_extract'` 时 `readContent('forked_reminder/mode_tail_' + key + '.md')` 追加（`\n\n` 连接后 `.trim()`），否则不追加 | MUST 三态/模式判断逻辑（"选哪个 tail"）保留在**调用方**（`buildReminderText`），本方法只做「按 key 取文件 + 拼接」，不做业务分支决策 | req.md T3「条件逻辑留代码，正文段落进 md」 | +12 |
| agent_loop_forked | app/server/src/prompts/handlers/forked-reminder-handler.ts | `ForkedReminderHandler.readToolsNone()` / `readToolsAll()` | 新增 | 两个一行 helper：`this.readContent('forked_reminder/tools_none.md').trim()` / `this.readContent('forked_reminder/tools_all.md').trim()`，供 `buildReminderText` 三态选择用 | — | 同上 | +6 |
| agent_loop_forked | app/server/src/agent/forked-reminder-injector.ts | `buildReminderText()` | 修改 | 保留三态 `actualToolsDescription` 判断 + `modeKey` 微调判断（**条件逻辑不变、留在本函数**）；`toolWhitelist.length===0` 分支改读 `handler.readToolsNone()`（原字面量删除）；`enableToolWhitelist===false` 分支改读 `handler.readToolsAll()`；`toolWhitelist.length>0` 分支保留 `` `[${toolWhitelist.join(', ')}]` ``（纯数据格式化非文案，不迁 md）；末尾 `lines.join('\n')` 拼接改为 `new ForkedReminderHandler().build({vars:{mode_key, actual_tools_description, mode_tail_key}}).content` | MUST 返回值语义与原实现逐字等价（供 UT `toContain` 断言延续通过）；MUST NOT 改函数签名 `(input: ForkedReminderInput) => string`；MUST NOT 触碰 `injectForkedReminder()`（不变量 §6：只本函数改，cache 前缀/forked 拓扑零改动） | `specs/tech/agent/agent_interface_and_loop/[P0]forked_reminder.md §2-§6`（4 条不变量） | +10/-20 |

### T3-d：tick-message.ts HEARTBEAT_TICK_PROMPT → md

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_scheduler | app/server/src/prompts/content/tick_heartbeat.md | — | 新增 | 正文 = 现 `HEARTBEAT_TICK_PROMPT` 原文逐字迁移（含 `<EOS>` 软出口引导句），无占位符 | MUST 逐字一致（`<EOS>` 不是 stop token，是文案内容，随文件一起迁，见原常量注释） | req.md T3；`app/server/src/squad/scheduler/tick-message.ts:48-49` 注释 | +2 |
| squad_scheduler | app/server/src/prompts/handlers/heartbeat-tick-handler.ts | `HeartbeatTickHandler` | 新增 | `extends PromptHandler`，`contentFile='tick_heartbeat.md'`，`build()` 返 `{content: readContent()}` | 风格与 `IdentityHandler` 一致 | `[P0]prompt_content_files.md §3` | +7 |
| squad_scheduler | app/server/src/squad/scheduler/tick-message.ts | `HEARTBEAT_TICK_PROMPT` | 删除 | 删该导出常量（含注释块），无外部消费方（grep 确认仅本文件内 `buildHeartbeatTickMessage` 使用，`heartbeat-handler.ts` 只 import `buildHeartbeatTickMessage`，不直接引用常量） | MUST 先确认零外部 import 该符号再删（已核对：`grep HEARTBEAT_TICK_PROMPT` 仅命中本文件） | 同上；CLAUDE.md「不遗留死代码」 | -6 |
| squad_scheduler | app/server/src/squad/scheduler/tick-message.ts | `buildHeartbeatTickMessage()` | 修改 | `content` 字段的 `text` 从 `HEARTBEAT_TICK_PROMPT` 改为 `new HeartbeatTickHandler().build({}).content` | MUST NOT 改 `buildTickUserMessage()`（file-watch 共享，见文件头「MUST NOT 动 buildTickUserMessage」注释）；MUST NOT 改函数签名/返回 `Message` 形态 | `app/server/src/squad/scheduler/tick-message.ts` 头部分层注释 | +1/-1 |

## 影响面评估

- **T1+T4（build toolchain）**：仅 `app/server/package.json` + 新增 `scripts/check-server-build-assets.sh`；dev/test 运行时零影响（`app/server` 的 `build` 脚本只在 `scripts/build-dmg.sh` 打包链路和手动 `cd app/server && bun run build` 时触发，根 `package.json` 的 `typecheck`/`test` 不经过它）。
- **T2（启动自检）**：`prompt-handler.ts` 新增导出 + `readContent()` 签名扩展向后兼容；`bootstrap.ts` 增一处早期只读检查，不阻塞/不抛错。dev/test 下 `CONTENT_DIR` 解析到 `src/prompts/content`（文件齐全）不会误报。
- **T3（4 处硬编码迁 md）**：均为「导出符号保留、正文来源换介质」的等价改写；**3 个直接消费 `ROUTING_DECISION_PROMPT` 的文件（`memory-manage.ts`/`skill-manage.ts`/`consolidation-handler.ts`）零代码改动**（单一源不变量维持）。`buildReminderText`/`buildHeartbeatTickMessage`/`applyAiName` 三处签名不变，只内部实现改走 handler。
- **依赖顺序**：T1（build 脚本）与 T2/T3（server 源码）互相独立，可并行实现；T4 校验脚本依赖 T1 的 cp 逻辑先落地才能验证通过（先 T1 后 T4 验收，但编码可并行写）。
- **UT 影响面**（现存测试文件，均预期**断言延续通过**，前提 = md 正文与原常量逐字一致）：
  - `app/server/src/agent/__tests__/auto-naming-service.test.ts` — 无直接文案断言（只断 `caller.captureCtx`/`baseReq.params`），零改动需求，仅需确认 mock 路径仍触发 `applyAiName` 正常拼接。
  - `app/server/src/prompts/__tests__/routing-decision.test.ts` — 断言基于 `ROUTING_DECISION_PROMPT` 变量本身（非硬编码字符串），自动跟随新值，预期零改动即通过；`__clearPromptCacheForTests()` 覆盖面不含新增的 `routing_decision.md` 场景（该常量模块顶层即时求值，非每次 `build()` 动态读，缓存清空不影响已求值常量）。
  - `app/server/src/agent/__tests__/forked-reminder-injector.test.ts` — 全部 `toContain(...)` 子串断言（`'no tools allowed'`/`'[read, write]'`/`'compaction run'`/`'forked agent'`/`'MAIN agent'`/`'ACTUALLY EXECUTE'` 等），只要 5 个新 md 逐字迁移即延续通过。
  - `tick-message.ts` / `heartbeat-handler.ts` 无既有专属常量断言（已核对 grep 无命中），零风险。
  - 建议 coder 迁移后跑 `bun run test`（含以上 4 文件）确认全绿，而非单独新增 UT（架构未强制要求新增覆盖，逐字迁移场景下现有断言已是回归网）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
