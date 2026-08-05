---
type: log
title: Context KB 变更记录
updated: 2026-08-04
---

# Context KB 变更记录（ISO 倒序，最新在前）

## 2026-08-04 · v0.0.256 clean_view 加 bubble_text_before_tool_call（assistant text 冒泡到 tool_call 前，修 provider 400）

- **`[P0]context_assemble_detail.md §1/§5b`** + **`[P0]extension point and implementations.md` §3.10/§5**：`context_clean_view_reducer` 链第 4 位插 `bubble_text_before_tool_call`（orphan_tool_call 后、think_remove 前），链 7→8 项：dedup → snip → orphan → **bubble** → think_remove → fill_empty → empty_message → role_merge。
- **新 reducer**（`app/plugins/builtins/rocky_context/assemble/bubble_text_before_tool_call.ts`，class `BubbleTextBeforeToolCallReducer`）：assistant content 单遍三段稳定分区 `[reasoning…][text…][其余(含 tool_call)…]` 拼接（桶内各保原相对顺序），text 冒泡到所有 tool_call 前；丢 trim 后空 text block；只动 assistant（user/tool/system 原样透传）；不合并 text、不删 message（全丢空交 empty_message 兜底）、不 mutate input（无变化返原引用）。**为什么**：stall 掐断留半截 tool_call（arguments `{_raw}`）落库 + prefill 续写 → text 夹在 tool_call 之间 → anthropic-compatible provider 要求 tool_use 后块级紧跟 tool_result → 400；orphan 只做配对过滤 + message 级邻接、不碰 content 内 block 序，本 reducer 在其后做视图层确定性兜底（对历史污染 + 未来任何乱序源生效）。
- **装配**：`plugin.json` 登记（orphan 条目后）+ `scopes/default.yaml` 第 4 位激活（其它 scope 无自有链，per-EP 继承 default）；i18n description 双语 key 齐备。守门测试 3 个同步 8 项（scope-config-loader order 断言 / migration-equivalence implId 数组 / assemble-pipeline impl 库存计数 clean_view 8 + total 41）。
- **attempt_loop 治本不在本版本**：`hasUnfinishedToolUse` 漏判 `{_raw}` object（stall partial 保留语义，改变重试/失败路径）留 follow-up req；本 reducer 是视图层确定性保证，单独消除 400。
- **代码↔spec 一致性核对（doc-modifier 阶段 5）**：reducer 类名 / 构造器签名 `(implId, cfg)` / 三段分区逻辑 / 空 text 丢弃 / 返原引用优化 / 不可变性与 §5b 新增行一致；default.yaml 生效序与 §5b 表 order 一致；i18n key 双语存在。顺手修正存量漂移：§3.10 表补 `dedup_tool_result` 行（v0.0.207 漏登）+ 登记序改按 manifest 实测序；总 impl 计数 47/48 → **57**（plugin.json 实测 5+2+2+8+20+3+9+4+2+2）；configSchema 计数 6/7 → **8**；§5b/§3.10 scope yaml 路径断言修正为「仅 default.yaml 自有该链」（grep 实测其它 scope 均无此节点）；`[P0]context_engine.md` clean 链枚举 + 计数（6→8）同步。§3.4/§3.6 表 scoped impl 行级漂移（academy_* 7 个 prompt_mapper 未单列 + squad reminder 改名）未逐行修，footer 已标注契约归各业务 KB。
- **index.md 瘦身（OKF 合规）**：退役 3 段版本头注（v0.0.178/v0.0.173/v0.0.81，与 ④ 原则 11/13/16 重复）+ ④ 旧原则 16（v0.0.161 appendNew 加固，纯历史自标注，log.md v0.0.161 条目留档；原则 17 重编号为 16）+ 「实现状态 v0.0.51」头注（durable 事实已归 context_compact_detail §2d / extension §3.8 / system_prompt §4，「post_compact AT 不可行」在 compact_detail L306 留档）；130 → 119 行，回到 ≤120 硬上限内。
- 详情：`specs/tech/version_logs/v0.0.256/change_plan.md`

## 2026-08-04 · v0.0.253 rules.md 加 markdown 链接语法 bullet（聊天链接可点击配套）

- `app/server/src/prompts/content/rules.md` `# Tool Use` 末加一条 bullet：引用文件路径或 URL 时用 markdown 链接语法 `[显示文本](路径或URL)` 输出（例 workspace 文件 / 绝对路径 / 网页），不输出裸路径——前端 `PrimitiveMarkdownView` 渲染为可点击 `<a>` 并按 target 分发（web→系统浏览器 / 12 格式本地→内置只读 viewer / 其它→系统应用）。
- **覆盖范围**：rules mapper（`rocky_context/prompt/rules.ts`）对 leader/mate/squad 返空 → 本指令自动覆盖 standalone + subagent + academy，不污染 squad；mapper/handler/CRITICAL_CONTENT_FILES 零改（rules.md 已在清单）。
- **约束保持**：3 section 结构不变、仍 ≤20 行（现恰 20 行）。`[P0]prompt_content_files.md` §5 rules.md 行内容摘要同步。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：rules.md 实际 20 行 3 section，`system_prompt.md §4` mapper 表描述（3 section）与现状一致，无需改。无偏离。
- 详情：`specs/tech/version_logs/v0.0.253/change_plan.md`（J 节）+ `specs/prd/version_logs/v0.0.253.md` §3.4

## 2026-08-02 · v0.0.238 agent_profile d) 自律治理段 + scope 可用表按 biz 渲染

- `agent_profile.md` §3 section 骨架追加 **d) 自律治理（质量标准）** 段（4 条：分层归位/个人只写差异/描述即路由≤50字/会删比会写重要含配额 20/30/50）；走同一 mapper 渲染（§13.2.1 铁律延续），stable/480 不变。
- §4 表 b) memory scope 改为按 biz：**studio → group/global（去 session）**、academy → session/group/global（三层）、playground 不变。
- d) 段 + b) 行的 scope 可用表/列表数据来自单源 `biz-scope-rules.ts`（新模块，见 `specs/tech/version_logs/v0.0.238/change_plan.md` A 节），不在 mapper 复制可用表。biz 由 `resolveBizScopeKind(ctx.config)` 解析，缺省 `'playground'`（与 side-run 兜底一致）。
- d) 段挂载范围与 a/b/c 一致（主 session；subagent/summary/consolidate scope 不挂——T1 整理标准由指令承担）。
- 路径行渲染、stable tier、未知 kind 防御降级等其余不变量保持。
- d) 段 4 条质量标准文案落模块常量 `AGENT_PROFILE_D_STANDARDS`（偏离 change_plan：为满足 `agent_profile.ts` ≤300 行约束提取常量，非拆模板），仍由同一 mapper 渲染 a/b/c/d——统一 mapper 铁律不变。
- `system_prompt.md §4` mapper 表 + 注入配额注：skills/memory mapper 配额描述从「v0.0.149 三/四类跨组连续取前 N=50」更新为「v0.0.238 分层配额 20/30/50 + builtin 不计恒全量殿后 + catalog 序 workspace→group→app→builtin」；`selectSkillsByQuota`/`selectMemoriesByQuota` 签名从 `(rows, maxN)` 改为 `(rows, quotas)`。退役 inline `[v0.0.149]`/`[v0.0.112]` 版本噪声。

详情：`specs/tech/version_logs/v0.0.238/change_plan.md`（B 节）+ `specs/prd/overall/14-prompt-quality-governance.md` §14.2.1。

## 2026-08-01 · v0.0.232 agent_profile mapper + AGENTS.md 两级读取 + budget_truncate 截断标注 + skills L0 来源标注

- **新增 `[P1]agent_profile.md`**：「定义你的 agent」section mapper——统一 mapper 按 `config.kind` 分支渲染 a/b/c（AGENTS.md 路径+叠加 / memory scope / skills 层路径），禁每 kind 一模板；fragment `{id:'agent_profile', tier:'stable', priority:480}`（skills 之后、memory_user 之前）；scope yaml 挂载 = default + playground-rocky.parent.main + academy-student.parent.main（subagent/summary/consolidate/coach/head_teacher 不挂）。
- **`[P0]system_prompt.md` §3/§4/§7**：① §4 mapper 清单插 `agent_profile`（order 5，stable）+ `context_files` 行改两级读取语义 + skills 行加 `[scope=...]` 标注说明；② §3 budget_truncate 行——截断标记列出全部被丢 dynamic fragment id（`dropped: id1, id2`，不得静默）；③ §7/§3 默认 floor 20000→40000（两级 AGENTS.md ≤20000+8000 与 memory_session 共存口径）。
- **`[P0]prompt_content_files.md` §4.1/§7.7**：`ContextFilesHandler` 两级读取——`PromptHandlerContext` 扩展 `personalContextFile?: string`（mapper 按 kind 计算 + `*-{memberId}.md` 后缀扫描存在性）；团队在前个人在后各带来源标注；个人截断上限 `MAX_PERSONAL_FILE_CHARS=8000`。
- **`[P0]extension point and implementations.md` §3.4**：注册 `agent_profile`（登记序 5）；表对齐 12 impl（补登 memory_group 既有漂移）；`index.md` ⑤ 导航加 agent_profile 行。
- 详情：`specs/tech/version_logs/v0.0.232/change_plan.md`


## 2026-07-30 · v0.0.223 todo provider 填壳（语义重定义：task 进度空壳 → session todo 进度）+ ReminderCtx 扩展 todoStore

- **`[P0]system_reminder.md`**：① §3 todo provider row 重定义——旧版「task 进度 / task_tools 缺失 no-op 空壳」填壳为「当前 session todo 进度（双层待办：主 item + 步骤）」，数据源 `ctx.todoStore.listBySession(sessionId)`，仅 parent.main session 产出（subagent/forked 不产出），空则 no-op 返 []；标头 `[todo]`（`reminder/todo.ts`）。② ReminderCtx 扩展可选 `todoStore`（仿 squadContext 模式，`rocky_context/types.ts`；ingest 构造期按 config.sessionId 注入，缺省 undefined → provider 降级 no-op）。③ §1 典型 reminder 描述同步。④ index.md ⑤ 导航「5 provider」计数修正为 6 内置 provider。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：`reminder/todo.ts` provide() 角色 filter（readSessionType 排 subagent）+ FINISHED={done,skipped} 过滤 + `[todo]` 标头与 spec 一致；`context-ingest-pipeline.ts` extras 透传 todoStore 与 squadContext 同 key 模式一致。无偏离。
- 详情：`specs/tech/version_logs/v0.0.223/change_plan.md`（B 节）

## 2026-07-28 · v0.0.208 academy 板块整体删除（影响：system_prompt/context_engine 去除 academy_context 引用）

- **`[P0]system_prompt.md §1/§3/§4/§6`** + **`[P0]context_engine.md §3.1`**：删 academy_context 作为 scope 级 async mapper 的示例（academy_context impl + ClassroomStore/StudentStore 依赖已随 academy 整体删除）；保留「mapper 链可能含 async impl，故 buildSystemPrompt async」的当前机制说明。scope-level mapper 示例改用 playground 去 squad mapper / studio-squad.parent.main 替代。

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-27 · v0.0.207（clean view 加 dedup_tool_result — 同 toolCallId 双 result 兜底去重）

