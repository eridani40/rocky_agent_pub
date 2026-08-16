# 模型路由降级 — 方案设计 v3.2（2026-08-14）

> 性质：**方案设计（老板 9 点 + 架构讨论已拍板，v3 并入架构级设计）**，确认后转正式 PRD。
> 调研依据：`specs/research/model-routing-2026-08-14.md`（cc-switch 源码实证 + LiteLLM/OpenRouter/Portkey 对比）
> 老板拍板（10:24）：时间条件挂 item、窗口内可用/窗口外下滑；不配置=随时可用；同模型最多 2 条目（1 带时间 + 1 不带时间），带时间在上。
> 老板 9 点反馈（10:40，v2 依据）：D1 所有失败计入熔断+按错误类型差异化重试 / D2 沿用现有看门狗 ✅ / D3 白名单小时格（0-23，每天，无周几分钟 exclude）/ D4 不隐式兜底 ✅ / D5 熔断挂方案实体 / D6 默认 4/2/60/0.6/10+高级区 / D7 session→团队→app+同 attempt 同模型去重 / D8 同 D3 / D9 硬拒绝同模型 2 带时间或 2 不带时间。
> **老板架构讨论（10:49-10:52，v3 依据）**：①熔断 = 「某个方案的某个模型」（planId+providerId+modelId 三维，方案间隔离）②配置层级：session 只能配 model/default；group/playground 可配方案或默认模型（暂时只有 studio/playground 默认可用方案）；app 级 = 方案库 CRUD ③resolve 产出两种（无方案→分支 1 单模型；有方案→分支 2：session default 直接走方案 / session 显式模型 = priority 0 合成插入方案顶部，不写回）④resolve 下沉 llm attempt 内部（attempt 循环内逐步决策，非调用前定死）⑤Config/State 分离（Config=静态定义含熔断；State=attempt 内动态执行记录；决策 = f(config, state) 可复现）。
> **老板 10:52 补充（state 边界）**：**State = agent loop 对「这一次 llm call」的状态**（单次 call 内部，非跨 call 全局）；熔断状态属 **Config**（跨 call 共享，挂方案维度）；每次 llm call 独立 state 生命周期。
> **老板 10:53 补充（state 内容）**：State 记录「调用过谁、失败了、放弃了谁」——数据结构 = 候选处置轨迹（called/failed/abandoned/skipped 四态 + 失败原因 + 尝试次数 + 退避截止）。
> **老板 10:55 补充（v3.1，放弃/熔断挂钩模型配置）**：**放弃或熔断是与「模型配置」挂钩的，不是与配置 item 挂钩**——同一个模型在一次 attempt 内可能以多个 item 出现（session 合成 + 带时间条件 + 无条件）；一旦该模型配置被放弃（abandoned）或熔断（Open），本次 attempt 内后续所有该模型的 item 全部跳过（skipped）。
> **老板 11:16 三点反馈（v3.2，demo 后拍板确认 go 开发）**：①**条目启用开关**（enabled，默认 true；可关闭但不删除，停用保留配置，路由时直接 skipped）②**状态呈现 = 用户友好词**（🟢 正常 / 🔴 异常带倒计时 / 🟡 观察中无倒计时），内部逻辑仍用熔断器三态（Closed/Open/HalfOpen）③**时间控件用成熟现成组件**（24 格小时拖拽式时间段选择器或等效交互），不自己造轮子。
> 对齐 rocky 现状：`model_resolve.md` + `provider_health_registry.md`（per-session 4 态）+ `retry_and_timeout.md` + `error_normalization.md`（LlmErrorCategory 全枚举）。

## 0. 老板需求 → 方案映射

| 老板需求 | 方案落点 |
|---|---|
| ① 按当地时间配置（特定时段可用） | item 级**时间条件 = 白名单小时格**（`{hours: number[]}`，0-23） |
| ② 按顺序向下调用（降级链） | 组合方案 = **有序条目列表**（priority），attempt 内按序尝试 |
| ③ 熔断开/闭/半开三态 | **三态熔断状态机**（cc-switch Hystrix 风格），**状态挂方案实体**（planId+providerId+modelId 三维） |
| ④ 同模型 1 带时间 + 1 不带时间；带时间必须在不带时间上面 | 同模型**最多 2 条目**校验（硬拒绝 2 带时间 / 2 不带时间） |
| 落地：设置里组合方案配置；团队可配默认模型/组合方案 | **模型组合方案** = 可命名、可挂载、可编辑实体（app 级方案库 CRUD，group 挂载） |

## 1. 配置方案（数据模型 + 配置层级）

### 1.0 配置层级（老板架构讨论 10:49，四层职责）

