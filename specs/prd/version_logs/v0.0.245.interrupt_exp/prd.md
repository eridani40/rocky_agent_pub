# v0.0.245 PRD — 终端中断体验优化（ESC 中断 + 排队内容注入 + 焦点管理）

> 版本主题：把 chat 输入区的「中断」从单一红色按钮升级为统一动作——ESC 与中断钮任一触发都执行同一套（焦点门控 → 取消全部排队 → 排队内容注入输入区开头保留 mention pill → abort → 焦点管理）；附补输入区 `<mention/>` 反序列化器（注入路径专用）。
> 引入版本：v0.0.245 · 状态：PRD 待用户确认
> 概念权威源（PRD 对齐，不发明概念）：
> - `specs/ui/components/chat-page/_overview.md` §0/§5（abort 链路 / enqueue+cancel / 红色中断钮调 `POST /session/:id/abort`）
> - `specs/ui/components/chat-page/_data-flow.md` §2/§3.3（enqueue 三事件驱动 / abort 4 步收尾 / INV-1/5/7 移项靠 SSE 不进 store）
> - `specs/ui/components/chat-page/chat-composer.md`（输入区契约：Tiptap + @ popover + `serializeEditorContent` 输出侧序列化）
> - `specs/tech/mention/message-content.md` §3/§5.5/§8（mention flat XML tag + 正则 + XML 转义）
> 需求来源：`reqs/[working] v0.0.245.interrupt_exp/req.md`（原始三条）+ `states/v0.0.245/context.md`（已确认决策）

---

## 1. 背景 + 目标

### 1.1 背景（现状）

chat 输入区中断能力已具备雏形，但触发与体验割裂：

| 现状 | 问题 |
|------|------|
| 中断仅靠 running 时输入框左侧红色 `chat-abort` 钮触发（`_overview.md §5.3`） | 用户键盘流被打断——习惯性按 ESC 无响应（当前 ESC 仅关 @ popover，`chat-composer.md` 未定义 run 态 ESC 语义） |
| 排队消息（enqueue-view）逐条取消靠点每条 `enqueue-item-{enqueueId}-cancel`（`_data-flow.md §2.4`） | 中断当前 run 时，已排队消息不联动——用户中断后排队项悬挂，得逐条点取消；用户意图丢失（排队内容想带回输入区继续编辑） |
| 中断后焦点无管理 | 中断动作不恢复焦点到输入区——用户若原焦点不在输入区（如刚切回页面），中断后还得手动点输入区才能继续输入，割裂 |
| 输入区 Tiptap MentionNode.parseHTML 只认内部 `span[data-mention-node]`，不认 `<mention .../>` flat tag（`message-content.md §3`） | 排队内容（`EnqueueItem.content` 已含 `<mention/>` 标签）注入输入区时显示成字面文本，pill 丢失——破坏「注入保留 mention」的产品期望 |

### 1.2 目标

**统一中断动作**——ESC 与红色中断钮任一触发，执行同一套产品行为：
1. **焦点门控**：ESC 中断只在「焦点在输入区」时生效——焦点不在输入区（modal/body/消息流等持有焦点）时 ESC 不中断（弹层/他处持有焦点自然不中断，省去 modal 探测）
2. **取消全部排队**：遍历 enqueueItems 逐条调既有 `cancelEnqueue`（fire-and-forget），移项仍靠 SSE（`_data-flow.md` INV-1/5/7）
3. **排队内容注入输入区**：把取消的排队内容按「消息1\n消息2\n」拼到输入区开头（保留 mention pill），后接输入区原内容
4. **abort 当前 run**：调既有 `POST /session/:id/abort`（`_data-flow.md §3.3` 4 步收尾）
5. **焦点管理**：原焦点在输入区→光标位置不变；原焦点不在输入区→焦点+光标恢复到输入区末尾

**附**：补输入区 `<mention/>` → editor pill 反序列化器（注入路径专用，纯前端）。

### 1.3 用户故事

