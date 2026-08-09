# system_reminder 保留/清理逻辑 + cache control 设计讨论记录（v0.0.274）

> 来源：leader 与老板 2026-08-06/07 讨论（reminder 注入条件 + 保留逻辑 + cache 配合 + 密度分级）。
> 目的：把讨论中达成的设计共识落到文字，与 spec 现状比对，作为 274 及未来 protocol 扩展的决策依据。

## 一、核心机制（注入 + 清理两层，与 spec 一致）

system_reminder 的处理跨**两层**，职责正交：

### 1. context 层（ingest，持久化）
- `system_reminder_injector` handler 在 ingest 时把 reminder 聚合块加到 message content 末尾，**落库持久化**进 transcript
- transcript 完整保留所有历史 reminder（数据不丢）
- spec：`context/[P0]system_reminder.md §4`

### 2. protocol 层（encode，wire 一次性产物）
- canonical → wire 时过滤历史 reminder + 注入 cache breakpoint
- wire 每轮重新生成，不写回 transcript
- spec：`providers_and_models/[P0]cache_control.md §3`

**两层独立的意义**：transcript 永远完整（回放/审计/隐式缓存 fallback 可用）；wire 只发必要内容（cache 命中率 + token 节省）；一层改动不破另一层。

## 二、reminder 保留/清理规则（encode 层，wire）

发送给 LLM 时，按「是否最末 message」分支：

- **非最末 message**：drop 所有 `isSystemReminder=true` block（历史 reminder 不进 wire）
- **最末 message**：drop 除**最后一个 reminder block** 之外的所有 reminder（保留当轮 reminder 发给 LLM）

**效果**：LLM 每轮只见最末一个聚合 reminder 块（不堆积）；历史 reminder 在 wire 层被清理，但 transcript 持久化保留。

**口径修正（2026-07-22）**：从「最末 user message」改为「最末 message」（role 不限）。动机：tool 密集 loop 里旧口径把 reminder 钉死在历史深处 user 消息上，新 user/a2a 到达时旧位置 reminder retroactive drop → 隐式 prompt cache 整段崩（prod trace 实证 cache 命中率 0.2%）。新口径保留/drop 只发生在尾部，前缀损失≈零。

## 三、cache control 配合（Anthropic 显式 breakpoint）

cache_control 是 **Anthropic Messages API 特有 wire 字段**，两个 breakpoint：

- **bp#1**：system prompt 末 content block（身份/规则/工具/skills——跨 turn 极稳）
- **bp#2**：最后一个**非 reminder** 的 content block（从 wire messages 末尾向前扫，命中第一个 `isSystemReminder !== true` 的 block）

**bp#2 关键**：breakpoint 必须落在 reminder **之前**的稳定段——若落在 reminder 上，下轮该 reminder 内容变 → cache miss。搜索规则跳过 reminder block，落在 user 正文 / tool_result / assistant 回复（业务对话最末稳定内容）。

**效果**：稳定段（bp#1+bp#2 之前）跨 turn 命中 cache；动态段（bp#2 之后的当轮 reminder）每轮变但不破前缀 cache。

## 四、注入触发条件（274 改动点）

### 现状（spec §4）
`system_reminder_injector` 只看 ingest 最后一条 message，**必须 `role==='user'`** 否则不动——即**只在 user message 注入，tool_result 不注入**。

### 问题（老板发现）
一个 run 跑起来后，后续 iteration 的消息是 tool_result（不是 user）→ **缺失 reminder**（环境/时间/团队状态等上下文 LLM 看不见）。

### 274 决策（老板拍板）
**每一轮消息分 3 类**：
1. **user**（真用户 / a2a）→ 加 reminder
2. **assistant**（agent 自己输出）→ 不加
3. **tool_result**（工具返回）→ 加 reminder

即 **给 user 和 tool_result 都加，assistant 不加**。判定放宽为 `role==='user' || role==='tool' || sender?.source==='agent'`。

依据：Anthropic wire 层 tool→user 映射（tool_result 属于 user 侧），与 user/assistant 交替结构自洽。

## 五、cache 密度分级（cache_control 能力分组）—— 讨论核心想法

老板的关键洞察：**reminder 密度策略应按 protocol 的 cache_control 能力分级**。