| 层级 | 可配置什么 | 说明 |
|---|---|---|
| **app 级** | **方案库（CRUD）** | 模型组合方案的唯一定义处；可命名/可编辑/可删除 |
| **group / playground（studio）** | **方案或默认模型** | 挂载一个方案 → 该 group 下所有 session 走方案链；或只配默认模型（现有逻辑）；**暂时只有 studio/playground 默认可用方案**（academy 本期不支持） |
| **session 级** | **只能配 model / default** | **不能配方案**（老板原话）；session 的 model 选择覆盖 group 默认模型 |
| 熔断状态 | 运行时内存态 | 挂方案实体维度，见 §2/§3.2 |

**resolve 的两种产出（老板架构讨论 ③）**：

```
resolve(session, group):
  ├─ group 无方案（只配模型）→ 分支 1：现有单模型逻辑（resolveModel 原链，零改动）
  └─ group 有方案 → 分支 2：
       ├─ session.modelId == 'default' → 直接走方案链（方案条目本身）
       └─ session 显式配了模型 → session 模型作为 priority 0 合成插入方案顶部
            （临时合成，不写回方案实体；熔断键 = planId + session 模型）
```

### 1.1 模型组合方案（ModelRoutingPlan）

```typescript
interface ModelRoutingPlan {
  id: string;
  name: string;            // 可命名实体（如「主力+兜底」）；group 挂载引用
  items: RoutingItem[];    // 有序降级链（按 priority 升序 = 尝试顺序）
  circuit?: CircuitConfig; // 熔断参数覆盖（可选，见 §3.2）
  createdAt: number;
}
```

- 存储：app_config 新增 group `model_routing_plans`（key=planId，**方案库**）；group 挂载字段（如 `squad.modelRoutingPlanId` / playground group 配置）。
- **产品新概念**（老板 D5）：「模型组合方案」= **可命名、可挂载、可编辑**——app 级方案库 CRUD 定义，group 挂载后生效，编辑后所有挂载方生效。

### 1.2 条目（RoutingItem）

```typescript
interface RoutingItem {
  providerId: string;      // 指向 app_config providers 实例（ModelRef 复合，防同名跨 provider 歧义）
  modelId: string;
  priority: number;        // 1 = 最高优先（尝试顺序 = priority 升序）
  timeCondition?: TimeCondition;  // 可选；不配置 = 随时可用（无条件条目）
  enabled: boolean;        // 启用/停用开关（老板 11:16 ①），默认 true；停用 = 保留配置但路由时直接跳过
}
```

**启用/停用开关（老板 11:16 ①）**：
- 每个条目可**关闭但不删除**（停用保留配置）；停用条目**不参与路由**（attempt 循环直接 skipped，见 §3.1）；
- 同模型条目约束校验**按「启用」条目统计**（停用条目不占额度；启用/停用切换时实时校验，违规阻止启用并提示）。

**同模型条目约束（老板 D9 原话，保存时硬拒绝）**：
- 同一个模型**最多 2 个条目**：1 个带时间 + 1 个不带时间；
- **带时间条目必须在不带时间条目上面**（时间命中优先用带时间条目；未命中滑到不带时间条目兜底）；
- 同模型**不允许 2 个带时间**条目；
- 同模型**不允许 2 个不带时间**条目（重复 = 冗余）。

### 1.3 时间条件表达（老板 D3 拍板：白名单小时格）

```typescript
interface TimeCondition {
  hours: number[];   // 0-23，白名单：当前小时 ∈ hours → 可用；否则跳过
}
```

**语义（老板 D3）**：
- **白名单模式（active）**：当前小时在 `hours` 里 → 该条目可用（参与候选）；不在 → **直接下滑跳过**（不参与本次尝试、不计尝试、不计熔断失败）。
- **每天重复**（不需要星期几）；**小时粒度**（24 个格子勾选 0-23）；**不做 exclude、不做周几、不做分钟**。
- 不配置时间条件 = 随时可用（无条件条目，任何小时都可尝试）。
- **本地时间**：Electron 桌面端本地时区求值，无服务器时区歧义。
- 示例「周二凌晨恢复」：Kimi 只在 02:00-23 点可用 → `hours: [2,3,...,23]`（0、1 点不可用自动滑到下一个模型）。

### 1.4 设置 UI 组织

```
应用设置 → 模型 tab → 「模型组合方案库」区块
├── 方案列表（新建/重命名/删除/复制）—— app 级 CRUD
└── 方案编辑页
    ├── 有序条目列表（上移/下移 = 调 priority；或数字输入）
    │   └── 每条目：模型选择（provider/model picker）
    │       ├── 启用/停用开关（默认启用；停用保留配置不删除，路由跳过）
    │       ├── 时间条件（可选）：「不限」/「只在以下小时可用」
    │       │   └── 24 格小时拖拽式时间段选择器（**成熟现成组件，不造轮子**，选型标准见 §1.5）
    │       └── 同模型条目校验提示（提交时硬拒绝，见 §2.3）
    └── 熔断参数（可选覆盖，收进「高级」可折叠区域，见 §3.2）
团队/playground 设置 → 默认模型/方案：选择挂载一个方案（或保持单模型默认）
session 设置 → 只能选 model / default（不能配方案）
```