- 作为**用户**，我希望 running 时按 ESC 就能中断当前 run，不必去点红色按钮（键盘流不中断）
- 作为**用户**，我希望中断时已排队的内容自动带回输入区开头（保留 mention），不丢失、不必逐条取消
- 作为**用户**，我希望中断后焦点立即回到输入区（或保持在原位），无缝继续编辑
- 作为**用户**，我希望焦点不在输入区（如在弹窗/消息流）时按 ESC 不会误中断 run；焦点在输入区 + @ popover 开时 ESC 只关 popover（不中断）

---

## 2. 关键设计决策（用户已确认）

| 决策 | 选择 | 理由 |
|------|------|------|
| ESC 门控方式 | **焦点门控**——ESC 中断只在「焦点在输入区」时生效；焦点不在输入区（弹窗/body/消息流等）时 ESC 不中断 | 焦点在弹窗=不在输入区→ESC 自然不中断，简单明确；省去 overlay-root/modal 探测，内联 modal 盲区消除 |
| ESC 与中断钮的关系 | **语义统一**——二者触发同一「中断动作」（取消排队+注入+abort+焦点） | 不割裂体验：用户不必记忆「ESC 只 abort，按钮才注入」；任一入口行为一致 |
| 排队内容注入格式 | 「消息1\n消息2\n」拼到输入区**开头**，后接原内容；每条排队内容之间换行 | 用户原话「按照排队消息1 换行 排队消息2 换行」「注入到输入区的开始，后面拼接输入区已有消息」 |
| mention pill 保留 | 注入的排队内容需保留 pill（`<mention .../>` → Tiptap MentionNode） | 排队内容已含 mention tag（`EnqueueItem.content`），注入丢 pill = 信息降级；补输入侧反序列化器（`serializeEditorContent` 逆运算） |
| 反序列化器范围 | **仅注入路径**；实时手打 `<mention/>`→pill 的即时识别**不做** | 用户裁决：范围限定注入路径；实时识别是另一独立场景（输入态校验），本版本不涉及 |
| 焦点管理策略 | 原焦点在输入区→位置不变；原焦点不在输入区→焦点+光标到输入区**末尾** | 用户原话「原本在输入区位置不变，不在则恢复到最后一个字符后」；末尾=继续编辑最自然 |

---

## 3. 功能需求

### 3.1 ESC 触发中断（焦点门控）[v0.0.245]

**描述**：ESC 中断只在「焦点在输入区」时生效——焦点不在输入区（modal/body/消息流等持有焦点）时 ESC 不中断（弹层/他处持有焦点自然不中断，省去 modal 探测）。

**对齐既有概念**：
- 中断的「动作语义」复用 `_overview.md §5.3` 既有 abort 链路（仅扩触发器：键盘 ESC 与红色 `chat-abort` 钮并存）
- @ popover 是 `chat-composer.md` 既有的 MentionPopover 浮层（焦点在输入区 + popover 开时，ESC 只关 popover 不冒泡到中断）
- HITL 卡（`pendingToolCall` mount 的提问/审批卡，`_data-flow.md §3.5`）——焦点在输入区 + HITL pending 时 ESC 无反应（保留用户在 HITL 上下文里）
- **焦点在输入区即代表无 modal/弹窗持有焦点**——modal 打开时焦点在 modal 内（不在输入区）→ ESC 自然不中断，省去 overlay-root/modal 探测，内联 modal 盲区消除

**交互细节**（焦点门控，按焦点位置 + 输入区状态判定）：
- 焦点**不在输入区**（modal/body/消息流等持有焦点）→ ESC **无反应**（不中断；modal 自身的 ESC 关闭照常工作，由 modal 自身处理）
- 焦点**在输入区** + @ popover 开 → ESC 只关 popover（不中断）
- 焦点在输入区 + HITL pending（`pendingToolCall != null`）→ ESC **无反应**（不中断，保留用户在 HITL 上下文）
- 焦点在输入区 + 无 popover + 无 HITL + `sessionRunning === true` → 执行「中断动作」（§3.2）
- 焦点在输入区 + 非 running → ESC **无反应**（不发明新语义）
- **不破坏既有行为**：modal/popover 自身的 ESC 关闭语义照常（由各自组件处理）；本版本仅定义「焦点在输入区 + running」时 ESC 的中断语义