### 支持 cache_control 的 protocol（Anthropic）
- reminder 加在 user + tool_result 上**没问题**——因为 bp#2 跳过 reminder，reminder 在 cache 段外
- reminder 多了**不影响 caching**（bp#2 保护前缀稳定）
- 但影响**信息密度**（reminder 占 token）——不过 wire 层已保证 LLM 每轮只见最末一个，密度可控

### 不支持 cache_control 的 protocol（未来，如 openai_chat_completions）
- 无显式 breakpoint，只有隐式 prefix matching（逐字节持有已发消息）
- reminder 加在每条 tool_result 上 → 前缀频繁变化 → **隐式 cache 崩**
- **预案（记录不实现，274 不做）**：
  - 方案 A：清理一个 run 内非 run 首个的 reminder（只保留 run 第一个）
  - 方案 B：每 10 个保留第一个（保持密度）
  - 目的：平衡 prompt caching 和 reminder 密度

**老板的权衡**：「reminder 多了不影响 caching（对支持 cache_control 的），但影响信息密度浪费 token；对不支持 cache_control 的，reminder 频繁注入会崩隐式 cache，所以要控制密度。」

**方案自洽性确认（老板原话提炼）**：「tool 上加 reminder + 清理保留最末 + cache 截止 reminder 前，三者是自洽的——tool 轮次也有最新 reminder、历史不堆积、缓存不破坏。」这个三自洽是 274 方案成立的核心论证。

### 现状
- 当前仓库**只有 anthropic_messages impl**（支持 cache_control）→ 274 可以放心在 user+tool_result 注入
- 其他 protocol 的密度控制是**未来预案**（`supportsCacheControl` 能力标志 + 密度清理策略），274 只记录方向不实现

## 六、与 spec 现状比对结论

| 讨论点 | spec 现状 | 状态 |
|---|---|---|
| 两层独立（context 持久化 / protocol wire）| cache_control §5 已写明 | ✅ 一致 |
| 非最末 drop、最末保留最后一个 reminder | cache_control §3.3 已写明 | ✅ 一致 |
| bp#2 跳过 reminder 落稳定段 | cache_control §3.2 已写明 | ✅ 一致 |
| cache_control 是 anthropic 专属，其他 protocol 各自 encode 决定 | cache_control §4 已写明 | ✅ 一致 |
| **其他 protocol 密度控制（每 10 留 1 / 只留 run 首个）** | **spec 未写**（§4 只说「不实现=全传 fallback」） | ⚠️ **我们讨论的新预案，需补 spec** |
| **注入触发条件放宽到 tool_result** | spec §4 现状「必须 user」 | ⚠️ **274 改动点** |

## 七、274 范围（最小改动）

老板原话：「我感觉我们这个版本的变化很小，就是**最后一个 message 最后一条用于添加 system_reminder，把注入限制去掉**；然后**看一下 Anthropic 清理的地方确认配合起来没问题，可能不需要修改**。」

1. **改**：`system_reminder_injector` 触发条件放宽（user + tool_result + a2a 加，assistant 不加）
2. **不改**：Anthropic encode（bp#2 + 清理已配合，零改动，仅 UT 固化）——**代码核实（2026-08-07 读 protocol-encode-helpers.ts 证实）**：
   - `injectLastNonReminderCacheControl`：跨 message 从末尾向前扫，`if (flags[bi] === true) continue` **跳过 reminder block**，命中第一个非 reminder block 加 cache_control（bp#2）→ reminder 落在 cache 段外
   - `encodeMessage`：非最末 message drop 所有 reminder，最末保留最后一个 → LLM 每轮只见最末一个
   - `cache_control` 逻辑在 `encodeAnthropicMessages` 内（anthropic 专属），`supportsCacheControl` 未抽公共接口
   - **三者配合证实：tool 上加 reminder 不破坏 cache**（bp#2 跳过 reminder 落在 tool_result 正文 block 上）
3. **记录**：其他 protocol 密度控制预案（supportsCacheControl 能力标志 + 密度清理）——写 change_plan/spec 方向，不实现

## 八、未来扩展锚点

当新增不支持 cache_control 的 protocol（如 openai_chat_completions）时：
1. 加 `supportsCacheControl` 能力标志到 LlmProtocol 接口
2. 该 protocol 的 encode 实现 reminder 密度控制（清理 run 内非首个 reminder，或每 10 留 1）
3. 复用本讨论的分级框架（cache_control 能力 → reminder 密度策略）