- **`[P0]context_assemble_detail.md §1/§5b`**：`context_clean_view_reducer` EP 链头插 `dedup_tool_result`（顺序：dedup_tool_result → snip_handler → orphan_tool_call → think_remove → fill_empty_text → empty_message → role_merge，共 7 项）。
- **新 reducer**（`app/plugins/builtins/rocky_context/assemble/dedup_tool_result.ts`）：同 toolCallId 多 tool_result 时挑 keeper（优先 `isError=false` 完整结果，否则首条），非 keeper 从 message.content 过滤掉（不可变返新数组；不删 message，content 变空交 empty_message 兜底）；零命中原样返回。命中写 error log（鸭子类型 `ctx.config.logWriter`，try/catch fail-silent，与 fill_empty_text 同模式）。
- **顺序约束（硬）**：dedup **必须**在 orphan_tool_call 之前——dedup 先去重，orphan 才能正确判配对（否则 orphan 见双 result 都当 paired 全留，兜底失效）。
- **为什么需要**：v0.0.207 修 prod k3 tokenization failed——中断后 loop 与 abort api 各写一条 tool_result（同 toolCallId）→ 畸形消息发给 LLM；T2 authority transfer（见 `../agent_interface_and_loop/log.md` v0.0.207 条目）已从源头根治双写，本 reducer 作兜底防御历史脏数据/漏网场景。
- 装配：`app/plugins/builtins/rocky_context/plugin.json` 登记 impl + `app/plugins/scopes/default.yaml` impls 头插（其他 scope summary/consolidate per-EP 继承 default 自动获得）。
- 详情：`specs/tech/version_logs/v0.0.207/change_plan.md`（§T3 — dedup reducer + 顺序约束）

## 2026-07-25 · v0.0.204 收尾（C2 system_prompt 按 scope 解析实接 + fork-2 纯 directive）

- **`[P0]system_prompt.md §1/§3/§4/§6`**：`buildSystemPrompt(pluginManager, config, scopeId='default')` 透 scopeId + async 化——mapper/reducer 链按 scopeId 取 impl 列表（per-EP extends 回退），scope 级覆写（academy_context / playground 去 squad mapper）真正生效（此前单参恒走 default scope，所有 scope yaml system_prompt 覆写自 v0.0.193 起静默无效——C2 修复）；async 因 academy_context 是唯一 async mapper（sync 迭代 Promise 被降级 catch 吞掉输出）。§4 加 scope 级 mapper 说明。
- **`[P0]context_engine.md §3.1/§3.5`**：assemble 透 scopeId 给 buildSystemPrompt（:240/241）；§3.5 表 mapper 空兜底修正为 throw（v0.0.64 硬失败，原「空 system」失实）。
- **`[P0]context_compact_detail.md §2d.3/§2d.4/§2d.5`**：memory_skill_consolidation 重写为当前实现——fork-2 task message 纯 directive（ConsolidationHandler.build 不读 vars，只填 routing_rules；consolidation.md 删 serialized_transcript，v0.0.51 遗留违例修复，与 fork-1 同契约）+ consolidateRunner（runKind='consolidate'）+ fork-2 usage 总量一次性累计（caller 口径，与 fork-1 runCompact 同契约）；§2d.4 防递归改述 consolidate 基座 scope（noop_post_compact）。

## 2026-07-21 · v0.0.186.summary_bake（summary block 压缩时烘焙 — 组装期零计算，根治 ratio 漂移破缓存前缀）

**root cause（v0.0.185 残留第二机制，prod 实测缓存命中仅 21%）**：v0.0.185 修了 head/tail 候选锚定，但选取累加仍用**动态** `ctx.ratio`——ratio per-session 学习漂移 → 同 summary version 下 head 窗口大小会变（prod 实测 52→55 条）→ messages[0] 在偏移 32409 处变化 → 13 万 tokens 缓存失效。

**修复（owner 拍板：烘焙那一刻用什么 ratio，文本就永远是什么样）**：
1. **compact 烘焙**：`runCompact` 产 summary 时调 `bakeSummaryBlock`（当时的 ratio + 锚定候选 + tokenCap + head∩tail 去重 + budget tailDropped 降级），完整 block 文本（preamble+head+tail）持久化到 **summary 记录新字段 `block`**（schema/types/toSummary 同步；`summary_do_compact` 新增 configSchema `tokenCap`/`candidateLimit` 透传，手动 compact 入口用默认值）。
2. **组装期零计算**：`base_builder` 见 `summary.block` → messages[0] 文本直接 = `block`（不选取、不查候选、不做 summary 侧 budget 判定）；`summary_reader` 见 `block` 不再取 head/tail 候选（省每轮 2 次 `getMessages`）。recent 区不变（仍每轮新→旧 budget 放置）。
3. **fallback**：旧 summary 无 `block` → 走 v0.0.185 即时构建（原样保留），下次 compact 自动升级；不做启动迁移。
4. **算法单源**：pickHead/pickTail/buildSummaryBlock/getEstimatedOutput/烘焙 自 plugin `base_builder_helpers.ts` 迁至 server `app/server/src/agent/summary-block.ts`——compact 烘焙（server）与组装 fallback（plugin）两处消费同一实现（server 不能反向 import plugin 源码）。
5. **顺带修 v0.0.89 迁移遗漏**：`estimatedOutput` 源 `config.devConfig` → `config.appConfig`（devConfig 生产恒 undefined → 恒默认 20000；烘焙与 fallback 两路径统一 appConfig）。

**边界（记 spec）**：烘焙后 head/tail 窗口内历史消息被 HITL 编辑**不回刷** block（recent 区每轮读最新不受影响），下次 compact 重新烘焙。
**spec 同步**：`[P0]context_assemble_detail.md` §4/§5/§6/§6.5；`[P0]context_compact_detail.md` §2 step 5；`[P0]context_snapshot_interface.md` §2 SummaryInfo.block；session KB log 同日条目（summary schema 加 `block`）。

## 2026-07-21 · v0.0.185.cache（summary block 锚定 + tokenCap 选取 — 修 prompt 缓存前缀滑动）

**root cause（prod 实测缓存命中 0.1%~17.8%）**：`transcript_reader` 只读最近 500 条，`base_builder.pickHead` 从 `transcript[0]` 起取——transcript[0] 是「最近 500 条」的头，随新消息滑动 → summary msg（messages[0]）head 段每轮换血 → prompt 前缀缓存 ~86% 失效。

**修复（owner 拍板语义：同 summary version 下 summary block 逐字节一致）**：
1. **候选锚定**：`summary_reader` mapper 单次 `getSummary` 后同取 head/tail 候选（单次读消除双 mapper 双读 summary 的竞态），贡献 `AssembleData.headCandidates/tailCandidates`——head=`getMessages({upToId: summaryUpTo, limit, takeFromStart: true})`（会话真第一条起，`MessageRange` 新能力），tail=`getMessages({upToId: summaryUpTo, limit})`（summaryUpTo 结尾）。均不受 recent 窗口滑动影响；顺带修掉 summaryUpTo 掉出 500 窗口时 `upToIdx=-1` 候选为空的旧异常路径。base_builder 消费，缺省回退 transcript 派生（forked/旧测试 ctx 兼容）。
2. **选取算法替换**：删 6 字段（headMin/Max/Fraction + tailMin/Max/Fraction）→ `tokenCap`（默认 10000，head/tail 各自独立）。min=1 保底；head 从头 / tail 从尾累加 char×ratio，加上当前条会超 cap 就放弃当前条并停止。config schema 直接替换无兼容层（plugin.json + 双 locale i18n key 同步换）。
3. **spec 同步**：`[P0]context_assemble_detail.md` §6 算法段 + rebuild 风险点段；`[P0]extension point and implementations.md` §3.2/§4.3/§4.4；`[P0]session_store.md` MessageRange + session KB log。

**已知边界**：选取累加仍用动态 `ctx.ratio`（owner 拍板沿用 char×ratio 口径）——ratio per-session 学习漂移时选取边界可能 ±1 条，summary block 非「数学意义永远」逐字节一致；但消除了主因（窗口滑动每轮必变）。ratio 收敛后的残余漂移如有实害再评估冻结。

## 2026-07-19 · v0.0.178（forked_builder 修 v0.0.173 silent regression — forked assemble 父上下文丢失）

**root cause（silent regression 自 v0.0.173）**：v0.0.173 base_builder 改「永远 rebuild」时漏改 forked 路径——v0.0.66 设计 forked 走 base_builder append 分支透传 parent transcript，v0.0.173 删 append 分支 + `AssembleData.prevMessages` 字段后，base_builder 只读 `data.transcript`（= in_memory store `[reminder, directive]`）→ parent transcript 完全丢失 → compact forkedRun('summary') 的 LLM 只看到 reminder+directive 但**无对话内容**，summary 空洞。生产影响：compact / memory_extract / consolidation 等 forked agent 自 v0.0.173 起 silent 坏（5 个版本）。UT 全量回归 20 fail / 9 文件，三簇（EP 计数过时 / forked mock 缺方法 / forked assemble 父上下文丢失）。

**修复（簇3a — forked_builder + 固定 parentSnapshot，用户确认 2026-07-19）**：
1. 新建 `forked_builder` reducer（同 `context_assemble_reducer` EP，forked.yaml 激活 forked_builder / default.yaml 仍激活 base_builder）——主干 `ContextEngine.assemble` 零 forked 分支，守 v0.0.66 §2.3「主干零 isForked」。算法：复用固定 parentSnapshot.messages + 从 in_memory transcript 取 summaryUpTo 之后的增量 upsert（同 id 替换 / 新 id 按 ULID 升序 insert；isUlid 跳过 summaryMsg 的非 ULID id 保其原位）。
2. `LoopState.parentSnapshot`（v0.0.178 新增字段，wireInitState 整 run 设一次 = opts.snapshot）。
3. `prepareStage` forked 分支 prevSnapshot 改用固定 `state.parentSnapshot`（不能用漂移的 `state.snapshot`——否则多轮 [...prev, ...transcript] 重复 reminder/userMessage）。
4. 主干 `ContextEngine.assemble` 不动；base_builder 不动（永远 rebuild invariant 保留）；loop-stage-llm.getCleanSnapshot 不动。

**修复（簇1+2+3b — 改测试/locale，不动产品）**：簇1 EP/impl 计数测试断言更新（17 EP / 2 mapper / 1 assemble_reducer(base_builder) / 6 clean_view_reducer / inventory 40）+ 双 locale 补 `context_clean_view_reducer.description` 键；簇2 forked-agent mock 加 `getCleanSnapshot` spy（透传入参）；簇3b assemble-prev-snapshot-ratio 改测 rebuild 不变量（v0.0.173 新语义）。