**优先级**：P0 · **用户故事**：作为用户，焦点在输入区 + running 时按 ESC 中断；焦点不在输入区时按 ESC 不会误中断（焦点在弹窗/他处时 ESC 由那里处理）。

#### E2E Use Cases（ESC 触发 + 焦点门控）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-E1 | running + 焦点在输入区 + 无 popover/HITL → 按 ESC | 执行中断动作（§3.2：取消排队+注入+abort+焦点） |
| UC-E2 | running + 焦点在输入区 + @ popover 开 → 按 ESC | 仅关 popover；run 不中断；再按 ESC（popover 已关 + 焦点仍在输入区）才中断 |
| UC-E3 | running + 焦点在输入区 + HITL 提问卡 pending → 按 ESC | ESC 无反应（不中断，保留用户在 HITL 上下文） |
| UC-E4 | running + 焦点不在输入区（如 body/消息流/弹窗）→ 按 ESC | ESC 无反应（不中断；弹窗自身 ESC 关闭由弹窗处理）；需中断请点红钮或先点输入框 |

### 3.2 统一中断动作：取消全部排队 + 注入输入区 + abort [v0.0.245]

**描述**：定义「中断动作」为原子产品行为——ESC 与红色中断钮任一触发都执行同一套（语义统一，不割裂）。动作顺序：取消全部排队 → 排队内容注入输入区 → abort 当前 run → 焦点管理（§3.3）。

**对齐既有概念**：
- **取消全部排队** = 遍历 `enqueueItems` 逐条调既有 `POST /session/:id/messages/:enqueueId/cancel`（202 fire-and-forget，`_data-flow.md §2.4`）；移项仍靠 SSE `enqueued_message_canceled`（INV-1/5 不进 store；INV-7 幂等可重试）——**不发明新后端接口**
- **abort** = 既有 `POST /session/:id/abort`（202 fire-and-forget，`_data-flow.md §3.3` 4 步收尾：loop 退出 / partial 持久化 / clearReplay / state→interrupted）
- **注入** = 把取消的排队内容拼成字符串塞入 Tiptap editor（`chat-composer.md` 既有的 editor 实例）
- **红色中断钮** = 既有 `chat-abort`（`_overview.md §5.3`），本版本仅扩其 onAbort 回调为同一「中断动作」

**注入规格（用户原话）**：
- 排队内容按 enqueueItems 顺序拼成「`消息1\n消息2\n`」（每条之间换行 `\n`，末尾也带 `\n`）
- 拼接结果插入输入区**开头**；输入区**原内容**续在拼接结果之后
- **保留 mention pill**：`EnqueueItem.content` 里的 `<mention .../>` tag 经反序列化器（§3.4）转成 Tiptap MentionNode，显示为 pill 而非字面文本
- 无排队（`enqueueItems.length === 0`）→ 跳过注入，输入区原内容不动（§路径F）

**非目标（显式不做）**：
- 不批量取消用新接口——逐条 cancelEnqueue 是既有机制，SSE 收敛多端一致（INV-1/5）；本版本不引入「cancel-all」后端端点
- 不改 abort 4 步收尾语义（partial 持久化 / state 机不变）

**优先级**：P0 · **用户故事**：作为用户，中断时排队内容自动带回输入区开头（保留 mention），不丢、不必逐条点取消。

#### E2E Use Cases（统一中断动作）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-A1 | running + 排队[消息1,消息2] + 输入区有「原内容」 → 按 ESC 或点中断钮 | 排队取消（逐条 cancel + SSE 移项）+ 输入区变「消息1\n消息2\n原内容」（pill 保留）+ abort run |
| UC-A2 | running + 排队含 mention（如「看 @helper.ts」）+ 输入区空 → 中断 | 输入区变「看 [@helper.ts]pill\n」（mention 显 pill 非字面 tag）+ abort |
| UC-A3 | running + 无排队 + 输入区有「原内容」 → 中断 | 跳过注入，输入区「原内容」不变 + abort（见路径F） |
| UC-A4 | running + 排队[消息1] + 输入区空 → 点红色中断钮 | 与 UC-A1 同行为（语义统一：取消排队+注入+abort+焦点） |
| UC-A5 | 中断后看 enqueue-view | 排队项全部移除（靠 SSE `enqueued_message_canceled` 移项，INV-1/5） |