### 1.5 时间控件选型（老板 11:16 ③：成熟现成组件，不自己造轮子）

- demo 里的 24 格拖拽只是示意；**正式实现必须用成熟现成组件**（24 格小时拖拽式时间段选择器或等效交互）。
- **选型标准**（架构阶段定具体组件）：
  1. **支持拖拽连续段**：拖拽选中/取消连续小时段（如 02:00-08:00 一段拖出）；
  2. **多段加选**：可追加多段不连续区间（Ctrl/Cmd 加选或再次拖拽）；
  3. **清空 = 全天**：一键清空所有选中 = 「不限/随时可用」语义（等价不配置时间条件）；
  4. **hover 提示**：悬停显示小时信息（如「02:00-03:00」），降低误操作；
  5. 成熟度：优先已被广泛使用的开源组件（如 react 生态时间段选择器），维护活跃、可主题化、无重度依赖。
- 输出值仍是 `TimeCondition = { hours: number[] }`（0-23 白名单），与后端数据模型解耦。

## 2. 概念模型

### 2.1 Config / State 分离（架构基石，老板架构讨论 ⑤ + 10:52 边界拍板）

**老板原话「各司其职」——已确认合理**。路由的全部决策 = `f(config, state)`：

| 维度 | 内容 | 生命周期 | 特性 |
|---|---|---|---|
| **Config（静态定义）** | 方案实体（items 有序链 + 时间条件 + 熔断参数）+ **熔断状态**（谁在备选、谁熔断了，挂方案维度） | **跨 call 存活**（挂方案实体维度） | 静态可查询；熔断状态 = 运行时内存态（**不持久化**，重启丢失可接受，与之前拍板一致） |
| **State（动态执行）** | **agent loop 对「这一次 llm call」的状态**——本次调用过程中调过谁、失败几次、什么原因、下一步决策（下一个候选 / sleep 多久） | **call 级瞬时**（单次调用生命周期） | 每次 llm call 独立 state 生命周期；**不落盘**，call 结束即弃 |

**关键边界（老板 10:52 拍板）**：

| 维度 | 归属 | 生命周期 |
|---|---|---|
| **熔断状态** | **Config**（挂方案维度，planId+providerId+modelId） | **跨 call 共享存活**（这是 config 的一部分，不是 state） |
| **state** | **本次 llm call 内**（agent loop 发起一次调用 → attempt 内部循环 → 成功/全部失败结束 → state 生命周期结束） | **call 级瞬时**（不是跨 call 的全局状态） |

**决策公式**：`下一步调谁 / sleep 多久 = f(config, state)`——config 跨 call（方案 + 熔断）、state 仅本次 call；**config 一定 + state 一定 → 结果确定（可复现）**（纯函数决策，无隐藏随机）。

**对多 agent**：agent 只需「我要调用」；所有中间尝试在 **attempt 内部收敛**，外部（agent loop / 上层）无感知——路由对 agent 透明。

### 2.1.1 State 数据结构（老板 10:53 拍板：调用过谁、失败了、放弃了谁；v3.1 增加模型级去重）

**State = 本次 llm call 内的候选处置轨迹**，每条候选一条记录：

```typescript
interface AttemptState {
  tried: CandidateRecord[];   // 已处置候选的轨迹（调用过谁、失败了、放弃了谁）
  cursor: number;             // 当前尝试到候选列表哪个位置
  bannedModels: Set<string>;  // 本次 call 内被放弃/熔断的模型配置（key = providerId+modelId），见 v3.1
}

interface CandidateRecord {
  item: RoutingItem;          // 候选条目（provider+model）
  status: 'called' | 'failed' | 'abandoned' | 'skipped';  // 调过 / 失败了 / 放弃了 / 跳过了
  error?: LlmError;           // 失败原因（错误分类）
  attemptCount?: number;      // 模型内尝试次数
  sleepUntil?: number;        // 退避等待截止（429/限流时）
}
```

**四态枚举语义（老板 10:53 原话 + 合并）**：

| status | 语义 | 触发 |
|---|---|---|
| **called** | 发起了调用（成功或失败都算，失败看 error） | 候选被选中发起 LLM 调用 |
| **failed** | 调用失败（记录原因分类 → 决定下一步） | 调用返回错误 |
| **abandoned** | 放弃了（不重试、不降级到它） | 401/403 直接熔断放弃、429 快速失败放弃等 |
| **skipped** | 跳过了（不尝试） | 时间过滤未命中 / 熔断 Open / 同模型去重 / **模型配置在 bannedModels 中（v3.1）** |