**偏离 B（coder 额外发现 + 修复，不在 change_plan 簇1-3 范围）**：v0.0.177 forked.yaml 简化 `context_ingest_handler.impls` 只列 3 active，遗漏 `system_reminder_injector` + `search_indexing` 的**显式 disabled 条目**——按 ScopeConfigLoader 语义「未列=继承 default=enabled」，被错误激活（注释说 forked 关它们但实际没关）。修复：补回 `{implId, enabled: false}` 显式声明。

**不动边界**：base_builder（v0.0.173 rebuild invariant 保留）/ clean-view-pipeline / getCleanSnapshot / loop-stage-llm / extension-point.ts / 6 clean reducer impl / API/UI/PRD（UT fix 版本无用户可感知变化）。

**实施偏离记录**（详见 `specs/tech/version_logs/v0.0.178/change_log.md`）：
- 簇3a forked_builder 算法从 change_plan 初版的「简单拼接 [...parent, ...transcript]」升级为「summaryUpTo filter + upsert merge」（用户精确化——避免重复 parent summary 已 recap 的消息，HITL tool_reply 占位编辑后同 id 落 transcript 要替换不追加）。
- 簇1 assemble-pipeline inventory：change_plan 行 12 写 total=40（基于 assemble_reducer=1 假设），但簇3a 加 forked_builder → assemble_reducer=2 impl，total 实际=41（与 v0.0.172 前 41 对齐，未净增）。
- reviewer Minor 直接修：(1) forked_builder i18n key 双 locale 补键（plugin.json 声明占位符但缺键 UI 渲染原始占位符）；(2) 按 §H 删 `[v0.0.xxx]` 版本前缀 + 瘦身冗长历史说明（forked_builder.ts 头部 / loop-ports.ts / build-forked-deps.ts / loop-stage-context.ts / 5 个测试文件）。

**spec 同步**（doc-modifier 阶段 5）：
- `[P0]context_engine.md`：§3 assemble JSDoc + §3.6 第 5 项 + §3.6 forked-active impl 表 + §4 交互图；frontmatter `updated → 2026-07-19`。
- `[P0]context_assemble_detail.md`：当前形态段 + §1 流程图 + §5 标题/表 + 新增 §5c「forked_builder 算法」；frontmatter `updated → 2026-07-19`。
- `[P0]extension point and implementations.md`：§1 计数 47→48 + §2 EP 表 + §3.3 + §3.9 注 + §5 manifest + §5 forked scope 配置 + §6 EP 契约索引；frontmatter `updated → 2026-07-19`。
- `index.md`：顶部 banner + ④ 原则 11 加 v0.0.178 forked_builder 段；frontmatter `updated → 2026-07-19`。
- 详情：`specs/tech/version_logs/v0.0.178/change_log.md`

## 2026-07-18 · v0.0.173（snapshot 永远 rebuild + clean view 分层 — 根治 tool_call 乱序 400）

**root cause（prod leader session `01KXTN7GZZ4T4MBT1GVJ96J3RV`）**：`role_merge`（assemble reducer 链内）合并相邻同 role 消息时吞掉被合并者的 message id → 下轮 `base_builder.appendNew` 的 `mergedPrev` 用 transcript 原版覆盖恢复 id 后，被吞 id 不在 `prevIds` → 当 newOnes 追加到末尾 → tool_use（在被吞的消息里，末尾 idx251）落到 tool_result（前部 idx201）后面 → MiniMax 顺序校验 400。

**13 项改动 roll-up**：
1. `base_builder.reduce()` 永远 rebuild（删 `shouldRebuild` 分支判定 + append 分支调用，函数体只剩 `if (input !== null) return input; return this.buildRebuild(data, ctx);`）。
2. `base_builder.appendNew()` 函数（含 3 个 workaround：① 按 id 用 transcript 原版覆盖 prevMessages / ② 集合 diff 判断新消息 / ③ summaryUpTo cutoff）整段删除。
3. `base_builder.buildRebuild()` 算法不动（保 summary 分支逻辑 = req 不动边界）；顶部注释更新反映「唯一路径」语义。
4. `AssembleData` interface 删 `prevMessages: Message[]` 字段（types.ts + assemble-pipeline.ts 两处同步）。
5. `deepMergeAssembleData()` 删 accumulator `prevMessages: []` + 字段合并行。
6. `prev_snapshot.ts` 整文件删除（贡献 prevMessages 的唯一 mapper）。
7. `plugin.json` 删 `prev_snapshot` impl 登记。
8. **新增 EP**：`ContextCleanViewReducerPoint`（id=`context_clean_view_reducer`，ordered，与 `ContextAssembleReducerPoint` 同构）+ append 进 `BUILTIN_EXTENSION_POINTS`；`app/plugins/groups.json` 的 `context-assemble.extPoints` 同步加项。
9. `plugin.json` 6 个清理 reducer impl 的 `point` 字段 `context_assemble_reducer` → `context_clean_view_reducer`（implId/impl 路径/configSchema/实现代码全不变）。
10. `scopes/default.yaml` + `scopes/forked.yaml`：`context_assemble_reducer` 节点只剩 `base_builder`；新增 `context_clean_view_reducer` 节点含 6 impl（顺序保持原 assemble 链顺序）。
11. **新增文件 `app/server/src/agent/clean-view-pipeline.ts`**：`runCleanViewPipeline(pluginManager, messages, scopeId, config) → Message[] | null`，结构抄 assemble-pipeline reducer 链段（单 reducer 失败降级 catch + 保留 acc；链空 → null caller fallback）。
12. **`ContextEngine.getCleanSnapshot(snapshot, scopeId)` 新增**：`structuredClone(snapshot.messages)` 深克隆 → 跑 clean view 链 → 返新 snapshot（其他字段引用复用，关键不变量绝不 mutate 入参）。
13. **`loop-stage-llm.callLLMForSpec`**（唯一喂 LLM 入口）改走 `getCleanSnapshot`：`rawSnapshot = state.snapshot!` → `cleanSnapshot = await spec.wireContextEngine.getCleanSnapshot(rawSnapshot, scopeId)` → `messages = [cleanSnapshot.system, ...cleanSnapshot.messages]`；`inputCharCount / contextWindowUsage / systemText` 读 rawSnapshot（clean 不改 token 数，cache 友好）。

**测试迁移**：`append-tool-pair.test.ts` 场景 B/C/D 删除（验证已删 appendNew workaround）+ 顶部注释改「v0.0.173 rebuild 路径」+ 新增场景 E（v0.0.173 400 bug 回归保护，用真实 BaseBuilderReducer + RoleMergeReducer + OrphanToolCallReducer 端到端断言 tool_use.id 在 tool_result.id 之前）；`append-real-session-v0161.test.ts` 整文件删（验证已删 appendNew msgId 乱序修复）；新增 `clean-view-pipeline.test.ts`（6 子 case）+ `get-clean-snapshot.test.ts`（4 子 case 强 invariant 测试）。

**不动边界**：system 复用规则（!prevSnapshot.system || summary.version 变 → 重算 system；messages 不参与此判定恒 rebuild）；encode wire 合并（`mergeAdjacentSameRole` 合 tool→user 映射后的 wire role，与 clean view `role_merge` 合原始 role 职责不可互换，不抽公共函数）；reminder 过滤 + cache_control bp#1/bp#2 留 encode；rebuild 的 summary 分支逻辑（summaryMsg + recent + head/tail 切分 + assemble budget 放置）；6 个清理 reducer 内部算法（仅迁移 EP，代码不改）；config/ulid.ts monotonic 实现（rebuild `[...transcript]` 天然有序的保证）；compact 链路（state.snapshot 现稳定 rebuild，forked 经 callLLMForSpec 自动覆盖）。

**风险点（上线监控）**：有 summary 时 buildRebuild 的 head/tail 边界随消息数变可能 cache miss（buildRebuild 自己用 summaryUpTo 切 head/recent，同输入同输出，但消息数变则切点变）；rebuild 是确定性纯函数保 wire bytes 稳定，无 Math.random/当前时间/外部状态（reviewer 必查）；structuredClone 深克隆保原 snapshot 不被 mutate（UT 强 invariant 测试）。

**实施偏离记录**（详见 `specs/tech/version_logs/v0.0.173/change_log.md`）：
- T2 连锁文件 7 个（change_plan §二漏列）：assemble-mappers.test.ts / assemble-reducers.test.ts / base-builder-v081.test.ts（emptyData 删 prevMessages 字段 + 失效测试删除）/ loop-stage-context.ts 3 处注释 / context-engine.ts 1 处注释 / agent-loop-user-msg-reissue.test.ts + drain-and-partition-sender.test.ts 各 1 处历史脉络注释。
- T3 `loop-stage-llm` `inputCharCount` 读 `rawSnapshot` 而非 `cleanSnapshot`（change_plan §四未明示，显式取 rawSnapshot 表达「clean 不改 token 数」语义；cache 友好）。
- T4 `get-clean-snapshot.test.ts` 改用 inline fake reducer 替代真实 BaseBuilderReducer + RoleMergeReducer（server tsconfig `rootDir:./src` 限制使 server 测试不能 import `app/plugins/` 源码；本测试目的是验证 structuredClone 深克隆 invariant，reducer 只需 mutate cloned messages 让 invariant 可观测即可；真实 reducer 行为由 append-tool-pair 场景 E 覆盖）。
- T1 漏 `groups.json` 登记（T4 全量 test 暴露：ScopeConfigValidator bootstrap 强制校验 EP 必须属 group）；orchestrator 直接补 `app/plugins/groups.json:13` 的 `context-assemble.extPoints` 加 `context_clean_view_reducer`。
- `context-engine.ts` 353 行（review 裁决：未破 450 行硬线，defer 拆分）；`AssembleCtx.prevSnapshot` 字段保留（T2 未删，base_builder 不再读，多个 UT fixture 注入 prevSnapshot: null，删字段引发更大范围 fixture 改动，不阻塞）。

**spec 同步**（doc-modifier 阶段 5）：
- `[P0]context_assemble_detail.md`：§1 reducer 链示意改两层（assemble_reducer + clean_view_reducer）；§2 重写「snapshot 永远 rebuild（v0.0.173 重构）」；§2.6 appendNew 整段移除；§3 AssembleData 删 prevMessages + AssembleCtx 注释更新；§4 mapper 表删 prev_snapshot 行；§5 reducer 表只剩 base_builder；新增 §5b「内置 clean_view_reducer（6 项）」；§6 system 注释更新（callLLMForSpec 先经 getCleanSnapshot 再 prepend cleanSnapshot.system/messages）。
- `[P0]context_engine.md`：§3 接口新增 `getCleanSnapshot` 方法定义 + JSDoc；§3 assemble JSDoc 更新（v0.0.173 永远 rebuild，prev_snapshot 删）；§3.5 调用表新增 getCleanSnapshot 行；§4 交互图加 getCleanSnapshot 步骤；frontmatter updated → 2026-07-18。
- `[P0]extension point and implementations.md`：§1 概述 + §2 EP 表 改 10→11 EP（+ `context_clean_view_reducer`）；§3.2 mapper 删 prev_snapshot；§3.3 assemble_reducer 只剩 base_builder；新增 §3.10 clean_view_reducer（6 项）；§5 manifest 同步；§6 EP 契约索引新增行；合计 48→47 impl（-1 prev_snapshot mapper）。
- 详情：`specs/tech/version_logs/v0.0.173/change_log.md`