### 3.3 焦点管理 [v0.0.245]

**描述**：中断动作的最后一步——按「原焦点是否在输入区」分两支管理焦点 + 光标位置。

**对齐既有概念**：焦点管理是纯前端行为，作用对象是 `chat-composer.md` 既有的 Tiptap editor。

**规则（用户原话）**：
- **原焦点在输入区** → 焦点保持，**光标位置不变**（注入内容插入开头后，光标相对原内容的偏移自然前移；不强制挪到末尾，尊重用户编辑上下文）
- **原焦点不在输入区** → 焦点 + 光标恢复到输入区**末尾**（继续编辑最自然）
- 无排队（跳过注入）时焦点管理仍执行——中断后无论原焦点在哪，都给用户一个可立即继续输入的焦点状态

**注**：原焦点在输入区 + 有注入时，「光标位置不变」指相对原内容的位置（注入内容追加在开头，原内容下移，光标跟随原内容）；具体实现由架构期定（保持 selection 锚点相对原内容偏移），PRD 只表达「不打断用户编辑上下文」的产品期望。

**ESC vs 红钮路径差异（澄清）**：ESC 触发时焦点必在输入区（§3.1 焦点门控前提）→ 恒走「位置不变」分支；**红钮**触发时焦点可能在按钮/别处（非输入区）→ 走「焦点+光标到输入区末尾」分支。req 点 3（原在输入区位置不变 / 不在则到末尾）由红钮路径完整满足；ESC 路径因焦点门控恒为「位置不变」。

**优先级**：P0 · **用户故事**：作为用户，中断后焦点立即可用——在输入区则保持位置，不在则回到末尾。

#### E2E Use Cases（焦点管理）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-F1 | running + 焦点不在输入区（如刚切回页面焦点在 body） → 中断 | 中断后焦点回到输入区，光标在末尾（可立即继续输入） |
| UC-F2 | running + 焦点已在输入区某位置 + 有注入 → 中断 | 中断后焦点仍在输入区，光标相对原内容位置不变（原内容下移到注入内容之后） |
| UC-F3 | running + 焦点已在输入区 + 无排队 → 中断 | 焦点位置不变（无注入，输入区内容未变） |

### 3.4 输入区 mention 反序列化器（注入路径专用）[v0.0.245]

**描述**：补输入区 Tiptap editor 的 `<mention .../>` → MentionNode 反序列化器——`serializeEditorContent`（输出侧）的逆运算，让注入路径的排队内容里的 mention tag 显示为 pill。**仅注入路径**；实时手打/粘贴 `<mention/>` 的即时识别不在范围。

**对齐既有概念**：
- mention tag 格式权威 = `specs/tech/mention/message-content.md §3/§5.5/§8`（flat 属性 + 正则 `/<mention\s+([^>]*?)\s*\/>/g` + 属性抽取 + XML 转义规则）
- 反序列化器复用既有 `MENTION_RE` 正则（`component-mention-render.tsx` 用于 enqueue/对话区渲染 pill 的同一正则——单一正则权威，避免双份）
- Tiptap MentionNode 是 `chat-composer-extension.tsx` 既有的 inline node（`span[data-mention-node]` 内部表示）

**功能要点**（产品期望，不擅填实现）：
- 注入字符串中的每个 `<mention .../>` tag → 转成 Tiptap MentionNode（pill 显示），tag 外的文本 → 普通 paragraph 文本
- 抽取 display 属性（`icon`/`label`/`badge?`）按 `message-content.md §3.2` 闭集合渲染 pill；address 属性（`type` + `path`/`kind+id`/`id`）透传不解释
- 属性值按 `message-content.md §8` 反转义（`&quot;`→`"` 等）
- 旧格式 tag（v0.0.45/68 两属性）降级处理（`message-content.md §7`）——renderer 缺 display 属性降级纯文本，注入路径同规则

