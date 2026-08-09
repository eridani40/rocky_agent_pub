# v0.0.279 PRD — 团队默认推理强度（squad 级 default effort）

- **版本号**: v0.0.279
- **版本主题**: 团队默认推理强度（squad 级 default effort）
- **需求文件**: `reqs/[working] v0.0.279/req.md`（老板逐条拍板定稿）
- **工作目录**: `worktrees/0.0.279-squad-default-effort`
- **类型**: 用户可感知功能变化（团队管理 UI + 覆盖链行为）→ 完整 PRD

---

## 1. 背景

### 1.1 现状

- **成员级 effort 已有**（v0.0.148）：`session.effort` 4 档 canonical 语义键 `'default'|'low'|'high'|'max'`，成员可在聊天输入框 effort picker 设置，写 `PUT /session/:id {effort}`，持久化到 session。
- **effort 传递链**：`session.effort` → `buildSessionConfigFromDeps`（handlers/session-config.ts）注入 `config.effort` → `callLLMForSpec`（loop-stage-llm.ts L103-105）透传 `CallLLMInput.effort` → `callLLMViaInvoker baseReq.params.effort` → `encodeAnthropicMessages`（guard：`params.effort !== undefined && !== 'default'` 才注入 `output_config.effort`，映射 EFFORT_WIRE_MAP 同名 low/high/max）。
- **'default' 语义**：= 厂商默认行为（encode 不注入 output_config，等价未挂 effort）。
- **团队级（squad）无 effort 配置**：squad 实体有 `modelDefault`（默认模型，required）+ `modelDefaultProviderId`（optional）+ `enableGroupChat`（optional），但没有「默认推理强度」概念。

### 1.2 痛点

- 团队 leader 想让整个团队的成员（尤其 mate 执行者）默认用较高推理强度跑任务，但当前只能逐个成员手动设置 session.effort——成员没设（'default'）就回落厂商默认，无法统一团队口径。
- 老板拍板：增加 **squad 级默认推理强度**，覆盖链两层：成员显式设置 > 团队默认 > 厂商默认。

### 1.3 老板裁决（req.md 定稿，4 条）

1. **覆盖链**：成员 `session.effort='default'` → 用团队默认推理强度；团队 `='default'` → 厂商默认（不注入 output_config）。就两层，无更上层。
2. **候选值**：含「默认」——团队可 override（low/high/max）也可不动（默认）。
3. **存储**：squad 实体加字段，与默认模型（modelDefault）同处。
4. **UI**：团队管理「默认模型」附近加下拉，候选 = 默认 / low / high / max。
5. **resolve 时机与 model 一致**：每次请求/创建 run 时 resolve；给 LLM 时已 resolve 完，**encode 层零改动**。

---

## 2. 核心决策

### D1. 覆盖链（两层，老板拍板）

```
生效 effort = 成员显式档位（session.effort ∈ {low,high,max}）
            ? 成员档位
            : 团队默认（squad.effortDefault ∈ {low,high,max}）
              ? 团队档位
              : undefined（= 厂商默认，encode 不注入 output_config）
```

- 成员 `session.effort === 'default'`（含未设置 = lazy 缺省 'default'）→ 看团队。
- 团队 `effortDefault === 'default'` 或未设置（存量 squad 无字段）→ 归一 undefined，encode 走厂商默认。
- 归一为 undefined 而非保留 'default'：语义等价（encode guard `!== 'default'` 已处理），但 resolve 结果更干净（下游 config.effort 只有 low/high/max/undefined）。

### D2. 存储：squad schema 加 `effortDefault` 字段

- 字段：`effortDefault?: 'default'|'low'|'high'|'max'`（optional，兼容存量 squad 无字段 = undefined = 'default' 语义）。
- 位置：`schema_defs/squad/squad.ts`，与 `modelDefault` / `modelDefaultProviderId` / `enableGroupChat` 同处。
- 命名：对齐 `modelDefault` 的「X + Default」模式（modelDefault 是 model+Default；effortDefault 是 effort+Default）。
- 创建（POST /squad）：optional，不传不落（undefined = 'default' 语义）。
- 更新（PATCH /squad/:id）：`effortDefault?`，`!== undefined` 才 patch；显式写 'default' 也存 'default' 字面量（resolve 时与 undefined 同语义，但回显/编辑更直白）。
- 回显（SquadDetail）：`effortDefault ?? 'default'`（UI 下拉始终有值可显示；与 enableGroupChat ?? true 模式一致）。