## 2026-07-18 · v0.0.171（read 工具 offset 越界 + assemble 新增 fill_empty_text reducer — 防 LLM 400 空 text block）

- **`[P0]context_assemble_detail.md §5` 新增 `fill_empty_text` reducer 行**（order 5，位于 think_remove 之后、empty_message 之前）：把 `role==='user'` message 与 `role==='tool'` message 里 success tool_result（isError:false）嵌套 content 中 `type==='text' && text===''` 的 block 兜底为 `"empty"`，防空 text content block 发给 LLM 撞 Anthropic 400 "text content is empty"。命中时经 `ctx.config.logWriter` 写一条 error 级日志（鸭子类型能力探测 + try/catch fail-silent）。
- **`[P0]context_assemble_detail.md §5` reducer order 表对齐 yaml 生效序（顺带修旧漂移）**：原表「默认 order（登记序）」与 `app/plugins/scopes/{default,forked}.yaml` 实际生效序不一致（spec 写登记序散文，yaml 真生效序为 `base_builder(1) → snip_handler(2) → orphan_tool_call(3) → think_remove(4) → fill_empty_text(5) → empty_message(6) → role_merge(7)`）。改表头为「yaml 生效序」+ 7 行 order 全对齐。
- **`[P0]context_assemble_detail.md §1`** 当前形态 impl 计数 9→10（3 mapper + 7 reducer，含 v0.0.171 fill_empty_text）+ 流程图链序补 fill_empty_text。
- **代码定位**：`app/plugins/builtins/rocky_context/assemble/fill_empty_text.ts`（class `FillEmptyTextReducer extends ContextImplBase implements AssembleReducer`，构造器签名 (implId, cfg) 同其他 reducer）+ `app/plugins/scopes/default.yaml` + `forked.yaml` 的 `context_assemble_reducer` impls 列表新增 `fill_empty_text` 行（位于 think_remove 与 empty_message 之间）。
- **不动**：§2 shouldRebuild / §2.6 appendNew / §6 产出结构 / §6.5 assemble budget / §7 usage（fill_empty_text 是末段清理 reducer，不碰 base_builder 产出结构与 cache 逻辑）。
- 详情：`specs/tech/version_logs/v0.0.171/change_log.md`（如有）

## 2026-07-17 · v0.0.161（appendNew 集合 diff + summaryUpTo cutoff — queue 消息未入 context bug 加固）

- **`[P0]context_assemble_detail.md §2` append 一句**：`appendNew(prev.messages, data.transcript)` → `appendNew(prev.messages, data.transcript, summaryUpTo)`——按 id 覆盖 prev 已有 + **集合 diff** 追加 summaryUpTo 之后不在 prevIds 的新增（替旧 lastPrevId slice 顺序切片）。
- **`[P0]context_assemble_detail.md §2.6` 新增「appendNew 集合 diff + summaryUpTo cutoff（v0.0.161）」**：签名 + 算法伪码 + mergedPrev 覆盖保留（v0.0.66 workaround，`append-tool-pair.test.ts 场景 B` 验证）+ 集合 diff 加固逻辑 + v0.0.161 bug 复盘（旧 lastPrevId slice 依赖 msgId ULID 单调 = drain 顺序 invariant，被 user 分支保留 throwaway id 打破 → 位置错乱被永久漏掉）+ A（drain 对称化）与 B（appendNew 集合 diff）双修关系（A 根治源头保 msgId 顺序，B 加固不再依赖顺序）+ 纯 set diff 不安全的 compact 场景反例（必须 cutoff 防 m1..m4 回涌）+ caller 从 prev 快照取 summaryUpTo 的语义说明。
- **代码定位**：`app/plugins/builtins/rocky_context/assemble/base_builder.ts` line 220-241 `appendNew(prevMessages, transcript, summaryUpTo?)` 三参签名 + line 104-106 `BaseBuilderReducer.reduce` 从 `prev!.summary?.summaryUpTo ?? null` 传参。
- **UT 场景 D 加**：`app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts` 「compact 场景 summaryUpTo cutoff 正确」case 防「后来有人删掉 cutoff 退回纯 set diff」回归。
- 详情：`specs/tech/version_logs/v0.0.161/change_log.md`

## 2026-07-16 · v0.0.158.compact_model_resolve（compact 走 chat 同链 + runner 唯一入口收敛）

- **`[P0]context_compact_detail.md §2b.1`**：POST /compact 端点契约段加 v0.0.158 补注——handler 内部 SessionConfig 组装收敛为**唯一入口** `agentManager.resolveConfigBySid(sid)`（chat/compact 无区分，无 `task` 参数、无 summary 子链）；旧版自建 `buildSessionConfigFromDeps(..., task='summary', ...)` 独立支路已删（handler 从 ~90 行瘦到 ~30 行）。resolve 跑空仍返 400 `{code:"MODEL_NOT_CONFIGURED", message, detail:{sessionType}}`（detail.task 字段已删）。model resolve 契约见 `../providers_and_models/[P0]model_resolve.md §3`（chat 单链 2 行；playground → default_models.chat / studio → squad.modelDefault）。
- **`[P0]context_compact_detail.md §6.4` caller 契约**：新增行「v0.0.158 runner 唯一入口收敛」——`CompactForkedRunner` + `ConsolidationRunner` 的 input 删 `config: SessionConfig` 字段；bootstrap `setForkedRunner` / `setConsolidationRunner` 闭包内**首行** `await agentManager.resolveConfigBySid(input.sessionId)` 自 resolve。`runCompact` 形参 `config` 保留（内部只用 `config.sessionId` 派生 sid + 交给 taskLock，功能不变）。
- **不动**：§2 自动触发流程 / §2c tryCompact 胶水 / §2d post-compact handler / §3 压缩 prompt / §4 增量 merge / §5 SummaryInfo / §7 与 assemble/usage 关系（本版本改的是 model resolve 层的入口收敛，compact 内部执行流程 + forked agent 契约不动）。
- 详情：`specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md`（§C session-compact + §E bootstrap + §F runner input）

## 2026-07-15 · v0.0.153（packaged 环境 prompt content 缺失修复 + 4 处硬编码 prompt 迁 md + build 期资源自检）

- **打包修复（BUG-001）**：`app/server` build 脚本补 `cp -r src/prompts/content dist/prompts/`（`tsc -b` 只编译 `.ts`、从不复制资源，migration yaml 早有此坑的先例）；新增 `scripts/check-server-build-assets.sh` 做 src→dist 镜像比对，缺失即 build fail 并指名文件，接在 build 脚本末尾（防复发同类"新增资源文件忘记进 dist"）。详见 `../../app/package/[P0]packaging_toolchain.md §3.8`。
- **`[P0]prompt_content_files.md`**：新增 §3.4 打包完整性自检契约（`CRITICAL_CONTENT_FILES` + `checkPromptContentAssets()`，bootstrap 启动期只 log 不抛错的运行期兜底）；`readContent()` 签名加可选 `relPath` 参数（向后兼容，供同一 handler 实例读取多段 content）；§4 拆分为 §4.1（system_prompt_mapper 消费）+ §4.2（新增，非 fragment 的独立文案 handler：Compact/Consolidation/AutoNaming/RoutingDecision/ForkedReminder/HeartbeatTick）；§5 content 文件清单补全至 17 个文件。
- **4 处硬编码 prompt 迁 md**（正文逐字迁移，测试用「原常量快照 + 新实现比对」锁死）：`auto-naming-service.ts` 的 `NAMING_PROMPT` → `content/auto_naming.md`（`AutoNamingHandler` + `{{query}}`）；`routing-decision.ts` 的 `ROUTING_DECISION_PROMPT` → `content/routing_decision.md`（模块私有 `RoutingDecisionHandler`，模块顶层即时求值，三处消费方 `memory-manage.ts`/`skill-manage.ts`/`ConsolidationHandler` 零改动）；`forked-reminder-injector.ts` 的 `buildReminderText` 骨架 → `content/forked_reminder/{skeleton,tools_none,tools_all,mode_tail_summary,mode_tail_memory_extract}.md`（`ForkedReminderHandler`，三态/modeKey 判断逻辑留代码）；`tick-message.ts` 的 `HEARTBEAT_TICK_PROMPT` → `content/tick_heartbeat.md`（`HeartbeatTickHandler`）。
- **BUG-004 修复（squad KB）**：`squad_reminder_shared.ts readSessionType()` 归一化 `k.role==='rocky' → undefined`，修正与自身注释（`readSessionKind` L111）长期不一致导致 playground standalone 场景 `identity.ts` 反向判定 `!sessionType` 落空分支、identity.md 正文缺失的回归；详见 `../../squad/log.md` 同日条目。
- 详情：`specs/tech/version_logs/v0.0.153/change_log.md`

## 2026-07-15 · v0.0.149.memory_opt（skills/memory mapper 加分组排序截断 — 注入配额）

- **`[P0]system_prompt.md §4`**：skills mapper（order4 stable）加「三类分组 system→user→agent + 组内 updatedAt 倒序 + 总量上限前 N」；memory_user（order6 stable）+ memory_session（order7 context）加「四类分组 + 总量上限前 N」——两 memory mapper 经共享纯函数 `selectMemoriesByQuota` 协同共享同一 maxMemoryInject 配额（同输入同输出，各自仍贡献本 tier fragment，reducer/builder 无感）。**不新增 reducer**（截断在 mapper 内，用户决策）；配额读 `app_config` group `session`（maxSkillInject/maxMemoryInject，缺失回退50）。skill=stable，数量变破 prompt cache（预期内）。

详情：`specs/tech/version_logs/v0.0.149.memory_opt/change_plan.md`

## 2026-07-15 · v0.0.146.tool_desc（tool_guidance mapper 优先 intro — system prompt 用短简介）

- **`[P0]prompt_content_files.md §4/§5` + `[P0]system_prompt.md §4` + `[P0]extension point and implementations.md §3.4`**：`tool_guidance` mapper 拼 `{{tool_list}}` 从 `name + description` 改为 `name + (intro ?? description)`——优先读 `ToolDefinition.intro`（一句话短简介），无则 fallback `description`。完整 description 留 tool schema（`snapshot.tools` → LLM function calling），消除 system prompt 与 tool schema 冗余。`tool_guidance.ts` mapper `map()` 用 `def.intro ?? def.description` + `readDefinition()` duck-type 增读 `intro?`。ToolGuidanceHandler / `content/tool_guidance.md` 模板不动（intro 选择在 mapper 层，handler 纯模板替换）。详见 `../tools/log.md`（同版本 ToolDefinition 主变更）。

详情：`specs/tech/version_logs/v0.0.146.tool_desc/change_log.md`

## 2026-07-12 · v0.0.126.history_search（新增 search_indexing ingest handler — 派生索引旁路 sink）