**非目标（显式不做）**：
- **不做实时手打识别**——用户在输入区手打字面 `<mention .../>` 字符不会即时转 pill（用户裁决：范围限定注入路径）；本版本反序列化器仅在「中断动作注入」这一明确路径调用
- 不改 `serializeEditorContent` 输出侧（已对齐 `message-content.md`）；不改后端 mention 落库（server 零处理透传，`message-content.md §1`）

**优先级**：P1（服务 §3.2 注入保留 pill，是中断体验完整性的补丁）· **用户故事**：作为用户，中断后排队内容里的 mention 显示为 pill（和排队区看到的一致），不是字面 XML 文本。

#### E2E Use Cases（反序列化器）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-D1 | 排队内容含 `<mention type="file" path="src/a.ts" icon="file" label="a.ts"/>` → 中断注入 | 输入区显示 pill「@a.ts」（file icon），非字面 tag 文本 |
| UC-D2 | 排队内容含 workitem/member mention → 注入 | 按 `message-content.md §3.2` display 属性显 pill（kind 对应 icon / leader badge 等） |
| UC-D3 | 用户在输入区手打字面 `<mention .../>` | **不**转 pill（实时识别不在范围），保持字面文本（本版本不涉及） |

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

> 用户路径 = 测试最低覆盖。版本验证 = 冒烟集回归 + UT（用户铁律：普通 feature 不新增持久 AT/ET，仅 LLM 不确定/新板块入选）。本版本无新 LLM 不确定场景 → 倾向 UT + 少量 ET。

| # | 前置条件 | 操作序列 | 期望结果 | 覆盖建议 |
|---|---------|---------|---------|---------|
| **P-A** | running + 焦点在输入区 + 无 popover/HITL | 按 ESC | 中断动作触发（取消排队+注入+abort+焦点） | ET（chat 主链路冒烟，ESC 中断是核心交互）+ UT（ESC 焦点门控判定） |
| **P-B** | running + 排队[消息1,消息2] + 输入区有「原内容」 | 按 ESC 或点中断钮 | 输入区变「消息1\n消息2\n原内容」（pill 保留）+ 排队移除 + abort | ET（同 P-A case 内连续操作：先 enqueue 两条再 ESC）+ UT（注入拼接 + 反序列化器） |
| **P-C** | running + 焦点不在输入区 | 按 ESC | **无反应（不中断）**；需中断请点红钮（P-G）或先点输入框 | UT（焦点门控分支） |
| **P-D** | running + 焦点已在输入区某位置 | 按 ESC | 中断 + 焦点位置不变（原内容下移） | UT（焦点管理分支） |
| **P-E** | running + 焦点在输入区 + @ popover 打开 | 按 ESC | 仅关 popover，不中断；再按 ESC（焦点仍在输入区 + popover 已关）才中断 | UT（焦点门控 + popover 分支）+ ET（焦点门控是关键交互，建议进 ET） |
| **P-F** | running + 无排队 + 输入区有「原内容」 | 按 ESC | 输入区「原内容」不变 + abort | UT（无排队跳过注入分支） |
| **P-G** | running + 排队 + 输入区有内容 | 点红色中断钮 | 与 P-B 同行为（语义统一） | UT（中断钮 onAbort 走同一动作） |

**红钮兜底**：红钮（P-G）仍可任意焦点位置触发中断——是「焦点不在输入区时」的兜底入口（用户焦点在弹窗/消息流时想中断，点红钮即可，不必先点输入框）。

**ET 候选评估**：本版本改动用户可感知交互（ESC 中断 + 焦点门控 + 注入），需 ET blocking=0 才能合并。建议 1 条 ET 合并覆盖 P-A/P-B/P-E（进 chat → 发消息触发 run → 再发两条排队 → @ 打开 popover 按 ESC 验证只关 popover → 关 popover 后 ESC 验证中断+注入+排队清空）。不新增 AT（无新 LLM 不确定场景——abort/cancel 是确定性 HTTP 链路，注入是纯前端）。

