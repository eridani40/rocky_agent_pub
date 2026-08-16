---
type: research
title: rocky 架构升级方案（借 dsh 四大架构优势）
priority: P0
status: active
updated: 2026-08-14
source: rocky_agent/app/server/src/agent/context-engine.ts + assemble-pipeline.ts + context-ingest-pipeline.ts + context-compact-runner.ts + context-usage-calc.ts + system-prompt-builder.ts + clean-view-pipeline.ts + app/plugins/builtins/rocky_context/assemble/base_builder.ts + side_run_builder.ts + compact/threshold_should_compact.ts + summary_do_compact.ts + reminder/time.ts + ingest/system_reminder_injector.ts + app/plugins/builtins/llm_anthropic/protocol-encode-helpers.ts + app/plugins/scopes/*.yaml + specs/tech/agent/context/[P0]extension point and implementations.md + deepseek-harness 侧（context-compare-dsh-better-2026-08-14.md 强项清单）
related: [./context-compare-dsh-better-2026-08-14.md, ./cache-compare-rocky-vs-harness-2026-08-14.md]
---

# rocky 架构升级方案（借 dsh 四大架构优势）

> 上游：老板 11:38 战略决策「并行 + rocky 全面升级」——把 dsh 的 context 架构四大优势移植进 rocky。
> 调研日期：2026-08-14 · 范围：**方案设计（只读 rocky 代码，不修改）**；确认后走 rocky 自己的版本流程（states/task-board 双轨）执行。
> 当前 rocky 版本：v0.0.346。

## §0 一句话结论

**rocky 的 context 架构已经高度 EP 化（11 EP + 57 impl），四大优势里有三个是「增量演进」而非「推倒重来」：①可重建性 = 给 assemble 加「输入可记录 + 纯函数投影」层（base_builder 已是确定性纯函数，缺的是记录/重建入口）②运行时增量 = 给 base_builder 加「基于 transcript 尾部新增的纯函数增量缓存」（**严禁回到 v0.0.173 删掉的 append 分支**，那是乱序 400 的根因）③compaction 前缀对齐 = 让 compact 的 forked buffer 与 main 请求前缀一致（rocky 已有 [system, ...snapshot.messages, directive] 结构，但 side_run_builder 与 base_builder 输出可能不一致）。唯一需要新机制的是 scope 运行时注册继承（rocky 已有配置级 extends 链，缺运行时注册继承）。分期 4 期，P1-P2 低风险高收益，P3-P4 中高风险。**

---

## §1 dsh 四大优势 → rocky 影响面映射

| # | dsh 优势 | rocky 现有对应机制 | 差距 | 影响模块 |
|---|---|---|---|---|
| ① | **可重建性**（model-visible means logged：deriveEventMessage 纯函数 + event-sourced log + surface） | base_builder 已是确定性纯函数 f(summary, transcript)（v0.0.173）；但 snapshot 是「组装产物」，**无「从 log 重建任意请求」的一等公民入口**；session-store 是消息级持久化（非事件日志） | 缺「assemble 输入（summary+transcript 快照）可记录 + 纯函数投影可重建」层 | session-store（加输入快照/事件日志）、assemble-pipeline（加投影纯函数导出）、context-engine（加重建入口） |
| ② | **运行时增量投影**（RuntimeContextProjection 只投影变化 + deriveMessages O(new) 增量缓存 + agent-instructions 只投变更） | base_builder 永远 rebuild（O(all)）；reminder 每轮注入（time provider new Date() 每轮变）；wire 层过滤历史 reminder | 缺「增量缓存」（deriveMessages 式 derived 数组 + derivedNodes 游标）；reminder 每轮注入 vs 变化才注入 | base_builder（加纯函数增量缓存）、context-ingest-pipeline（reminder 收敛） |
| ③ | **scope 运行时链继承**（scopeParents + scopeChainOf + ScopedLayers 注册继承 DOWN / 事件准入 UP） | scope yaml 配置级覆写 + extends 链（default.yaml extends 等）；getExtensionImpls(point, scopeId) 按 scope 解析 + per-EP 回退 | 缺「运行时注册继承」（插件动态注册 context 时按 scope 继承祖先注册） | plugin-manager（注册 API 加 scope 语义）、extension-point（注册继承规则） |
| ④ | **compaction 闭环 + KV cache 前缀复用**（token-meter pressureTokens 驱动 + summarizer 指令作为最后 user message = 上次请求真前缀 + shadow 感知） | compact 走 forked sideRun（[system, ...snapshot.messages, reminder, directive] 结构已有）；threshold_should_compact 谓词（totalTokens/tokenLimit > 0.6）；bakeSummaryBlock 烘焙 | ①forked buffer 用 side_run_builder 组装，与 main base_builder rebuild 输出**前缀可能不一致** → KV cache 不一定复用 ②无 token-meter 压力驱动闭环（char×ratio 估算）③无 shadow 感知 | context-compact-runner（前缀对齐）、side_run_builder（与 base_builder 输出对齐）、context-usage-calc（压力驱动） |

---

## §2 分期方案（4 期）

### P1：compaction 前缀对齐 + KV cache 复用（低风险高收益）

**改什么**：
1. `side_run_builder.ts`：与 `base_builder.ts` 的输出**前缀逐字节对齐**——side_run_builder 复用 parentSnapshot.messages 时，必须与 main 请求的 messages 完全一致（当前 side_run_builder 是「parent.messages + summaryUpTo 后 in_memory 增量 upsert」，增量部分可能与 main 的 rebuild 输出不一致）。**建议**：compact 的 forked buffer 直接复用 main 最近一次 assemble 的 `state.snapshot.messages`（不做增量 upsert），保证前缀与 main 请求一致 → KV cache 命中
2. `context-compact-runner.ts`：compact taskMessage（directive）作为最后一条 user message（已有结构），显式保证「重放的对话 + 指令」= 上次路由请求的**真前缀**（dsh summarizer.ts 的核心设计）
3. `context-usage-calc.ts`：加「compact 前后 cache 对比」可观测（compact 后下一轮 assemble 的 input_cache_read 是否提升）

**收益**：compact 触发后，下一轮 main 请求复用 compact forked 请求的 KV cache 前缀（省一次全量重算）；长 session 下 compact 频繁时累计显著
**风险**：低——不改 EP 契约，只改 side_run_builder 输出对齐 + compact-runner 组装
**验证**：AT/ET 跑「长对话触发 compact → 对比 compact forked 请求与下一轮 main 请求的 messages 前缀（wire bytes 一致率）+ input_cache_read 提升」

**可验收标准**：
- [ ] compact forked 请求的 messages 前缀与 main 最近请求**逐字节一致**（对比工具：wire serialize 后 diff）
- [ ] compact 后下一轮 assemble 的 input_cache_read 提升可观测（usage 面板可见）
- [ ] 既有 compact UT 全绿（context-compact-runner 相关）

### P2：assemble 纯函数增量缓存（中风险）

**改什么**：
1. `base_builder.ts`：加「增量缓存」——缓存 rebuild 结果（derived 数组 + 已处理 transcript 尾部游标），**每轮只处理 transcript 尾部新增**（O(new)）；transcript 非尾部变更（HITL 编辑）/ summary version 变 → 全量重建（对应 dsh deriveMessages 的 `replaceGeneration` 失效语义）
2. **红线（v0.0.173 教训）**：增量**绝不基于 prevSnapshot 追加**（那是乱序 400 根因），只基于「transcript 尾部新增」的纯函数增量；`structuredClone` 深拷贝保 snapshot 不被 mutate；clean view 仍在 getCleanSnapshot 深克隆副本上跑
3. `assemble-pipeline.ts`：增量缓存注入（transcript_reader 返回尾部增量 + base_builder 缓存游标）

**收益**：长 session（1000+ 消息）下 assemble 从 O(all) 降到 O(new)；每轮组装更快
**风险**：中——v0.0.173 删 append 分支的教训是「增量基于被污染 prevSnapshot 会乱序」；本方案增量基于**纯函数缓存 + transcript 尾部**，语义不同；但需**完整回归**（v0.0.173 乱序 UT 必须全绿）
**验证**：UT（增量缓存正确性 + 乱序回归）+ ET（长 session 组装性能对比）

**可验收标准**：
- [ ] 1000+ 消息 session 下 assemble 耗时 O(new)（对比 O(all) 基线，性能提升可测）
- [ ] v0.0.173 乱序 400 的 UT 全绿（增量不引入乱序）
- [ ] snapshot.messages 与 rebuild 输出**字节一致**（增量缓存不改变输出，只加速）

### P3：runtime context 只投影变化 + 可重建性层（中高风险）

**改什么**：
1. **reminder 收敛**（`context-ingest-pipeline.ts` + `system_reminder_injector.ts`）：reminder 每轮注入改为「**变化才注入**」——time/env/workspace 等 provider 输出与上轮相同时不注入（对应 dsh RuntimeContextProjection `retained?.text === snapshot` 跳过）；变化时注入一条（放 wire 尾部，已有 bp#2 保护）
   - **注意**：这与 rocky 现有「reminder 每轮注入保 LLM 实时感知」冲突——建议**默认关**（config flag `reminderProjection: 'change' | 'always'`，默认 always 保现状，验证后切 change）
2. **可重建性层**（`session-store` + `assemble-pipeline`）：
   - 轻量版：assemble 时记录「输入快照」（summary.version + transcript 尾部游标 + 输入 hash），存 session meta；提供 `rebuildSnapshot(sessionId, version)` 纯函数入口，从持久化重建任意版本请求
   - 完整版（可选）：session-store 加事件日志（append-only event log + deriveEventMessage 纯函数投影），对齐 dsh event-sourced 架构
3. **agent-instructions 增量投影**（rocky 无对应包，opt-in）：若老板要，新建「指令文件变更投影」插件（fs tool touch 触发，只投变更）

**收益**：reminder 变化才注入 → 当轮消息前缀更稳 + token 更省（dsh 的「零变化零成本」）；可重建性 → ET/AT 可从持久化重建「模型看到的输入」做 oracle 验证（dsh 最独特架构红利）
**风险**：中高——reminder 收敛改变 LLM 实时感知（默认关保现状）；事件日志是存储层大改（建议轻量版先行）
**验证**：UT（投影规则）+ ET（reminder 注入频率对比 + 从持久化重建请求 demo）

**可验收标准**：
- [ ] reminder 变化才注入（同值轮次零注入），注入频率可观测下降
- [ ] `rebuildSnapshot(sessionId, version)` 可从持久化重建任意请求（ET demo：回放历史请求，messages 一致）
- [ ] 默认 `reminderProjection='always'` 保现状（零行为变化），flag 切换后 UT 全绿

### P4：scope 运行时注册继承（高风险，可选）

**改什么**：
1. `plugin-manager` 注册 API 加 scope 语义：ext impl 注册时可声明 `scope`（注册到某 scope 及其子孙）；`getExtensionImpls(point, scopeId)` 按**运行时链**解析（scope 子孙继承祖先注册，对应 dsh ScopedLayers 注册继承 DOWN / 事件准入 UP）
2. `extension-point` 加注册继承规则：有序链按 scope 链合并（child scope 看到 ancestors 的 impl + 自己 scope 的覆写）
3. 与现有 scope yaml 配置（extends 链）**兼容共存**：yaml 是「配置级覆写」，运行时注册是「注册级继承」，两层叠加（yaml 优先级更高）

**收益**：子 agent（subagent/forked）动态注册的 context 天然继承父 scope；多 agent 场景扩展成本降低（dsh scope 链的红利）
**风险**：高——改 plugin-manager 注册语义，影响所有 EP 的 scope 解析（57 impl 都可能受影响）；必须完整回归
**验证**：UT（scope 链解析矩阵）+ ET（subagent 继承父 context 注册）

**可验收标准**：
- [ ] 子 scope 注册的 impl 在父 scope 可见（注册继承 DOWN），父 scope 事件不入子 scope（事件准入 UP）
- [ ] 现有 57 impl 的 scope yaml 配置行为不变（兼容回归全绿）
- [ ] subagent ET：动态注册 context 被父 agent 继承

---

## §3 风险与兼容（43/57 impl 会不会被破坏）

**核心原则：EP 契约不变，新增能力走「新增 impl / 新增 EP / 配置开关」，不修改既有 impl 契约。**

| 风险 | 分析 | 缓解 |
|---|---|---|
| **43 impl 破坏** | 四个优势的移植都**不改 EP 契约**（context_ingest_handler / assemble_mapper / assemble_reducer / clean_view_reducer / system_prompt_mapper/reducer / system_reminder / should/do_compact / post_compact / session_store 签名不变）；只改 impl 内部（base_builder 加缓存）或新增 impl（增量 builder / 投影插件） | 新增 impl 与既有 impl 同 EP 共存（scope yaml 切换激活）；旧 impl 保留作 fallback |
| **v0.0.173 乱序 400 复发** | P2 增量缓存若基于 prevSnapshot 追加会复发；**红线：增量只基于 transcript 尾部新增 + 纯函数缓存**，绝不 append 分支 | 完整回归 v0.0.173 乱序 UT；增量缓存输出与 rebuild 字节一致校验 |
| **EP 体系演进** | 新能力优先「新增 impl」（同 EP）+「新增 EP」（如 `context_projection_reducer` 投影链）+「配置 flag」（reminderProjection） | 新增 EP 走既有流程（extension-point.ts BUILTIN_EXTENSION_POINTS + scope yaml + manifest）；不删旧 EP |
| **scope 解析回归** | P4 改注册语义影响所有 EP 的 scope 解析 | 与 yaml extends 兼容共存（yaml 优先级更高）；scope 解析矩阵 UT 全绿 |
| **存储层兼容** | P3 事件日志若替换现有 transcript 存储有迁移风险 | 轻量版（输入快照）不碰存储；完整版（事件日志）**并行写入**（新表，不替换现有 messages 表），验证后切换 |
| **老板项目生产稳定性** | rocky 是生产项目（0.0.346），改动走版本流程 | 每期独立版本号 + states/task-board 双轨 + verify 三层（UT/AT/ET）；P1-P2 先行（低风险高收益） |

---

## §4 执行建议（走 rocky 版本流程）

1. **版本规划**：每期一个版本（如 v0.0.347=P1 / v0.0.348=P2 / v0.0.349=P3 / v0.0.350=P4），独立 change_plan + task.json + task-board.md + verify
2. **顺序**：P1（低风险高收益）→ P2（增量缓存，回归重点）→ P3（reminder 收敛 + 可重建性，默认关保现状）→ P4（scope 继承，高风险最后）
3. **每期验收**：§2 各期可验收标准 + rocky 三层验证（UT 必须 / 改后端逻辑默认 AT / UI 改动 ET）
4. **回滚**：每期独立版本，验证不过可回滚该版本（不污染前一期）

---

## §5 证据清单（rocky 侧代码）

- `context-engine.ts`：ingest:179 / assemble:217（base_builder 永远 rebuild + systemText 复用规则 + forked 无条件复用父 system）/ getCleanSnapshot:336（structuredClone + clean view）/ compact 薄壳
- `assemble-pipeline.ts`：runAssemblePipeline:91（mapper deepMerge + reducer 链式）/ pickFallback:141（v0.0.8 head3+tail3）
- `context-ingest-pipeline.ts`：runReminderProviders:76（reminder provider 链）/ applyIngestPipeline:124（handler 链 + store_sink）
- `context-compact-runner.ts`：runCompact:85（SessionTaskLock CAS → sideRunner → bakeSummaryBlock → setSummary）/ compact prompt 纯 directive（v0.0.54，不复述 snapshot.messages）
- `base_builder.ts`：reduce:67（永远 rebuild）/ buildRebuild:86（无 summary → [...transcript]；有 summary → [summaryMsg(烘焙 block), ...recent]）
- `side_run_builder.ts`：reduce:53（复用固定 parentSnapshot.messages + summaryUpTo 后 in_memory 增量 upsert）
- `system-prompt-builder.ts`：buildSystemPrompt:63（mapper 链空 → throw 硬失败）
- `threshold_should_compact.ts`：check:43（totalTokens/tokenLimit > 0.6）
- `time.ts`：provide:47（new Date() 每轮注入，含时分+时区）
- `system_reminder_injector.ts`：handle:52（user/tool/a2a 触发，assistant 不触发）
- `protocol-encode-helpers.ts`：wire 层 reminder 过滤（非最末 drop / 最末保留最后一个）+ injectLastNonReminderCacheControl（bp#2 跳过 reminder）
- `extension-point.ts`：11 context EP（8 ordered + 3 exclusive）+ BUILTIN_EXTENSION_POINTS 注册
- `[P0]extension point and implementations.md`：11 EP + 57 impl（31 通用基线 + 4 compact + 2 post-compact + 2 session_store + 1 side_run_builder + 1 search 旁路 + 15 scoped）
- `app/plugins/scopes/*.yaml`：scope yaml 配置级覆写 + extends 链（default.yaml / summary.yaml / consolidate.yaml）
- `session-store-*.ts`：appendMessages/getMessages/getSummary/setSummary/getRatio（消息级持久化，非事件日志）