- **新增 `search_indexing` ingest handler**（`context_ingest_handler` EP，`app/plugins/builtins/rocky_context/ingest/search_indexing.ts`）：order=5 紧随 `store_sink`(4)；role∈{user,assistant} 的 message 从 content ContentBlock[] 提取 type=text part 拼纯文本 → 投递 `HistoryIndexer.index({messageId, sessionId, role, ts: m.id, text})`（不 await、不阻塞 ingest，异常吞掉 + reconcile 兜底）。**失败一致性**：store_sink 抛错 → chain 中断 → search_indexing 不执行 → 永不孤儿。注册于 `plugin.json`，登记序 5。
- **indexer 注入**（delegate holder 模式）：plugin_manager 经 `new ImplClass(implId, cfg)` 按需 new handler（无缓存），构造器只接 (implId, cfg) 无法直接注入 HistoryIndexer → bootstrap 用 `app/server/src/persistence/search-indexer-ep-delegate.ts` 的 `setSearchIndexerEpDelegate(idx)` holder 注入（server → server，与 session-store-ep-delegate 同模式）；handler import `getSearchIndexerEpDelegate()` 取（未注入返 null → no-op）；兼容 `setIndexer`（UT 显式注入）+ holder 两路径。
- **scope 配置**：`search_indexing` 只 default scope active；forked scope 经**声明式 yaml 配置** disable（`app/plugins/scopes/forked.yaml` 的 `context_ingest_handler` impls: `[{implId: search_indexing, enabled: false}, ...]` + ScopeConfigLoader 按 enabled=false 跳过赋 order）。forked 不进历史索引（防派生会话内容污染历史召回 + forked in_memory store 无 transcript 可锚）；与 store_sink 配置解耦（store_sink 仍 default+forked 都 active 写各自 store）。
- **`[P0]extension point and implementations.md` 计数对齐**：§1 + §3 标题 + §3 末尾合计 改 43 → 46（manifest 实际登记 46 含 search_indexing + 2 未单列 squad impl）；§3.1 context_ingest_handler 表 4→5 行加 search_indexing；§3.9 后 scope 配置 v0.0.126 行改 disable 实际机制（声明式 yaml，非 `disableImplInForked` API——后者不存在，spec 早期草稿概念虚构）。
- **`index.md`**：① 概述 + ② 边界 + ③ 协作点 + ⑤ 导航 `extension point and implementations.md` 描述 全部 40→46 impl（含 search_indexing）。
- 详见 `../persistence/log.md`（同版本 SearchEngine + HistoryIndexer 主变更）+ `specs/tech/version_logs/v0.0.126/change_log.md`。

## 2026-07-09 · v0.0.98.think_remove（新增 think_remove assemble reducer — 删 reasoning block）

- **新增 `think_remove` reducer**（`context_assemble_reducer` EP，`app/plugins/builtins/rocky_context/assemble/think_remove.ts`）：组装上下文时删除所有 message 的 reasoning(think) content block（`b.type === 'reasoning'` 过滤，不可变 `{...m, content: filtered}`，`input===null → []`）；不删 message 本身（删 block 后变空的 message 由其后的 `empty_message` reducer 兜底清理）。注册于 `plugin.json`。
- **scope 执行序**（`app/plugins/scopes/default.yaml` + `forked.yaml` 同一序）：`base_builder → snip_handler → orphan_tool_call → think_remove → empty_message → role_merge`——think_remove 位于 empty_message **之前**（先删 reasoning block，再由 empty_message 清理因此变空的 message）。default + forked scope 均已配置。
- **`[P0]context_assemble_detail.md`**：§1 当前形态 impl 计数 8→9（3 mapper + 6 reducer）；§3 流程图 + §5 链式说明 链序更新为实际 scope 序（含 think_remove）；§5 内置 reducer 表新增 think_remove 行（登记序 `—`，v0.0.98 新增；不重排旧行 priority 编号）；§5 forked-active 注 5→6 全 active / 4→5 清理 reducer。
- **`[P0]extension point and implementations.md`**：§3.3 `context_assemble_reducer` 计数 5→6 + 表新增 think_remove 行（登记序 4，对齐 manifest 注册序）；§5 manifest jsonc 新增 think_remove 行（comment 5→6）；全文 impl 总数 42→43（通用基线 26→27）；§5 forked-scope 注 4→5 清理 reducer（orphan/empty/role_merge/snip/think_remove active）。
- `think_remove.ts` 头部注释 spec 引用路径修正：`specs/tech/agent/context_and_memory/`（旧目录名）→ `specs/tech/agent/context/`（仅本新文件；sibling 5 个 reducer 的同类旧路径留待统一清理）。
- specs/api / specs/prd 无需同步（assemble 是内部管线，无 API/UI 契约暴露）。无独立 version_logs/change_log（非正式版本）。

## 2026-07-06 · v0.0.82.forked_cache_fix（forked 复用 main 产物保 cache — tools + snapshot 双对齐）

> dev1 直接 bugfix（用户授权，未走 worktree 流程）。两 commit：ab15d9ec（forked 工具集复用 snapshot.tools）+ 1d37c93f（runCompact 收 snapshot 对象替代 assembleFn 回调）。无独立 version_logs/change_log（非正式版本）。

- **`[P0]context_snapshot_interface.md §2`**：`tools` 字段从 `tools?: ToolDefinition[]`（v0.0.8 简化省略）恢复为必填 `tools: ToolDefinition[]`，加详细注释（assemble 从 config.tools 派生；forked 读 snapshot.tools 保 cache 前缀；v0.0.82 修复 cache 分叉 bug 时恢复）。
- **`[P0]context_assemble_detail.md §7.5`**：补「v0.0.82 字段必填 + forked 复用保 cache」段——forked 之前用 registry 全集 24 vs main policy 裁剪集 20 分叉破 cache，修复 = assemble 写进 snapshot（与 main spec.toolDefinitions 同源），forked 读 snapshot.tools。
- **`[P0]context_compact_detail.md §2b.3 / §6.4`**：§2b.3 加段「runCompact 收 snapshot 对象，不再收 assembleFn 回调」——caller（tryCompact）持 main state.snapshot 深拷贝传入；手动入口（POST /compact）caller 不持 main snapshot，ContextEngine.compact 先 assemble 再调 runCompact；v0.0.16 引入 assembleFn 的三原由（延迟生产/锁内新鲜/循环依赖）在 compact 场景都不成立，v0.0.82 删 callback 回归直收 snapshot。§6.4 caller 契约加 `[v0.0.82] runCompact 签名` 行（`runCompact(store, taskLock, config, snapshot, forkedRunner, ...)`，CompactCtx 删 assembleFn 字段）。
- **`index.md` ④ 加第 15 条原则**：forked 复用 main 产物保 cache（tools + snapshot 双对齐）+ 实测 cache_read 数据（MAIN 56%、SUMMARY/MEM_EXT 93%）。**已知 issue 段**：sibling 隔离失败（router 塌缩 modeKey → store 共享 ('forked', sid) slot → buffer 混合两任务内容；SUMMARY trace messages[12] 含三种矛盾指令；修复方向：router 改 return modeKey + per-modeKey scope entity）。

实现层（commit）：
- `app/server/src/agent/context-types.ts`：ContextSnapshot.tools 加回（必填，spec §2 完整形态本含）。
- `app/server/src/agent/context-engine.ts`：assemble 产出 snapshot 时填 tools（从 config.tools.map(t=>t.definition) 派生，与 main spec.toolDefinitions 同源）；手动入口 `compact()` 先 `this.assemble(config)` 再 runCompact。
- `app/server/src/agent/build-forked-deps.ts`：toolDefinitions 改读 `opts.snapshot.tools`（不再读 opts.toolDefinitions registry 全集）。
- `app/server/src/agent/context-compact-runner.ts`：runCompact 签名 `assembleFn` → `snapshot: ContextSnapshot`，删重新 assemble 一行（直接用传入 snapshot）。
- `app/server/src/agent/compact-types.ts`：CompactCtx 删 `assembleFn` 字段。
- `app/plugins/builtins/rocky_context/compact/summary_do_compact.ts`：传 `ctx.snapshot`（替代 ctx.assembleFn）。
- `app/server/src/agent/loop-stage-context.ts`：删 compactCtx 的 assembleFn 注入（:202）。
- `app/server/src/bootstrap.ts`：forkedRunner + consolidationRunner 传 `toolDefinitions: []`（forked 走 snapshot.tools）。

**已知 issue 待修（sibling 隔离）**：`AgentScopeRouter`（agent-scope-router.ts:11,21）把所有非 current modeKey 都映射成 `scopeId='forked'`（Min 方案）；`in_memory_session_store` 按 `(scopeId, sid)` 隔离 → summary + memory_extract sibling 共享同一 slot → wireInitState.clearScopeSession + ingest 互踩 → buffer 混合两任务内容。修复方向：router 改 `return modeKey`（per-modeKey scope）+ in_memory EP per-modeKey 注册 + ensureForked 建 per-modeKey scope entity。

## 2026-07-06 · v0.0.81.compaction_bug（compact 阈值纯比例 + base_builder 1-block summary + assemble budget + compact_notice 整删）

- **`[P0]context_compact_detail.md`**：
  - §1 触发算式 + §2c.2 默认 impl 公式：`(total + maxOutput) / limit > compactRatio` → `total / limit > compactRatio`（**去 estimatedOutput**，纯使用比例；用户视角占用）。§1 加 estimatedOutput / maxOutputTokens 字段语义澄清段（= estimated output 估算输出常量，非 model maxOutput，仅 assemble budget 用）。
  - §2c.5：旧版 `(total+maxOutput)/limit > 0.6` 标为历史，新口径 `total/limit > 0.6`；加历史算式演进注（v0.0.8 撞墙压 → v0.0.16 修漏减 → v0.0.40 plugin 化提前压但分母含 estimated → v0.0.81 纯比例）。
  - §6.4 caller 契约副作用行：`[v0.0.16] system message 留痕由 caller 显式调 appendMessages` → `[v0.0.81] compact_notice 留痕整删，compact 是纯生产者，零 transcript 副作用`。
  - **§6.5 compact_notice 章节整删**（buildCompactNoticeMessage / 落点 / UI 渲染）—— grep 0 代码残留（`summary_do_compact.ts` / `noticeEmitter` / `agentLoopBus` / `chat-slice-reducer` / `message-flatten` 全删）；替换为简短「§6.5 已删，compact 现在零 transcript 副作用，见 §2c.1.0」段。
- **`[P0]context_usage_detail.md §3`**：加 estimatedOutput 字段语义澄清段（消费边界：✅ 进 assemble budget / ❌ 不进 compact 阈值 / ❌ 不进 UI 占用展示）；frontmatter `updated`→2026-07-06。
- **`[P0]context_assemble_detail.md`**：
  - §6 产出结构：summary msg 从「每消息 1 text block（summary + head overlapped + tail overlapped）」改为「**1 个 text content block，3 段**（preamble + head 段 `[msgid|role] content` + tail 段同格式）」；`role=user`（非 system）；`id=summary:{version}`；head∩tail 按 head 算（Set 去重）；recent 从新→旧放置至 budget。
  - 新增 §6.5 assemble budget 放置：`budget_tokens = 0.95 × tokenLimit − estimatedOutput`（estimated output = DevConfig maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS=20000）；summary 始终放置（自身超 budget 丢 tail）+ recent 从新→旧累加至剩余预算；常量源 `app/server/src/agent/session-usage-helper.ts`。frontmatter `updated`→2026-07-06。
