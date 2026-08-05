# v0.0.256 change_plan — clean_view 新增 text 冒泡 reducer 修 tool_use 乱序 400

> 纯技术修复（跳过 PRD）。需求：`reqs/[working] v0.0.256/req.md`。根因链见 `states/v0.0.256/context.md`。
> prod 实证（256.log message `01KZ6AK4K9GZWB88QGBPCK5JXH`）：assistant content = `[text, tool_call(KlF,{_raw}), text, tool_call(feNX)]`，两条 tc 均配对（下条 tool message 双 result）→ orphan 全保留、邻接合法，但 deepseek anthropic-compatible 要求 tool_use 后块级紧跟 tool_result，text 夹中间即 400。

## 架构拍板（开放点 1-5）

1. **reasoning 也参与重排**：三段稳定分区 `[reasoning…] → [text…] → [其余(含 tool_call)…]`，桶内各保原相对顺序。依据 `protocol-encode-helpers.ts encodeContentBlock`：reasoning→wire `thinking` 保序透传，Anthropic 要求 thinking 在 assistant content 最前。default 链里 think_remove 随后会删 reasoning，三段分区是「think_remove 缺席的 scope」下的正确兜底，成本与两段相同（单遍分桶）。
2. **不合并 text block**（多段保原相对顺序，合并涉及拼接分隔符语义，wire 多 text 合法）；**丢弃 trim 后空的 text block**（Anthropic 对空 text 400；fill_empty_text 只兜 user/tool，assistant 空 text 无人兜；丢弃后 message 变空由 empty_message 兜底）。
3. **只处理 role==='assistant'**：tool/user/system message 原样透传。tool 消息内 block 顺序无 provider 约束证据，message 级邻接归 orphan。
4. **命名 `bubble_text_before_tool_call`**；order = default.yaml 数组序第 4 位（orphan_tool_call 后、think_remove 前）。生效序：dedup(1)→snip(2)→orphan(3)→**bubble(4)**→think_remove(5)→fill_empty(6)→empty_message(7)→role_merge(8)。
5. **attempt_loop 治本（hasUnfinishedToolUse 漏判 `{_raw}` object）不纳入本版本**，留 follow-up req。理由：用户倾向简单；本 reducer 是确定性视图层保证，对历史污染 + 未来任何乱序源兜底，单独即可消除 400；attempt_loop 修法改变 stall partial 保留语义（重试/失败路径变化）需独立验证；且 log 实证半截 KlF 已被 executor 执行（invalid_input），治本链不止一处，值得独立版本。

## 范围外（明确不做）