**UT 重点**：ESC 焦点门控判定（焦点不在输入区无反应 / 焦点在输入区 + popover/HITL 不中断 / 焦点在输入区 + running 中断）/ 注入拼接格式（消息1\n消息2\n + 原内容）/ 反序列化器（mention tag → pill，含 XML 反转义 + 旧格式降级）/ 焦点管理（ESC 恒「位置不变」+ 红钮两分支）。

---

## 5. 范围边界（IN / OUT）

### IN SCOPE（v0.0.245）
- ESC 触发中断（焦点门控：焦点不在输入区时 ESC 不中断；焦点在输入区 + @ popover/HITL pending 时不中断）
- 统一中断动作（ESC + 红色中断钮语义统一：取消全部排队 + 注入输入区开头保留 pill + abort + 焦点管理）
- 焦点管理（原在输入区→位置不变；不在→末尾）
- 输入区 `<mention/>` 反序列化器（**注入路径专用**）

### OUT OF SCOPE（显式不做）

| 排除项 | 理由 |
|--------|------|
| 实时手打 `<mention/>` → pill 即时识别 | 用户裁决：范围限定注入路径；实时识别是输入态校验另一独立场景 |
| 新增「cancel-all」后端接口 | 逐条 cancelEnqueue 是既有机制，SSE 收敛多端一致（INV-1/5/7）；后端零改 |
| 改 abort 4 步收尾语义 / state 机 | 既有契约（`_data-flow.md §3.3`）完备，本版本仅扩触发器与前置动作 |
| 改 mention tag 格式 / server 落库 | `message-content.md §1` server 零处理透传，五者同一份字符串——本版本零改 |
| 改 `serializeEditorContent` 输出侧 | 已对齐 `message-content.md`；本版本仅补输入侧反序列化器（逆运算） |
| modal / HITL 卡的 ESC 关闭逻辑本身 | 复用既有（modal/HITL 已有各自 ESC 处理）；焦点门控下 modal 打开→焦点在 modal→ESC 自然不中断；HITL pending + 焦点在输入区由本版本显式判定不中断 |
| 设计稿 / 像素级 UI 规范 | 无设计稿；本版本是行为修改（视觉零改：中断钮/排队区/输入区外观不变） |

---

## 6. 验收口径

**功能**：
- ESC 触发（焦点门控）：焦点在输入区 + 无 popover + 无 HITL + running 按 ESC → 中断动作触发；焦点不在输入区时 ESC 无反应（不中断）；焦点在输入区 + @ popover 开时 ESC 只关 popover
- 红钮触发（任意位置）：点红色中断钮 → 中断动作触发（不受焦点位置约束，兜底入口）
- 统一动作：ESC 与红色中断钮行为一致——取消全部排队（逐条 cancel + SSE 移项）+ 排队内容注入输入区开头（「消息1\n消息2\n」格式 + pill 保留）+ abort（state→interrupting→interrupted）+ 焦点管理
- 注入保留 pill：排队内容里的 `<mention .../>` 显示为 pill（非字面文本），含 XML 反转义 + 旧格式降级
- 焦点：原在输入区→位置不变；不在→末尾
- 无排队（P-F）：输入区原内容不动，仅 abort

**视觉**：无设计稿（行为修改，视觉零改）→ 视觉保真 compare 跳过；验收以「功能正确 + 注入后输入区 pill 渲染正确」为准

**API**：无新接口 / 无契约变更（abort + cancel 既有端点）；AT 不新增（确定性 HTTP 链路 UT 覆盖）

**known-issue**：暂无（待验证发现）

---

## 7. 待对齐 / 风险

> 读 spec + 代码现状发现以下待架构期核实/对齐项（PRD 不擅自改 spec，记录待决）：