- **`[P0]context_snapshot_interface.md §2`**：`maxOutputTokens` 字段注释加详细语义说明（estimated output 估算输出常量 + 消费边界）；frontmatter `updated`→2026-07-06。
- **`index.md`**：④ 原则 12「纯生产者」补「不再 appendMessages compact_notice」；新增原则 13（compact 阈值纯使用比例 + assemble budget 0.95×limit−estimatedOutput + summary 1-block 3-段，三层独立但同源 estimated output 常量 20000）。
- 实现层（task）：`threshold_should_compact.ts` 公式 + 注释；`base_builder.ts` + 拆出 `base_builder_helpers.ts`（pickWindow/buildSummaryBlock/pickRecentWithinBudget/getEstimatedOutput）；`session-usage-helper.ts` 新增 `DEFAULT_MAX_OUTPUT_TOKENS=20000` 常量；UI `component-usage-panel.tsx` 进度条 4→3 段 + free=limit−total；UI `use-session-run-state.ts` + 拆出 `merge-messages-by-id.ts`（transcript fetch / loadMore by-id merge，保 SSE 累积态 tool_call 增量不被覆盖）。

详情：`specs/tech/version_logs/v0.0.81.compaction_bug/change_log.md`

## 2026-07-06 · v0.0.80.t1（compact 触发点迁移 + sibling 双发 + 纯生产者）

- **`[P0]context_compact_detail.md §2c.1` 伪代码重写**：触发点从 `ingestAssistant`（callLLM 后）迁移到 `prepareStage` 之后 / `callLLM` 之前；`tryCompact` 谓词 true 后 deep clone snapshot → `void runSummarySibling + void runConsolidationSibling` 并发双发（替代旧 `await action.run + await triggerPostCompact` 串行链）；调用契约改为「**prepareStage 之后、callLLM 之前**调用（last msg 必 user/tool_result，无 hanging tool_call）」。
- **§2c.1.0 新增「summary = 纯生产者」原则段**：compact 只产 summary + compact_notice + accumulateUsage('forked') write；不 re-assemble、不 setSystem、不 notifyUsageChanged（含 runner 内部）；消费侧归正规 assemble 管线（`prepareStage`/`ingestAssistant`/`ingestToolResults` 每次 assemble 后 notify，`getUsageView` 读全量 record emit）。
- **§2c.1.1 并发不变量段更新**：不变量 #5 改写（删除 v0.0.78.bug 的 re-assemble 同步尾论证，改述为「compact 不刷主 loop snapshot」）+ 新增不变量 #6（sibling 双发互不阻塞）。
- **§2d post-compact handler EP**：标注「v0.0.80.t1 起 handler.handle 改 sibling fire-and-forget 调用（不再 await doCompact 后串行触发），由 tryCompact 胶水直接并发派发；handler 内部 acquire 'tier1_consolidation' 锁」；§2d.1 触发时机改为「tryCompact 谓词 true 后 sibling 双发」；§2d.5 表格「时机」行更新。
- **`index.md` ④ 加第 12 条原则**：compact 触发点 = callLLM 前 + sibling 双发 + 纯生产者。
- 实现层（task）：`run-react-loop.ts` 加触发点；`loop-stage-context.ts` 删 ingestAssistant 触发 + 删 runTryCompact 同步尾；`try-compact.ts` 重构为 sibling 双发 + 新增 runSummarySibling/runConsolidationSibling + 删 triggerPostCompact；`context-compact-runner.ts` 删 L170-172 notifyUsageChanged 循环（accumulateUsage write 保留）；`post-compact-consolidation.ts` handler acquire 'tier1_consolidation' 锁。

详情：`specs/tech/version_logs/v0.0.80.t1/change_log.md`

## 2026-07-06 · v0.0.78.bug（compact fire-and-forget + 并发不变量段）

- **`[P0]context_compact_detail.md §2c.1`** tryCompact 调用改 fire-and-forget：原 `await tryCompact(...)` 改为 `void tryCompact(...).catch(err => log)`；caller 不再 await，主 loop run_end 立即发出。
- **新增 §2c.1.1 并发不变量段**（5 条）：per-session SessionTaskLock CAS 互斥 / forked 走独立 in_memory store / compact 无副作用（不碰五态机） / summary 写入幂等 / re-assemble 在主 loop 下一轮 prepare 自然承担。引用 change_plan §0。
- **关键约束**：MUST NOT 在主 loop 加 try/catch 等结果、MUST NOT 让 unhandled rejection 上抛；runTryCompact 内部 catch 已调 markFailed + rethrow → 外层 catch 仅观测。

详情：`specs/tech/version_logs/v0.0.78.bug/change_log.md §T1`

## 2026-07-05 · spec 滞后修正（v0.0.66 sink/store 形态同步，无代码变更）

> v0.0.66 重构时 `[P0]context_ingest_detail.md` + `store_sink.ts` 顶部注释 + `extension point and implementations.md` §6 一处段落未跟上新形态，仍描述 v0.0.49 的「store_sink/buffer_sink 二选一 / forked 不注入 store / forked disableImplInForked」。本次纯文档对齐——代码与 `[P0]context_engine.md §3.6`（已是 v0.0.66 新形态）一致，**无实现变更**。起因 reqs/v0.0.70.context_fix 链路核查（结论：设计 OK，正常消息流写 transcript 唯一入口 = ingest chain 尾 `store_sink`，store 注入按 scope 由 `session_store` EP 切 impl；assemble 不写 transcript；abort/compact/降级 3 处直接 `store.appendMessages` 是合理特例）。

- `[P0]context_ingest_detail.md`：§1 概述图 sink 行 + §2 表格 ② 行 + 解释段 + §3 `IngestCtx.store` 注释 + 内置 impl 登记序 + 表格 `store_sink`/`buffer_sink` 两行 + §5 整段重写——统一为「default+forked 共用 `store_sink`，store 由 `session_store` EP 按 scope 切 impl（default=`persistent_session_store` / forked=`in_memory_session_store`），`buffer_sink` v0.0.66 退役」；§5 补降级路径（无 pluginManager / 空链直 append，避免与 store_sink 双写）。
- `app/plugins/builtins/rocky_context/ingest/store_sink.ts` 顶部注释：从「default scope 专属汇 / 与 buffer_sink 二选一 / forked disableImplInForked + 不注入 store」改为「default+forked 共用，零 scope 分支，透传 session_store EP 按 scope 选的 store impl」+ 演进段（v0.0.49 D15 → v0.0.66）+ 补 v0.0.66 design 参考。
- `[P0]extension point and implementations.md` §6：原 `[v0.0.49] sink impl scope 配置` 段标为 `[v0.0.49 历史]` + 「已被 v0.0.66 取代，见紧接的下方配置」，避免与 v0.0.66 新配置段并存误导。
- 核实 `[P0]context_engine.md §3.6` 已是 v0.0.66 权威新形态（line 16/72/87/162/183/196），无需改动。

## 2026-07-04 · v0.0.66（context engine assemble/ingest 协议重构 — session_store EP + 零 isForked）

- **session_store EP 化**：新增 `SessionStorePoint`（exclusive, group='context'）+ 2 impl（`persistent_session_store` 包装真实持久 SessionStore / `in_memory_session_store` per-session Map）；EP 总数 9→10，impl 总数 40→42。
- **主干零 isForked**：`context-engine.ts` / `assemble-pipeline.ts` / `context-ingest-pipeline.ts` / `base_builder.ts` 删所有 `if (scopeId === 'forked')` / `isForked` 运行时分支；default + forked 同一套主干逻辑，差异纯靠 session_store EP impl 切换 + summary 驱动 rebuild。
- **删 4 buffer/system impl**：`buffer_sink` / `buffer_reader` / `append_passthrough`（forked 改用 `base_builder` + in_memory store）+ `system_prompt` assemble mapper（system 由 context-engine.assemble 独立调 builder）。
- **system prompt 独立 + 复用**（design §1.3）：删 `system_prompt` assemble impl；`context-engine.assemble` 按 shouldRebuild = !prevSnapshot || summary.version 变 → 调 `buildSystemPrompt`，否则用 `prevSnapshot.system`。default + forked 同一逻辑。
- **base_builder 统一 shouldRebuild**（design §1.2）：`!prev || prev.messages 空 || (curVersion!==null && curVersion!==prevVersion)`；forked curVersion 恒 null（in_memory getSummary 恒 null）→ 永远 append。
- **appendNew 按 id 覆盖保 tool_call 配对**：append 路径不再「只追加 prev 末尾之后」，先按 id 用 transcript 原始版本覆盖 prev 中已有的（补偿清理 reducer orphan_tool_call 中间状态剥掉 tool_call block 的副作用）。
- **messages 纯对话历史**：base_builder 不再构 systemMsg（rebuild 路径产 `[summaryMsg?, ...recent]`）；system 由 `snapshot.system` 独立 Message 字段承载；`loop-stage-llm.callLLMForSpec` 送 LLM 前 prepend `[snapshot.system, ...snapshot.messages]` 让 protocol encode 抽 system 落 wire system 位。
- **forked reducer 对齐 default**：forked active 5 reducer（base_builder + orphan/empty/role_merge/snip），与 default 一致；forked-scope-bootstrap §6 不再 disable 4 清理 reducer（旧 v0.0.49 「关 4 清理 reducer 削减 chain 遍历」基于 append_passthrough 丢弃 input 的前提，v0.0.66 forked 改用 base_builder 后 input 不丢弃，前提失效）。
- **SessionStoreContract.clearSession → releaseSlot 重命名**：解 `SessionStore.clearSession`（删整 session 返 Session）命名冲突；`releaseSlot` 仅清 forked 内存槽（forked run 结束 caller 调）。
- **memory 单 impl 退役对齐**：v0.0.51 拆为 `memory_user`(stable) + `memory_session`(context) 已直接登记在 manifest，本版 spec 计数对齐（无聚合 `memory` 行）。
- **文件拆分**（≤300 行约束）：`context-engine.ts` 拆出 `context-engine-store-resolver.ts`（resolveStore + clearScopeSession）；`build-forked-deps.ts` 拆出 `forked-lifecycle-port.ts`；`types.ts` 拆出 `store/types.ts`（SessionStoreContract）。
- **遗留（v0.0.67）**：forked-scope-bootstrap 运行时 enable/disable 流氓逻辑（v0.0.66 保此逻辑覆盖落盘 false drift，v0.0.67 重构落盘清理）；真 LLM AT 待配 provider。
- 同步 `context_engine.md`（§3 签名删 buffer + §3.5 表 + §3.6 重写 session_store EP + §4 交互图加 prepend + ⑤ 导航）+ `context_assemble_detail.md`（§2 shouldRebuild + §3 AssembleData 删 system + §4 mapper 删 system_prompt 行 + §5 base_builder 行 + §6 产出结构删 systemMsg）+ `extension point and implementations.md`（EP 9→10 + impl 40→42 + §3.2 删 system_prompt + §3.4 memory 拆 + §3.9 新增 session_store + manifest 整对齐）+ `index.md`（① 概念表 + ④ 加原则 11）。