### D3. resolve 位置：buildSessionConfigFromDeps（与 model resolve 同处）

- `handlers/session-config.ts` 已收 `studioContext` 参数（L62，含 squad），model 的 resolveModel 也在该函数内（L89-99）。
- effort 注入点（L323-324 现为 `...(sessionPersist.effort !== undefined ? { effort: sessionPersist.effort } : {})`）改为 resolve 后值：
  - 读 `sessionPersist.effort`；非 'default' → 用之；
  - 否则读 `studioContext?.squad?.effortDefault`（studio 分支；playground/academy 无 squad → 走原逻辑不变）；
  - 非 'default' → 用之；否则 → undefined（不注入）。
- 与 model resolve 同一时机：每次 `resolveConfigBySid`（agent-manager.ts L133）在 enqueue/activate/deliverTo 时现拉最新 session + squad 持久字段，无 cache → 团队改设置后**下一次 run 立即生效**。
- **encode 层零改动**：resolve 完 config.effort 已是 low/high/max/undefined，下游传递链（loop-stage-llm → CallLLMInput → callLLMViaInvoker → encodeAnthropicMessages）原样工作。

### D4. UI：ManageTab 默认模型附近加下拉

- 位置：`component-manage-tab.tsx` 管理 tab 的 modelDefault（ModelPicker 复合 ModelSelection）下方，加「默认推理强度」下拉。
- 候选 4 档：默认（'default'）/ low / high / max。
- 交互：本地 state `effortDefaultSel`（初值 = SquadDetail.effortDefault ?? 'default'），dirty 判定纳入现有保存流程，save → PATCH /squad/:id `{effortDefault}`。
- i18n：en/zh-CN `studio.json` manageTab keys 追加（effortDefault label + 4 档选项文案）。
- 组件 spec：`specs/ui/components/studio-page/` 下管理 tab 相关 spec 同步（若有 component-manage-tab spec 则更新；无则记入 06-studio.md §3.2）。

---

## 3. 功能需求

### 3.1 团队默认推理强度配置（新功能）

| # | 需求 | 说明 |
|---|------|------|
| F1 | 团队管理 tab 增加「默认推理强度」下拉 | 在默认模型（ModelPicker）附近；候选 = 默认 / low / high / max |
| F2 | 保存走 PATCH /squad/:id | `effortDefault` 字段；显式写 'default' 也落盘 |
| F3 | SquadDetail 回显 | `effortDefault ?? 'default'`；编辑时下拉显示当前团队档位 |
| F4 | 存量 squad 兼容 | 无字段 → 下拉显示「默认」→ 行为 = 厂商默认（不注入） |

### 3.2 覆盖链生效（行为变化）

| # | 场景 | 生效 effort | wire 注入 |
|---|------|------------|-----------|
| F5 | 成员 default + 团队 low/high/max | 团队档位 | `output_config.effort` = 团队档位 |
| F6 | 成员 default + 团队 default/未设置 | undefined（厂商默认） | 不注入 |
| F7 | 成员 low/high/max（任何团队档位） | 成员档位（覆盖团队） | `output_config.effort` = 成员档位 |
| F8 | 团队改档位 | 下一次 run 立即生效 | 无 cache，resolveConfigBySid 现拉 |

### 3.3 非 studio 分支不变

- playground / academy / standalone：无 squad → 只走 session.effort 一层（现状不变）。
- subagent：继承父 session 的 resolve 结果（config 已 resolve 完，subagent 不重复 resolve effort）。

---

## 4. 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 打开团队管理 tab → 默认模型下方看到「默认推理强度」下拉（默认/low/high/max）→ 选 low → 保存 | PATCH /squad/:id 成功；刷新后下拉显示 low |
| UC-2 | 团队设 low → 某成员 session.effort='default' → 成员发起对话/run | LLM 请求注入 `output_config.effort=low`（成员回落团队默认） |
| UC-3 | 团队设 low → 某成员 session.effort='max' → 成员发起对话/run | LLM 请求注入 `output_config.effort=max`（成员覆盖团队） |
| UC-4 | 团队默认（'default'）→ 成员 default → 成员发起对话/run | LLM 请求**不注入** output_config（厂商默认） |
| UC-5 | 团队默认 → 成员 low → 成员发起对话/run | LLM 请求注入 `output_config.effort=low`（成员层生效） |
| UC-6 | 存量 squad（无 effortDefault 字段）→ 打开管理 tab | 下拉显示「默认」；成员 default 时行为 = 厂商默认（兼容，无回归） |
| UC-7 | 团队从 low 改为 max → 成员（default）立即发起新 run | 新 run 的 LLM 请求注入 `output_config.effort=max`（无 cache，即时生效） |