### 2.1.2 放弃/熔断挂钩「模型配置」维度（老板 10:55 拍板，v3.1）

**老板原话**：「放弃或者熔断，是和这个模型配置挂钩的，不是和配置 item 挂钩，如果前面放弃过了，后面不能尝试（session 配置，条件配置，无条件配置，可能出现好几次）」

- **去重键 = 模型配置（providerId+modelId 复合键），不是 item**：同一个模型在一次 attempt 内可能以多个 item 出现——session 显式配置（priority 0 合成）+ 带时间条件 item + 不带时间条件 item。
- **一旦该模型配置被放弃（abandoned）或熔断（Open），本次 attempt 内后续所有该模型的 item 全部跳过（skipped）**——不管是 session 合成的、条件 item 还是无条件 item。
- **机制**：AttemptState 增加模型级去重集合 `bannedModels: Set<providerId+modelId>`（本次 call 内被放弃/熔断的模型配置）；候选循环遇到 banned 模型直接 skipped；status=abandoned 的条目同步进 bannedModels（熔断 Open 也同步进）。
- **决策公式不变**：下一步 = f(config, state)——state 含 bannedModels，遇到同模型 item 直接跳过，不再尝试。
- **与 §2.1.1 四态的关系**：abandoned（放弃）和熔断 Open（config 层）都会把该模型配置加入本次 call 的 bannedModels；skipped 的触发新增一种：模型配置在 bannedModels 中。

**决策依据**：下一步 = `f(config, state)`——看 `cursor` 下一个候选，结合 config（熔断/时间）+ state（已调过谁 + bannedModels）决定：**尝试 / 跳过 / sleep 后重试 / 全部放弃报错**。

### 2.2 概念定义与关系

| 概念 | 定义 | 关系 |
|---|---|---|
| **模型组合方案** | 可命名、可挂载、可编辑的有序模型条目集合（降级链）= Config 主体 | 1 : N 条目；可挂载到 group |
| **条目** | 组合方案里一个模型选择（provider+model+priority+可选时间条件） | N : 1 组合方案 |
| **条件** | item 级时间条件（白名单小时格 hours[]） | 0..1 : 1 条目 |
| **路由规则** | attempt 内对组合方案逐步求值的过程（时间过滤→熔断检查→按序尝试→退避决策）= f(config, state) | 组合方案的运行时行为 |
| **熔断状态机** | 每 **(planId, providerId, modelId)** 的服务健康三态（Closed/Open/HalfOpen），**挂方案实体维度** | Config 的运行时状态；同一方案多处挂载**共享**熔断状态 |
| **attempt state** | **agent loop 对「这一次 llm call」的状态**：候选处置轨迹（called/failed/abandoned/skipped 四态 + 失败原因 + 尝试次数 + 退避截止 + 游标）+ **bannedModels**（本次 call 被放弃/熔断的模型配置集合，v3.1），见 §2.1.1/§2.1.2 | call 级瞬时（不落盘）；决策输入 |

### 2.3 同模型条目约束校验（老板 D9，保存时硬拒绝）

- **模型标识** = `providerId + modelId` 复合（ModelRef，防同名歧义）。
- **校验规则**（组合方案内按模型分组）：
  1. 同模型**最多 2 个条目**（1 带时间 + 1 不带时间）；
  2. 同模型**不允许 2 个带时间**条目 → 保存硬拒绝；
  3. 同模型**不允许 2 个不带时间**条目 → 保存硬拒绝；
  4. **带时间条目必须排在不带时间条目上面** → 违反硬拒绝（提示「带时间条目必须在不带时间条目上面」）。
- **校验时机**：① 配置提交静态校验（保存硬拒绝 + 明确提示）；② 运行时防御（路由求值时发现违规纠正或告警）。
- 某模型只有带时间条目（无兜底）→ 时间不命中时该模型无候选；全部候选不满足 → 运行时「当前无可用模型」报错（**不隐式兜底**，老板 D4）。

## 3. 路由规则（resolve 下沉 attempt）

### 3.0 resolve 下沉 llm attempt 内部（老板架构讨论 ④）

**老板原话**：路由不是调用前 resolve 一次定死模型，而是 **attempt 执行循环内部逐步决策**——每次尝试失败后，基于当前 state 决定「下一个该调谁、sleep 多久」再继续。

```
旧模型（调用前定死）：
  resolveModel(session) → {providerId, modelId} 单模型 → llm 调用 → 失败上抛

新模型（attempt 内循环）：
  resolve(session, group) → 产出「方案或单模型」（分支 1/2，见 §1.0）
  attempt 循环：
    while (还有候选):
      next = f(config, state)   // 决策：时间过滤 → 熔断检查 → 候选游标 → 退避 sleep
      sleep(next.delay)          // 按错误类型/退避决策
      result = llmCall(next.item)
      state.record(result)       // 记录成功/失败 + 原因
      if (result.ok) break       // 收敛返回
    // 循环耗尽 → 上抛聚合错误（各条目失败原因摘要）
```