详情：`specs/tech/version_logs/v0.0.66/change_log.md`

## 2026-07-04 · v0.0.64 P5（time reminder 含时分+时区，进程本地 = client tz，不查 session）

- `[P0]system_reminder.md §3`：time provider 内容从「系统时间（**日期精度**，保 cache）」改为「系统时间（**含时分 + 时区名**，每 turn 注入；tz 来源 = **进程本地**（Electron server 跑用户机器 = client tz），不查 session）」；加 `[v0.0.64] time provider 精度修正` callout 段。
- `[P0]system_reminder.md §5`：加 `[v0.0.64] 设计澄清 — 「日期精度保 cache」是误置权衡` callout，澄清三层理由：① reminder 不进 system prompt（cache 是否保留与 reminder 内容精度无关）；② user message 段每 turn 失效（不管 reminder 日/分钟精度，cache 本来就 miss）；③ wire 层 cache_control breakpoint 落在最后非 reminder block（message 段历史 cache 由它管，正交）。结论：分钟级时间精度**无额外 cache 损失**，旧版约束是伪命题。
- `[P0]system_prompt.md §6`：删 timestamp「日期精度，避免每 turn 破缓存」段；改为「timestamp 不在本 spec 范围」+ 引用 system_reminder §5。
- `[P0]system_prompt.md §9`：第 1 条原「timestamp 用日期精度」改「~~已澄清为误置权衡~~」+ 引用 system_reminder §5。
- `[P0]extension point and implementations.md §3.6 + §5 manifest`：time impl description 从「系统时间（日期精度）」改「系统时间（含时分 + 时区名，[v0.0.64] 修正）」。
- 实现层（task）：
  - `app/plugins/builtins/rocky_context/reminder/time.ts`：用 `new Date()` 本地方法（getHours 等）格式化输出 `Current date and time: YYYY-MM-DD HH:MM (TZ)`，tz 来源单一为进程本地（`Intl.DateTimeFormat().resolvedOptions().timeZone`）。Rocky 是 Electron 本地 app，server 进程 tz = client tz，不需要 session.timezone 链路（那是 cron schedule 持久化 job.tz 的需求）。
  - `app/plugins/builtins/rocky_context/__tests__/reminder-providers.test.ts`：time case 改 regex 匹配 `Current date and time: YYYY-MM-DD HH:MM (TZ)` 格式。
- **撤销（同日重做）**：初版 P5 误加 `session.timezone` 写入链路（context-types.ts SessionConfig.timezone + session-store-types.ts CreateSessionInput.timezone + session-store.ts/createSession + session-deps.ts CreateSessionBody.timezone + session-config.ts sessionPersist.timezone + bootstrap/session-debug/session-compact 透传 + session.ts POST 落库 + chat-api.ts 前端注入 IANA tz）+ time.ts 用 `Intl.DateTimeFormat` 长 tz 链（config.timezone → squad.timezone → 进程本地）+ 非法 tz fallback。重做撤销全部：Electron 本地 app 不需要 session.timezone 链路（server 进程 tz = client tz），time.ts 直接 new Date() 本地方法即可。

## 2026-07-03 · v0.0.55（compact 接入 SessionTaskLock — subsumes summaryTask CAS）

- `[P0]context_compact_detail.md §2 顶部注记`：compact 流程的 `markSummaryRunning/Done/Failed` 改 `SessionTaskLock.acquire('compact')/markDone/markFailed`（subsumes v0.0.13 summaryTask 旁路 CAS）。
- `[P0]context_compact_detail.md §2b`：HTTP 端点 409 判定改读 `SessionTaskLock.getState(sid,'compact').status === 'running'`；双保险语义段落改写。
- `[P0]context_compact_detail.md §2c.4 + §6.4`：频率/迟滞段引用从 markSummaryRunning CAS 改 SessionTaskLock.acquire。
- 实现层（task）：`context-compact-runner.ts`（或 summary_do_compact impl）调 SessionTaskLock；`handlers/session-compact.ts` 409 判定改读 lock.getState。

详情：`specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`

## 2026-07-03 · v0.0.54.compaction（compact 409 简化 + subagent 放开 + prompt 回归 forked 不变量）

- **409 简化**：`POST /session/:id/compact` 唯一 409 = `compact_in_progress`（`summaryTask.status==='running'`）；删 `state==='running'/'interrupting' → 409` 两条 guard（forked agent 不碰 session.state/Run，与主对话 AgentLoop 在写 buffer 上正交——session.state 与 compact 正交）。双保险：接口层 summaryTask 检查 + 内部 `markSummaryRunning` CAS。
- **subagent 放开**：手动 compact 不再对 `session.type==='subagent'` 返 403（subagent 长跑上下文也会爆炸，必须 support compact）。
- **prompt 回归 directive（forked 不变量）**：`compact.md` 整删 `{{serialized_transcript}}` + `{{old_summary}}` 占位符；`CompactHandler.build()` 改 `return { content: this.readContent() }`（不再传 vars）；`context-compact-runner.ts` task message 改纯 directive；`serializeMessages` 函数已删（死代码）。
- 同步 `context_compact_detail.md`（§2b 409 简化 + §3.0/§3.2/§3.5 prompt 改纯 directive）+ `prompt_content_files.md`（§3.2/§4/§5/§7 compact.md 无占位符）+ `index.md`（④ 加原则 9 task=directive 不变量）。

详情：`specs/tech/version_logs/v0.0.54.compaction/change_log.md`

## 2026-07-03 · v0.0.51 实现完成（long term memory — context_post_compact EP + memory mapper impl）

- `context_post_compact` ordered EP + 默认 impl `memory_skill_consolidation`（`app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts`）落地：compact 成功完成（setSummary + appendMessages + markSummaryDone 之后）触发；handler fire-and-forget 启动 fork-2 整理 agent（不 await，不阻塞 tryCompact / agent loop）；fork-2 modeKey=`memory_extract` + maxIter=10 + allowed tools=`[skill_manage, memory_manage]` + 复用 session model + CompactCtx + ConsolidationHandler prompt 模板。
- `noop_post_compact` impl 落地：forked scope 显式选中防递归（与 reject_should_compact / noop_do_compact 同模式）。
- `memory_user` / `memory_session` system_prompt_mapper impl 落地（`app/plugins/builtins/rocky_context/prompt/memory.ts`）：从 no-op 占位升级为实际 impl；whole-file 整体注入 + managed-store 受管读取 + archived 跳过 + 空文件不贡献 fragment；memory_user priority=450 tier=stable（不被 budget_truncate 裁）/ memory_session priority=350 tier=context（超预算可裁尾部）。
- 验证：UT 4106 passed；post_compact AT 不可行（compact 触发黑盒难观测 + 需多轮对话撞 60% 阈值）→ UT 15 覆盖（runner wire + forked scope 防递归 + fire-and-forget 异常隔离）。
- `context_compact_detail.md §2d` 加「实现状态 v0.0.51 已实现」callout；index.md ① 实现状态 callout + frontmatter `updated`→2026-07-03。

详情：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`（§实现完成段）

## 2026-07-02 · v0.0.51（long term memory — post-compact handler ext point + memory mapper impl）

- `context_compact_detail.md`：新增 §2d post-compact handler ext point——`context_post_compact` ordered EP，compact 成功完成后触发（setSummary + appendMessages + markSummaryDone 之后）。默认 impl = `memory_skill_consolidation`（启动整理 fork-2，allowed tools = [skill_manage, memory_manage]）。forked scope 跳过此 handler 防递归（与 reject_should_compact 同模式）。PostCompactCtx 复用 CompactCtx。
- `extension point and implementations.md`：EP 清单从 8 → 9（新增 `context_post_compact` ordered EP）；impl 从 37 → 40（新增 §3.8：`memory_skill_consolidation` + `noop_post_compact`）；§3.4 memory mapper 从 no-op 占位（[D1.1]）改为实际 impl；§5 manifest 新增 post-compact 条目；§6 出处索引新增条目。
- `index.md`：① 核心概念表新增 post-compact handler；② 边界 EP/impl 计数更新（8→9 EP / 35→40 impl）；③ 对外协作点更新；⑤ 导航 context_compact_detail 描述更新（+§2d）。

详情：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`

## 2026-07-02 · v0.0.50（system_reminder_injector 停写消息级 metadata）

- `system_reminder_injector.ts` 停写消息级 `metadata.isSystemReminder`（块级 `TextBlock.isSystemReminder` 为唯一权威）；保留 `metadata` 字段本身（其他 kv 透传）。
- `[P0]system_reminder.md §4` 注入伪代码更新（删 metadata 写入分支）+ 设计决策段从「v0.0.39 双标记共存」改述为「v0.0.39 引入块级 → v0.0.50 唯一化」演进。
- forked-reminder-injector（v0.0.48 新增）漂移点证伪：`injectForkedReminder` 仅写 id/sessionId/role/content/sender，**从不写 metadata**——本版无需改动。
- 旧 transcript 数据（含消息级标记）被前端块级 filter 忽略，不迁移。

详情：`specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md`

## 2026-07-02 · v0.0.49（骨架直调 contextEngine + store_sink EP 化 + 并进 v0.0.52 base_builder 优化）

- **骨架直调 contextEngine**：删 ContextPort（MainContextPort / ForkedContextPort）中间层，骨架 `runReActLoop` 直调 `contextEngine.ingest/assemble(scopeId, buffer)`。修复 v0.0.40-0.0.48 ForkedContextPort 直接 `buffer.push()` 绕过 impl 链的死代码——forked ext impl（`buffer_sink`/`buffer_reader`/`append_passthrough`）首次被骨架真正激活。
- **D15 default sink EP 化（`store_sink` impl）**：新增 `app/plugins/builtins/rocky_context/ingest/store_sink.ts`（EP=`context_ingest_handler`，default 专属 sink，对齐 forked `buffer_sink`）；context-engine.ts 删 `if (scopeId !== FORKED) store.appendMessages` 硬尾（line 187-190）；`IngestCtx` 加 `store?: SessionStore` 字段（default 注入 wireStore / forked 不注入 / store_sink 读它）；default/forked sink 对称（chain 尾二选一，由 scope 配置选）。
- **Forked→forked 小写**：`forked-scope-bootstrap.ts` `FORKED_SCOPE_NAME='Forked'` → `'forked'`（与 scopeId 一致）。
- **并进 v0.0.52**：P0-1 assemble prevSnapshot（main 路径透传 `state.snapshot` → base_builder append 分支激活，prompt cache 命中）；P2-3 base_builder pickWindow ratio 动态化（ctx.ratio，与 computeContextWindowUsage 同源 store.getRatio，fallback 1.0）；P1-2 ingestAndAssemble helper 加 scopeId 参数。
- 同步 `context_engine.md`（§3 ingest/assemble 签名 + §3.5 链表 + §3.6 D1=B/D15 重写 + §4 交互图改骨架直调）+ `extension point and implementations.md`（37→38 impl + §3.1 加 store_sink + §5 manifest 示例 + scope 配置注）+ `context_ingest_detail.md`（§1/§2/§3/§5 sink 改 EP + handler 表加 store_sink/buffer_sink）+ `context_assemble_detail.md`（§2 P0-1 注 + §6 P2-3 注）+ `context_compact_detail.md`（§2c tryCompact 调用点改骨架统一调）+ `index.md`（④核心设计原则 + 概念表）。