---

## 5. 概念对齐（specs/ui + specs/tech）

| 概念 | 位置 | 关系 |
|------|------|------|
| session.effort 4 档 canonical | `llm_protocol_interface.md` §3.8 / protocol.ts L53-59 / session schema | 现有成员级概念，本版本不改语义 |
| squad.modelDefault | `schema_defs/squad/squad.ts` L35-42 / UI 06-studio.md §3.2 | effortDefault 对齐其存储位置与 UI 附近 |
| resolveModel fallback 链 | `services/model-resolver.ts`（studio → squad.modelDefault） | effort resolve 对齐其时机（buildSessionConfigFromDeps 内） |
| buildSessionConfigFromDeps | `handlers/session-config.ts`（studioContext 参数 L62） | 唯一注入点，effort resolve 落此 |
| InputEffortPicker | `chat-page/component-input-effort-picker.tsx` | 成员级 effort UI（现状不动）；团队下拉为独立简单控件 |

**新概念**：`squad.effortDefault`（团队默认推理强度）——先落 specs/tech（squad schema）+ specs/ui（管理 tab），本 PRD 引用。

---

## 6. 边界 / 不做

- ❌ 不改 effort canonical 语义 / encode 映射（EFFORT_WIRE_MAP）——零改动。
- ❌ 不加第三层覆盖（如 app_config 级 effort 默认）——老板拍板就两层。
- ❌ 不改成员级 effort picker UI（chat-page InputEffortPicker 现状不动）。
- ❌ 不做 squad 级 effort 的权限控制（任何能进管理 tab 的人可改；与 modelDefault 同权限模型）。
- ❌ 不做团队 effort 变更的历史记录/审计。
- ❌ playground / academy 不引入团队默认（无 squad 概念）。

---

## 7. 验收口径

### 能力不变量
- [ ] 团队管理 tab 有「默认推理强度」下拉（默认/low/high/max），保存后回显。
- [ ] 覆盖链 F5-F8 全部成立（成员 default → 团队生效；团队 default → 不注入；成员显式 → 覆盖）。
- [ ] 存量 squad 无字段 → 下拉显示「默认」+ 行为厂商默认（无回归）。

### 回归不变量
- [ ] 成员显式 effort（low/high/max）行为与 v0.0.148 完全一致（不因团队设置改变）。
- [ ] playground 会话 effort 行为不变（无 squad，仅 session 一层）。
- [ ] encode 层零改动（diff 不含 llm/protocol.ts 的 encode 逻辑）。

### 布局稳定性
- [ ] 下拉加入不导致管理 tab 其他元素位移（复用现有 form 行布局）。

---

## 8. 测试建议

- **UT（主要）**：
  - session-config 单测：resolve 覆盖链 4 分支（成员显式 / 成员 default+团队 low / 成员 default+团队 default / 成员 default+团队未设置）→ config.effort 断言。
  - squad-service 单测：PATCH effortDefault 落盘 + SquadDetail 回显（?? 'default'）。
  - 前端 manage-tab 单测：下拉渲染 + dirty/save 流。
- **AT/ET**：按核心冒烟集纪律**不新增持久 case**——effort 覆盖链是确定性配置行为（非 LLM 不确定性），UT 覆盖足够；聊天主链路回归现有 send-message case 即可。

---

## 9. 版本总结

- **新增**：squad.effortDefault（团队默认推理强度，4 档含 'default'），管理 tab 下拉配置，覆盖链 resolve（成员显式 > 团队默认 > 厂商默认）。
- **改动面**：squad schema + squad-service（create/patch/detail）+ handlers/session-config.ts（effort resolve）+ 前端 manage-tab + i18n + API spec（PatchSquadBody/SquadDetail）+ specs 同步。
- **零改动**：encode 层 / effort canonical 语义 / 成员级 effort UI / playground 行为。
- **兼容**：存量 squad 无字段 = 'default' 语义，行为不变。