| 项 | 现状/风险 | 处置 |
|----|----------|------|
| ESC 键路落点（焦点门控逻辑） | `chat-composer` 当前 ESC 仅关 @ popover（`chat-composer.md` 未定义 run 态 ESC）；焦点门控需 window capture listener + 焦点状态（isFocused）+ popover/pendingToolCall/sessionRunning 查询 | 架构期定落点（window capture listener + isFocused/isPopoverOpen/pendingToolCall/sessionRunning 判定）；PRD 只表达焦点门控语义 |
| 焦点「位置不变」精确语义 | 「原焦点在输入区 + 有注入」时光标相对原内容偏移还是绝对偏移，spec 未定义 | 架构期定（倾向相对原内容，跟随原内容下移）；PRD 表达「不打断编辑上下文」 |
| 中断钮 `chat-abort` onAbort 回调 | 现状 onAbort 仅调 `runState.abort()`（`section-chat-session.tsx`），不含取消排队+注入+焦点 | 架构期扩 onAbort 为统一「中断动作」（与 ESC 同 handler）；PRD 表达「语义统一」 |
| `MENTION_RE` 正则复用 | `component-mention-render.tsx` 的正则是否可被 composer 反序列化器复用（避免双份） | 架构期定（倾向抽到共用模块，单一正则权威）；spec `_data-flow.md`/`message-content.md` 不变 |
| ~~modal 弹层状态查询~~ | **已废弃（用户裁决 22:40，焦点门控取代）**——焦点门控下「焦点在输入区即代表无 modal 持有焦点」，无需跨组件查 modal 状态 | 不再需要；modal 打开时焦点在 modal → 焦点不在输入区 → ESC 自然无反应 |

**概念边界**：本版本是对既有 chat-page 概念（abort / enqueue / chat-composer / mention tag）的**行为修改与补全**，不引入新概念——中断动作是既有 abort+cancel 的产品层编排；ESC 是既有 abort 钮的新触发器；反序列化器是既有 serializeEditorContent 的逆运算。新交互（ESC 键路 / 焦点管理 / 反序列化器）的 spec 字段由架构期 / coder 阶段补 `chat-composer.md`（ESC + 焦点）与 `chat-composer-extension` 相关 spec（反序列化器），PRD 不擅填实现细节。

---

## 8. spec doc-sync 待办（架构期 / doc-modifier 阶段 5 处理）

> 读 spec 发现以下漂移/待补项（PRD 描述按本版本正确概念，doc-modifier 阶段 5 统一修 spec 对齐）：

| spec 文件 | 待补/漂移内容 | 正确概念 |
|-----------|--------------|---------|
| `specs/ui/components/chat-page/chat-composer.md` | 「状态/交互」节未定义 run 态 ESC 语义（仅 @ 触发 + popover） | v0.0.245 起补 ESC 键路（焦点门控：焦点不在输入区无反应 + 焦点在输入区 popover/HITL/running 分支 + 中断动作触发）+ 焦点管理（ESC 恒「位置不变」+ 红钮两分支） |
| `specs/ui/components/chat-page/_overview.md §5.3` | 中断触发只写「点 `chat-abort`」单一入口 | v0.0.245 起 ESC 与 `chat-abort` 钮双触发、同一中断动作（取消排队+注入+abort+焦点） |
| `specs/ui/components/chat-page/_data-flow.md §3.3` | abort 链路只描述 POST /abort 4 步收尾，未涉取消排队+注入（产品层编排） | v0.0.245 起补「中断动作」= 取消全部排队（逐条 cancel + SSE 移项 INV-1/5）+ 注入输入区 + abort + 焦点（产品层编排，后端零改） |
| `specs/ui/components/chat-page/chat-composer-extension`（待补/抽 spec） | 输入区只有输出侧 `serializeEditorContent`，无输入侧反序列化器 spec | v0.0.245 起补输入侧 `<mention/>` → MentionNode 反序列化器（注入路径专用，复用 `MENTION_RE` 正则 + `message-content.md §3/§8` 规则）；实时手打识别显式不做 |

**概念边界重申**：本版本不引入新概念（abort / enqueue / cancel / mention tag / chat-composer 均 spec 已完备），只补「中断动作」产品层编排 + ESC 键路 + 焦点管理 + 输入侧反序列化器。新 UI 交互（ESC 键路字段 / 焦点规则 / 反序列化器契约）由架构期 / coder 阶段补对应组件 spec，PRD 不擅自填实现细节。