详情：`specs/tech/version_logs/v0.0.49/change_log.md`

## 2026-07-01 · v0.0.40 修复（compact 2 exclusive EP 改用显式 dummy 实现替代 disable-唯一实现的 zero-active 态）

- **问题**：`context_should_compact` / `context_do_compact` 是 exclusive EP，UI（`component-ext-impl-radio`）radio 单选只有「选中」无「取消勾选」交互。forked scope 原靠 `ensureForkedScope` disable 唯一实现（threshold/summary）制造 **zero-active**——只能用 bootstrap 代码绕过 UI 语义强行造的中间态，UI 无法表达也无法恢复（exclusive 选中即不可逆）。
- **修复**：新增 2 个 dummy impl——`reject_should_compact`（谓词恒返 false）+ `noop_do_compact`（动作空操作），注册在 rocky_context manifest（compact EP 各从 1→2 impl，spec 计数 35→37）。`ensureForkedScope` 改为 `setExclusive('reject_should_compact','forked')` + `setExclusive('noop_do_compact','forked')`，替代原两行 `disableImplInForked`（其余 3 个 disable 不变）。
- **效果**：exclusive EP 在所有 scope 都「总有人被选中」。`getExtensionImpls('context_should_compact','forked')` 现返 `RejectShouldCompactPredicate`（check 恒 false）→ tryCompact 谓词检查处 return；防递归不变量行为等价（路径从「EP 返空兜底跳过」改为「reject 谓词返 false 短路」）。default scope 仍选 threshold/summary（注册序在 dummy 之前 → effective order 最小者胜）。
- 同步 `extension point and implementations.md`（计数 + §3.7 reject/noop 行 + manifest 示例 + scope 配置注）+ `context_compact_detail.md §2c.3`（防递归不变量改述 + 新增「为何用 dummy 而非 zero-active」设计段）。

## 2026-07-01 · v0.0.40 doc-sync（spec ↔ 已验证代码对齐）

- `context_engine.md §3` ingest/assemble 签名补 `buffer?` 显式入参（forked scope 透传给 buffer_sink/buffer_reader）；标注 forked 跳过 store 硬尾（`scopeId !== 'forked'` 才 appendMessages）+ 不写 session meta（不污染主对话 contextWindowUsage）+ 不读 store summary（buffer 自带完整上下文）。对齐实现 `context-engine.ts:171/200`。
- `extension point and implementations.md` 顶部 impl 计数订正：「27 通用基线 + 7 squad-scoped + 1 compact 动作」→「26 通用基线 + 2 compact + 7 squad-scoped」（= 35；原计数漏了 threshold_should_compact 谓词）。

## 2026-06-30 · v0.0.40（compact 触发 plugin 化 + 源/汇可注入）

- **compact 触发 plugin 化（D3）**：新增 2 个 **exclusive** context EP（首批 exclusive context EP，既有 6 个全是 ordered）：`context_should_compact`（谓词）+ `context_do_compact`（动作）。`tryCompact(ctx)` 固定胶水在 current ContextPort.recordAssistant：`if(await shouldCompact) await doCompact`。loop 骨架对 compact 零感知。
- **默认 impl**：`threshold_should_compact`（`(totalTokens+maxOutputTokens)/tokenLimit > 0.6`，分母含 maxOutputTokens，提前压而非撞墙压；configSchema `compactRatio` 默认 0.6）+ `summary_do_compact`（搬现状 forkedRun(summary) → setSummary 逻辑）。
- **防递归不变量**：forked scope 不激活 shouldCompact EP（exclusive 无 active impl）→ summary run 结构上不可能 compact。
- **源/汇可注入（D1=B）**：`ContextEngine.ingest/assemble` 加 `scopeId` 入参，透传到 `getExtensionImpls(point, scopeId)` 双参重载（现恒单参 default）。新增 3 个 forked 专属 impl：`buffer_reader`(mapper) / `append_passthrough`(reducer 不 rebuild 保 cache) / `buffer_sink`(ingest 尾写 buffer)。default scope disable 它们。
- `extension point and implementations.md`：6 EP → 8 EP；33 impl → 35 impl；新增 §3.7（compact EP impl）+ §4.6（threshold configSchema）+ manifest `compact/` 子目录。
- `context_compact_detail.md`：新增 §2c（tryCompact 胶水 + shouldCompact/doCompact EP 契约 + CompactCtx + 防递归不变量 + 频率/迟滞 known tuning 点 + 与 §1 历史算式的关系）。
- `context_engine.md`：§3 ingest/assemble 签名加 scopeId；§3.5 注 compact plugin 化；新增 §3.6（源/汇可注入 + scopeId 透传 + 3 forked impl + buffer 透传）；§4 交互图加 tryCompact 调用点。
- `index.md`：① 是什么 / ② 边界 / ④ 核心设计原则（10 条，新增 compact plugin 化 + 源/汇可注入）/ ⑤ 导航 全面对齐 v0.0.40 形态。

## 2026-06-30 · v0.0.39

- `system_reminder_injector.ts` 生成 reminder block 时设 `isSystemReminder=true`（块级，`TextBlock.isSystemReminder`）+ 保留 `metadata.isSystemReminder=true`（消息级，兼容旧路径）**双标记共存**。
- 前端 `DEFAULT_BLOCK_FILTER`（`message-flatten.ts`）按块级标记过滤不渲染该 text block；不动 transcript 数据、不动 LLM 入参（reminder 仍透明发 LLM，system prompt cache 不破坏）。
- `[P0]system_reminder.md` §4 补 injector 双标记伪代码 + 设计决策段（块级 vs 消息级两难 + LLM 零侵入论证）。

详情：`specs/tech/version_logs/v0.0.39/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`；`overview.md` 内容按类拆流并入 index 后归档 `soft_deleted/`。
- 全部 10 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理版本噪声：顶部 `> version: X.Y` blockquote + `[vX.Y 当前形态]`/`[vX.Y 当前实现]` inline 标签去版本号（保留「当前形态」语义）；`[v0.0.8 实现基线（历史）]` 段落标注为「历史基线」（详细差异见 `version_logs/v0.0.8/`）；移除尾部 `## N. 版本` 段（迁移到本 log）。
- `system_reminder.md` §7 订正：squad 场景的 `reachable_agents` provider（v0.0.33.2 新增）从版本段提取为正文 squad 场景注记，指向 `../../squad/[P1]prompt_sections.md`（本 spec §3 provider 清单为非 squad 通用基线 5 个）。

## 2026-06-25 · v0.0.22（prompt 正文文件化）

- 新增 `prompt_content_files.md`：prompt 正文文件读取层（`PromptHandler` 抽象基类 + 7 派生 handler + 6 content 文件）；mapper/reducer EP 之下的内容源，不引入新 EP、不改 mapper/reducer 契约。
- `system_prompt.md` v0.6：§4 内置 mapper 内容来源更新——identity/rules 从代码常量改为 `prompts/content/*.md`（经 PromptHandler 读取）。
- `context_compact_detail.md` v3.2：压缩 prompt 改 CC 口径（NO_TOOLS preamble + trailer + 9 板块 + `<analysis>`/`<summary>` 双 block + identifier 保留）；模板 `compact.md` 经 `CompactHandler` 读取。

详情：`specs/tech/version_logs/v0.0.22/change_log.md`

## 2026-06-22 · v0.0.13（全面 plugin 化）

- ContextEngine plugin 化完成：构造注入 `PluginManager`，ingest/assemble/system_prompt/system_reminder 由 `getExtensionImpls(point)` 驱动跑 ordered 链。
- 新增 `extension point and implementations.md`：6 context EP + 26 rocky_context builtin impl 整合索引 + 5 impl 显式 configSchema + manifest 结构。
- `context_engine.md` v2：§3.5 补「ContextEngine 如何调框架」（runOrderedChain 统一模式 + 四执行点接线表）。
- `context_ingest_detail.md` / `context_assemble_detail.md` v2：ordered chain + truncate offload + base_builder 增量 cache 为 current。
- `system_prompt.md` v0.4：mapper/reducer 双 EP 由 PluginManager 驱动；3 reducer impl（tier_sort/dedup/budget_truncate）+ 6 mapper impl 归 `rocky_context`。
- `system_reminder.md` v1.1：5 provider 归 `rocky_context` plugin。
- v0.0.8 简化基线（append-only ingest / head3+tail3 / ratio 1.0 / 裸 call compact）下沉为 builtin impl 默认 config 兜底（design [D1.2]）。

详情：`specs/tech/version_logs/v0.0.13/change_log.md`

## 2026-06-22 · v0.0.18（impl 排序改 effective order）

- `ExtImpl.priority` 字段删除，改 `ExtImplPolicyData.order`（per-point 连续 1..n，无 record 时按 manifest 登记序末尾补位）；manifest 不再有 `priority` 字段，26 impl 加 `description`。

## 2026-06-22 · v0.0.16（cacheRate + compact 手动触发 + system 注入路径）

- `context_usage_detail.md` v3.1：cache 字段语义统一为「比率」（`cacheRate = cache_read_tokens / input_total_tokens`）。
- `context_compact_detail.md` v3.1：手动触发路径（POST /session/:id/compact）+ compact 成功后 transcript 插 role=system message 留痕；触发算式对齐 `remainingTokens = tokenLimit − totalTokens − maxOutputTokens`。
- `context_snapshot_interface.md` v1.2：system 注入路径对齐实现——system 以 `messages[0]` role=system 形式随 `snapshot.messages` 发，**不另走 CanonicalRequest.system**（v0.0.13 旧表述废弃）。

## 2026-06-22 · v0.0.17（workspace provider 接线）

- `system_reminder.md`：workspace provider 实现不变（仍读 `config.workdir`），loop 构造 SessionConfig 时 `workdir = session.workspaceDir`（新增持久化字段，见 `../session/[P0]session_workspace.md`）。

## 2026-06-19 · v0.0.8（实现基线，已下沉）

- ContextEngine 三接口简化版落地：`ingest` 仅 append、`assemble` 单 mapper 读全 transcript（head3+tail3）、`compact` 裸 `client.call`。
- ratio 常数 1.0；不累计 usage（保留方法签名）。
- 上述简化在 v0.0.13 下沉为 builtin impl 默认 config 兜底。

详情：`specs/tech/version_logs/v0.0.8/change_log.md`