### 3.1 attempt 内路由循环（时间过滤第一步 + 同模型去重 + priority 0 合成 + bannedModels）

```
LLM 调用请求到来（agent 说「我要调用」）
  ↓
resolve(session, group)：
  ├─ group 无方案 → 分支 1：现有单模型（resolveModel 原链，零改动）
  └─ group 有方案 → 分支 2：
       ├─ session default → 候选链 = 方案 items（按 priority 升序）
       └─ session 显式模型 → 合成链 = [session 模型(priority 0)] + 方案 items
  ↓
attempt 循环（f(config, state)）：
  ① 时间过滤：当前小时 ∉ hours（带条件条目）→ 跳过，不入候选（不消耗尝试/不计熔断失败）
  ② enabled 检查：条目 enabled == false（停用）→ 跳过（记 skipped，老板 11:16 ①）
  ③ 熔断检查：该 (planId, providerId, modelId) 状态 == Open → 跳过（记 skipped）+ 加入 bannedModels
  ④ bannedModels 检查：item 的 providerId+modelId ∈ bannedModels → 跳过（记 skipped，v3.1）
  ⑤ 发起 LLM 调用（复用现有 LlmClient + 看门狗；失败按 §3.3 策略模型内重试 N 次）
     ├─ 成功 → record success → 熔断状态收敛 → 返回结果
     └─ 失败 → record failure（原因/类别）→ 按 §3.3 决定 sleep/降级/熔断
          └─ 若 abandoned（401/403 直接熔断、429 快速失败）→ 该模型配置加入 bannedModels
  ⑥ 循环耗尽 → 返回错误：
     ├─ 候选为空（时间过滤后无可用）→ 「当前无可用模型」（引导检查时间条件）
     └─ 全部失败/熔断 → 「所有候选模型不可用」（含各条目失败原因摘要）
```

**关键语义**：
- **时间过滤是路由第一步**（老板拍板）：不满足的条目**完全不参与**（不消耗尝试、不计熔断失败）。
- **停用条目直接跳过（老板 11:16 ①）**：`enabled == false` 的条目不参与路由（保留配置，可随时重新启用）；语义等同时间过滤跳过（不消耗尝试、不计熔断失败）。
- **同 attempt 内同模型去重（老板 D7 引申 + v3.1 强化为模型配置级）**：同一个 **provider+model 模型配置**在一次 attempt 内**只尝试一次**——**去重键 = 模型配置（providerId+modelId），不是 item**（老板 10:55 拍板）。带时间条目命中并尝试失败后，无条件条目（同模型）**不再尝试**（直接滑到下一个不同模型）；session 合成的模型（priority 0）与方案里同模型的条目也**共享同一去重**——session 模型被放弃/熔断后，方案里同模型的带时间/无条件条目全部 skipped。
- **bannedModels（老板 10:55 拍板）**：本次 call 内被**放弃（abandoned）或熔断（Open）**的模型配置集合；候选循环遇到 banned 模型直接 skipped——不管是 session 合成的、条件 item 还是无条件 item；**时间过滤跳过 ≠ 尝试失败**（不算，也不进 bannedModels，继续）。
- **priority 0 合成（老板架构讨论 ③）**：session 显式模型插入方案顶部（priority 0），**临时合成不写回方案实体**；熔断键 = planId + session 模型（享受方案熔断控制）。
- 与现有 `resolveModel` 的关系：分支 1 完全保留现有链（session → group 默认 → app 默认）；分支 2 的 resolve 只产出「候选链起点」，**逐步决策全在 attempt 循环内**（见 §3.0）。

### 3.2 熔断状态机（三态，cc-switch Hystrix 风格；挂方案实体三维）

```
       连续失败 ≥ failure_threshold  或 (total ≥ min_requests 且 error_rate ≥ error_rate_threshold)
Closed ─────────────────────────────────────────────────────────────► Open
  ▲                                                                      │
  │ 半开连续成功 ≥ success_threshold                                     │ timeout_seconds 到期
  │ ◄───────────────────────────────────────────── HalfOpen ◄───────────┘
                                                     │ 限流 1 探测请求
                                                     │ 探测失败 → 立即回 Open
```

| 状态 | 进入条件 | 行为 |
|---|---|---|
| **Closed（闭）** | 初始 / 半开连续成功 ≥ success_threshold | 全部放行 |
| **Open（开）** | 连续失败 ≥ failure_threshold **或**（total ≥ min_requests 且 error_rate ≥ error_rate_threshold）**或直接熔断错误（见 §3.3 表）** | 拒绝请求（该条目跳过） |
| **HalfOpen（半开）** | Open 后等待 timeout_seconds 到期 | 限流放行 1 个探测（真实用户请求）；失败 → 立即 Open；成功 → 计数，达 success_threshold → Closed |