- `app/server/src/llm/caller/attempt_loop.ts hasUnfinishedToolUse`（L274-278）→ follow-up req。
- spec §5b/§3.10 表加第 8 项 → doc-modifier 阶段 5 统一同步。
- 其它 scope yaml（summary/consolidate/*.parent.*）：均无自有 `context_clean_view_reducer` 链（已 grep 核实，per-EP 继承 default），勿改。

## 变更行（method 级契约）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---|---|---|---|---|---|---|
| context_engine | app/plugins/builtins/rocky_context/assemble/bubble_text_before_tool_call.ts | `BubbleTextBeforeToolCallReducer`（class，default export） | 新增 | clean_view reducer 类，`extends ContextImplBase implements AssembleReducer`；构造器签名 `(implId: string, cfg: Record<string, unknown> = {})` 调 `super(implId, cfg)`，与 orphan_tool_call 同构 | MUST 与 plugin.json 登记 + default.yaml 激活三件套同时落地；文件 ≤300 行 | `assemble/orphan_tool_call.ts` 样板；spec §5b | +20 |
| context_engine | 同上 | `reduce(data, input, ctx)` | 新增 | `input===null → []`；遍历 messages：非 assistant → 原样透传；assistant → content 单遍分三桶 `[reasoning][text][其余]` 拼接，丢弃 `type==='text' && text.trim()===''` 的 block；分区结果与原序一致且无丢弃 → 可返原 message 引用（省分配） | MUST NOT mutate input（变更时返新 message 对象 + 新 content 数组）；MUST 保 tool_call 相对顺序；MUST NOT 合并 text block；MUST NOT 自行删 message（全丢空交 empty_message）；MUST NOT 触碰 user/tool/system | spec §3 AssembleReducer 契约；§5b empty_message 职责；拍板 1-3 | +65 |
| context_engine | app/plugins/builtins/rocky_context/plugin.json | impls[] 新条目 `bubble_text_before_tool_call` | 修改 | `context_clean_view_reducer` point 下登记：`implId=bubble_text_before_tool_call`、`point=context_clean_view_reducer`、`impl=./assemble/bubble_text_before_tool_call.ts`、`description=__MSG_plugin.builtin.rocky_context.impl.bubble_text_before_tool_call.description__`；条目放 orphan_tool_call 条目后 | MUST 与 default.yaml 激活同时落地（缺一 runtime 静默不注入）；impl 路径带 `.ts` 后缀对齐现有条目 | plugin.json L256-261 orphan 条目格式；context.md findings 注册两步 | +6 |
| context_engine | app/plugins/scopes/default.yaml | `context_clean_view_reducer.impls` 列表 | 修改 | 第 4 位插入 `- bubble_text_before_tool_call`（`- orphan_tool_call` 后、`- think_remove` 前），附一行注释（orphan 先配对过滤+邻接，bubble 再处理配对齐全但 block 乱序） | MUST 紧跟 orphan_tool_call；插入后 think_remove 仍在 empty_message 前（§5b 顺序依赖不破） | context.md §clean_view 链顺序；spec §5b 顺序依赖段 | +2 |
| ui-i18n | app/web/src/i18n/locales/zh-CN/plugin-config.json | `plugin.builtin.rocky_context.impl.bubble_text_before_tool_call.description` | 新增 | 中文描述（clean_view reducer：assistant 的 text 块冒泡到 tool_call 之前，修 provider 400），嵌套位置对齐 L143 orphan_tool_call 条目 | MUST 双语齐备（缺 key 渲染【资源X不存在】，parseMissingKeyHandler 覆盖 defaultValue） | memory i18n-key-add-checklist；zh-CN/plugin-config.json L143 | +1 |
| ui-i18n | app/web/src/i18n/locales/en/plugin-config.json | 同上 key | 新增 | 英文描述（Bubble assistant text blocks before tool_call blocks in clean view, fixing provider 400） | 同上 | en/plugin-config.json L143 | +1 |
| context_engine(test) | app/plugins/builtins/rocky_context/__tests__/bubble-text-before-tool-call.test.ts | 全文件 | 新增 | UT 9 点：① text 冒泡到所有 tool_call 前 ② 多 tool_call 相对顺序不变 ③ 无 tool_call 不动 ④ text 已在最前不动（返原引用）⑤ 空/纯空白 text 丢弃 ⑥ reasoning 保持最前 ⑦ 非 assistant message 不动 ⑧ 不可变（input 引用与内容不变）+ `input===null→[]` ⑨ prod 实证形状 `[text,tc(_raw),text,tc]` 经 orphan+bubble 串行后 text 全部在 tc 前 | vitest；fake config/emptyData/造假 message 模式对齐 `__tests__/dedup-tool-result.test.ts`；禁硬编码绝对路径 | req §验收；拍板 1-3 | +160 |
| plugin-system(test) | app/server/src/plugin/__tests__/scope-config-loader.test.ts | 用例「default.yaml 固化 ordered EP order」 | 修改 | 标题「7 项」→「8 项」；新增 `bubble_text_before_tool_call` order=4 断言；think_remove 4→5、fill_empty_text 5→6、empty_message 6→7、role_merge 7→8 | MUST 与 default.yaml 实际序一致（守门测试，漏改即红） | scope-config-loader.test.ts L77-89；memory coder-shared-structure-selfcheck-fulltest | +3/-2 |
| plugin-system(test) | app/server/src/plugin/__tests__/migration-equivalence.test.ts | 用例「ordered EP 返全量 active」 | 修改 | clean_view 期望 implId 数组 7→8 项，index 3 插入 `'bubble_text_before_tool_call'`；标题「7 项」→「8 项」 | 同上 | migration-equivalence.test.ts L83-91 | +2/-2 |

## 验证口径

- `bun run typecheck` 绿（注意：app/plugins 不在 root tsconfig references，plugin 代码靠 UT 守）。
- 全量 `bun run test` 绿（改 scope yaml order + plugin manifest，按 memory 铁律必须全量，非只跑新文件）。
- UT ⑨ 直接复刻 prod 256.log 乱序形状，验证 orphan+bubble 串行后块序合法。