**状态呈现 = 用户友好词（老板 11:16 ②，内部逻辑仍用熔断器）**：

| 内部熔断状态 | 用户呈现 | 说明 |
|---|---|---|
| Closed（熔断关闭，模型可用） | **🟢 正常** | 模型可用 |
| Open（熔断打开，模型不可用） | **🔴 异常**（带倒计时） | 显示 Open 剩余时间（timeout_seconds 倒计时） |
| HalfOpen（半开探测） | **🟡 观察中**（无倒计时） | 半开探测期，不显示倒计时 |

- **UI 呈现映射表为权威**：给用户看的是**状态词**（正常/异常/观察中），**不是熔断器词**（Closed/Open/HalfOpen）；熔断器三态仅内部逻辑使用。

**作用域（老板架构讨论 ①，细化 D5）**：熔断 = **「某个方案的某个模型」**——key = `(planId, providerId, modelId)` 三维；**方案 A 里 Kimi 熔断 ≠ 方案 B 里 Kimi 熔断**（方案间隔离）。组合方案是**可挂载实体**（group 挂载后生效），**同一方案多处挂载共享同一熔断状态**（一处降级全挂载点生效）；与现有 per-session health（ProviderHealthRegistry）分层共存（见 §4）。熔断状态 = **运行时内存态，不持久化**（Config 维度，见 §2.1）。

**参数默认值（老板 D6）**：failure_threshold=4 / success_threshold=2 / timeout_seconds=60 / error_rate_threshold=0.6 / min_requests=10（cc-switch 官方默认）。**可配置**（组合方案级覆盖，UI 收进「高级」可折叠区域）。

### 3.3 失败语义与重试策略（老板 D1：所有失败计入熔断 + 按错误类型差异化模型内重试）

**原则（老板 D1）**：**所有失败类型都计入熔断**（无论哪类错误，失败计数 +1）；但**同一模型配置内尝试几次按错误类型不同**——部分类型快速失败直接降级（如 429），部分类型直接触发熔断。

基于现有 `error_normalization.md` 的 LlmErrorCategory：

| 错误类别 | 模型内重试次数 | 熔断行为 |
|---|---|---|
| RATE_LIMITED（429） | **0（快速失败直接降级）** | 计失败；达阈值 → Open |
| PROVIDER_OVERLOADED（529） | **0（快速失败直接降级，避免加剧）** | 计失败；达阈值 → Open |
| NETWORK | 1（瞬态重试） | 计失败；达阈值 → Open |
| TIMEOUT_FIRST_CHUNK / TIMEOUT_INTER_CHUNK | 1（瞬态重试） | 计失败；达阈值 → Open |
| SERVER_ERROR（500/502/503） | 1（瞬态重试） | 计失败；达阈值 → Open |
| STREAM_INCOMPLETE | 1（瞬态重试） | 计失败；达阈值 → Open |
| EMPTY_RESPONSE | 1（瞬态重试） | 计失败；达阈值 → Open |
| MAX_TOKENS_TOO_HIGH | 1（降 maxTokens ×0.7 后重试，走现有 FIX_AND_RETRY） | 计失败；达阈值 → Open |
| AUTH_INVALID（401） | **0（快速失败）** | **直接熔断 Open**（key 失效短期不恢复；全部候选 AUTH 失败 → 上抛首个 AUTH 错误引导修凭证） |
| AUTH_FORBIDDEN（403） | **0（快速失败）** | **直接熔断 Open**（权限/地域禁短期不恢复） |
| CONTEXT_LENGTH_EXCEEDED | 0（快速失败；走现有压缩修复流程，压缩后重试成功不算路由失败） | 修复流程后再失败才计；达阈值 → Open |
| MAX_TOKENS_EXCEEDED | 0（快速失败；走现有 bump/prefill 流程） | 同上 |
| CONTENT_FILTERED / MODEL_NOT_FOUND / MALFORMED_TOOL_CALL / BAD_REQUEST_OTHER | **0（快速失败，请求/内容问题降级无意义）** | 计失败；达阈值 → Open（换模型可能不同结果） |
| ABORTED_BY_USER | 不算失败（用户中断） | 不计熔断，直接返回 |

> 模型内重试次数 = 换下一个模型前对同 (provider, model) 的尝试次数（走现有退避/看门狗）；重试耗尽后按表降级/熔断。超时沿用现有看门狗（TTFB 45s / stall 30/30/120，老板 D2 ✅）。**sleep 决策** = f(config, state)：同模型内重试走退避（backoff），换模型降级可 0 sleep 或短 sleep（决策细节 architect 定，保持可复现）。

### 3.4 半开探测与恢复

- **探测 = 真实用户请求**（cc-switch 同款，零额外成本）：HalfOpen 限流 1 并发探测；探测成功 → success 计数；连续 success_threshold 次 → Closed；探测失败 → 立即回 Open（重新计时）。
- 半开 permit 必须归还（防卡死，对齐 cc-switch `release_half_open_permit`）。
- 恢复即状态机收敛到 Closed；无独立健康探测任务（后续可按需加）。

## 4. 与现有体系的融合点（供 architect 深化）

| 现有机制 | 现状 | 融合方向 |
|---|---|---|
| `resolveModel`（model_resolve.md） | 产出单 {providerId, modelId}，fallback 链 = session → default → throw | **分支 1 保留现有链**；分支 2 的 resolve 产出「候选链起点」（方案或 priority 0 合成），**逐步决策下沉 attempt 循环**（§3.0/3.1） |
| `ProviderHealthRegistry`（per-session×per-model 4 态） | healthy/degraded/cooled_down/dead，session 隔离 | **分层共存**：现有 4 态管「同 session 内重试/冷却」；方案三态熔断（planId+providerId+modelId）管「方案级降级」。融合点 = attempt 循环先查方案熔断（Config），再查 session health（State 记录） |
| `retry_and_timeout.md`（退避 + 看门狗） | 同 provider 内重试（backoff + TTFB/stall 看门狗） | 保留：**模型内重试**（§3.3 次数）仍走现有机制；**sleep 决策**并入 attempt 循环 f(config, state) |
| `error_normalization.md`（分类 + hints） | LlmErrorCategory + shouldFallbackProvider 等 hints | **§3.3 策略表直接消费分类结果**；shouldFallbackProvider hint 即降级触发信号 |
| `app_config` | providers / default_models / llm_request 等 group | 新增 `model_routing_plans` group（方案库 CRUD）；group 挂载字段 |

## 5. 范围与已拍板决策

### 5.1 本次范围（第一期）

- ✅ 方案库配置（app 级 CRUD + 有序条目 + 白名单小时格时间条件 + 同模型条目硬校验 + **条目启用/停用开关**）
- ✅ 配置层级（session 只能配 model/default；group 挂方案或默认模型；暂 studio/playground）
- ✅ attempt 内路由循环（resolve 下沉：时间过滤 → 熔断检查 → 按序尝试 → sleep 决策 + 同模型去重 + priority 0 合成 + bannedModels + 停用跳过）
- ✅ Config/State 分离（决策 = f(config, state) 可复现）
- ✅ 三态熔断状态机（方案实体三维，组合方案级参数，UI 高级区；**用户呈现 = 🟢 正常 / 🔴 异常 / 🟡 观察中**）
- ✅ 设置 UI（方案库编辑 + group 挂载 + **成熟时间控件**）

### 5.2 后续（不做）

- ❌ 用量窗口路由（5h/7d quota 参与路由——需拉服务商 API，复杂度高，仅提示不做路由）
- ❌ 成本/延迟/负载感知路由（业界 LiteLLM/OpenRouter 有，rocky 一期不做）
- ❌ 熔断状态持久化（运行时内存态，重启丢失可接受，对齐 cc-switch 与 §2.1）
- ❌ attempt state 落盘（attempt 内临时记录，不落盘，§2.1）
- ❌ 独立健康探测任务（半开用真实请求）
- ❌ academy 方案支持（本期仅 studio/playground）

### 5.3 决策点（9 点 + 架构讨论全部已拍板）

| # | 决策点 | 拍板结论 |
|---|---|---|
| D1 | 失败语义 | **所有失败类型都计入熔断**；按错误类型差异化「模型内重试次数」——429/529/请求类/凭证类 **0 次快速失败**；网络/超时/5xx/流断/空响应 1 次重试；401/403 **直接熔断**（§3.3 策略表） |
| D2 | 超时参数 | ✅ 沿用现有看门狗（TTFB 45s / stall 30/30/120） |
| D3 | 时间条件 | **白名单模式（active）**、**每天重复**、**小时粒度**（24 格子勾选 0-23）；`TimeCondition = { hours: number[] }`；**不做 exclude、不做周几、不做分钟** |
| D4 | 无兜底 | ✅ 不隐式兜底，运行时报「当前无可用模型」 |
| D5 | 熔断维度 | **细化（架构讨论 ①）**：熔断 = 「某个方案的某个模型」（**planId+providerId+modelId 三维**）；方案 A 里 Kimi 熔断 ≠ 方案 B 里 Kimi 熔断；同一方案多处挂载共享熔断状态；运行时内存态不持久化 |
| D6 | 熔断参数默认 | ✅ 默认 4/2/60/0.6/10；可配置，UI 收进高级区域（可折叠） |
| D7 | 团队覆盖 | ✅ session 显式 → 团队引用 → app 默认；**同一次 attempt 内同 provider+model 只尝试一次**（去重，时间过滤跳过 ≠ 尝试失败） |
| D8 | 时间粒度 | 已回答（同 D3：每天 + 小时 24 格） |
| D9 | 同模型条目校验 | 同一个模型**最多 2 个条目（1 带时间 + 1 不带时间），带时间条目必须在不带时间条目上面；同模型不允许 2 带时间 / 2 不带时间（保存硬拒绝）** |
| D10 | 配置层级（架构讨论 ②） | session **只能配 model/default**（不能配方案）；group/playground **可配方案或默认模型**（暂 studio/playground 默认可用方案）；app 级 = **方案库（CRUD）** |
| D11 | resolve 产出（架构讨论 ③） | 无方案 → **分支 1 现有单模型**；有方案 → **分支 2**：session default 直接走方案链 / session 显式模型 = **priority 0 合成插入方案顶部**（临时，不写回；熔断键 = planId + session 模型） |
| D12 | resolve 下沉（架构讨论 ④） | **attempt 执行循环内部逐步决策**：每次失败后基于当前 state 决定「下一个调谁、sleep 多久」再继续；非调用前 resolve 定死 |
| D13 | Config/State 分离（架构讨论 ⑤ + 10:52/10:53 细化） | **Config** = 静态定义（方案 + 熔断状态，挂方案维度，**跨 call 共享存活**）；**State** = **agent loop 对「这一次 llm call」的状态**（候选处置轨迹：called/failed/abandoned/skipped 四态 + 失败原因 + 尝试次数 + 退避截止 + 游标，**call 级瞬时不落盘**）；决策 = f(config, state) 可复现；对 agent 透明 |
| D14 | 放弃/熔断挂钩模型配置（老板 10:55，v3.1） | **放弃或熔断与「模型配置」挂钩，不是与配置 item 挂钩**——同一个模型在一次 attempt 内可能以多个 item 出现（session 合成 + 带时间条件 + 无条件）；一旦该模型配置被放弃（abandoned）或熔断（Open），本次 attempt 内后续所有该模型的 item 全部跳过（skipped）。机制 = AttemptState.bannedModels（providerId+modelId 集合），见 §2.1.2 |
| D15 | 条目启用开关（老板 11:16 ①，v3.2） | 每个条目加 `enabled`（默认 true）；**可关闭但不删除**（停用保留配置）；停用条目路由时直接 skipped（等同时间过滤跳过：不消耗尝试/不计熔断失败）；同模型条目约束按启用条目统计 |
| D16 | 状态呈现 = 用户友好词（老板 11:16 ②，v3.2） | 内部逻辑仍用熔断器三态（Closed/Open/HalfOpen）；UI 呈现映射：Closed → **🟢 正常** / Open → **🔴 异常**（带倒计时）/ HalfOpen → **🟡 观察中**（无倒计时）；给用户看状态词，不给熔断器词 |
| D17 | 时间控件选型（老板 11:16 ③，v3.2） | **用成熟现成组件**（24 格小时拖拽式时间段选择器或等效交互），不自己造轮子；选型标准：拖拽连续段 / 多段加选 / 清空=全天 / hover 提示；输出仍是 `{ hours: number[] }`；具体组件架构阶段定 |

## 附：设计依据

- cc-switch：failover queue（sort_index + in_failover_queue）、三态熔断（circuit_breaker.rs）、max_attempts=retries+1、无时间条件（notes 仅备注）
- 业界：LiteLLM order/fallbacks/cooldown、OpenRouter provider.order、Portkey retry+fallback+breaker 三层分工；时间条件无内建先例（Inworld/Bifrost 用 CEL 表达式）
- 老板拍板 10:24：时间条件挂 item、窗口内可用/窗口外下滑；不配置=随时可用；同模型最多 2 条目
- 老板 9 点反馈 10:40：D1-D9 全部拍板
- 老板架构讨论 10:49-10:52：熔断三维隔离 / 配置层级四级 / resolve 双分支 + priority 0 合成 / resolve 下沉 attempt / Config-State 分离
- 老板 10:52 补充：State = agent loop 对「这一次 llm call」的状态（call 级瞬时，非跨 call 全局）；熔断状态属 Config（跨 call 共享）
- 老板 10:53 补充：State 内容 = 候选处置轨迹（called/failed/abandoned/skipped 四态 + 失败原因 + 尝试次数 + 退避截止），数据结构见 §2.1.1
- 老板 10:55 补充（v3.1）：放弃/熔断挂钩「模型配置」维度（providerId+modelId 复合键），非 item；bannedModels 机制见 §2.1.2
- 老板 11:16 三点反馈（v3.2，demo 后拍板 go）：条目启用开关（enabled）/ 状态呈现用户友好词（🟢🔴🟡）/ 时间控件用成熟现成组件（选型标准见 §1.5）
