# v0.0.26 PRD 变更日志

## 概述

本版本 = **ext-impl 配置加 `scope` 维度（plugin-by-scope）**。给 ext-impl **配置层**引入正交维度 `scope`（agent loop 风格维度），动机是未来不同 agent loop 风格可通过 scope 切换不同 impl 配置（开关/顺序/configValues），单一配置无法支撑。

一句话：**ext-impl 配置层加 `scope` 维度（正交于 EP.group）；`default` scope 全 EP 永远激活为基线，其他 scope 按 EP 粒度激活（激活初始值复制 default 后独立）；保留旧接口 `getExtensionImpls(point)` 向后兼容 + 新增带 scopeId 重载（per-EP 回退）；scope 是一等实体可 CRUD；UI 扩展点 tab 顶层加 scope 切换器。**

权威输入：
- `reqs/v0.0.26/req.md`（用户原文）
- `states/user_query.md` v0.0.26 段（多轮对齐的最终决策，权威不得改动）

spec 权威源（本版本**引入新概念 `scope`**）：
- tech 现有：`specs/tech/config/[P0]plugin_config.md`（`ExtImplConfigRecord` keyed by implId）+ `specs/tech/config/[P0]plugin_config_service.md`（PluginConfigService 管理面 + inventory）+ `specs/tech/plugin_system/[P0]plugin_manager_interface.md`（`getExtensionImpls(point)` 单参）+ `specs/tech/plugin_system/[P0]extension_point_interface.md`（`ExtensionPoint.group` 必填，功能分区，仅展示不读运行时）
- ui 现有：`specs/ui/components/plugin-config-page/page-plugin-config.md`（2 tab）+ `section-ext-point-area.md`（2 栏：group 列表 + ext point 区）+ `common/section-group-list.md`（通用 group 列表）

**新概念 `scope` 需架构阶段落 `specs/tech/config/` + `specs/ui/`**（见 §5），PRD 只描述产品行为不发明实现细节。

---

## 1. 版本定位

### 1.1 scope 是什么 / 为什么 / 与 EP.group 的区别

| 维度 | `ExtensionPoint.group`（已有，不动） | `scope`（v0.0.26 新增） |
|------|--------------------------------------|------------------------|
| 归属 | EP 固有属性（声明期确定，必填 string） | ext-impl **配置层**维度（运行时可切） |
| 语义 | **功能分类**（provider/context/web） | **agent loop 风格**（default/release/custom…） |
| 正交 | 与 enabled/order 无关 | 与 group 完全正交，与 enabled/order/configValues **绑定**（每 scope 独立一份） |
| 运行时 | 不读 group（只 UI 分区） | `getExtensionImpls(point, scopeId)` per-EP 按 scope 取配置 |
| 取值 | snake_case 字符串常量 | scope 一等实体（id/name/description/createdAt），动态可创建 |
| 默认 | EP 声明即定 | `default` 常驻基线（不可删），其他 scope 动态创建 |

**为什么需要 scope**：未来不同 agent loop 风格（如「快速对话」vs「深度推理」）希望用不同的 prompt builder 组合 / 不同的 context reducer 链 / 不同的 provider 选择。单一配置（现状）无法支撑——切风格必须改 default 配置，丢掉原配置。引入 scope 后，每个 scope 独立配置一份，运行时按 scopeId 取，互不干扰。

**核心模型（与用户对齐，严禁改动语义）**：
- **per-EP 继承 + 激活**：`default` scope 全 EP 永远激活（基线，不可取消）；其他 scope 每 EP 默认未激活（UI 灰显 = 继承 default），按 **EP 粒度**激活；**激活初始值复制 default**（snapshot 后独立，default 改动不传导到已激活 EP）；支持取消激活回退继承 default
- **运行时 per-EP 回退**：`getExtensionImpls(point, scopeId)` 对该 EP：激活 → 取 scope 配置；未激活 → 回退 default 配置
- **scope 一等实体**：独立存储（id/name/description/createdAt），可动态创建；default 常驻不可删；release 等 scope 可预创建；非 default scope 可删（cascade 清其 per-EP 配置）
- **调用方自决 scope**：调用方（agent loop）自己决定用哪个 scopeId，**本版本不做 scope 选择逻辑**（如「按 session 类型自动选 scope」）

### 1.2 范围

**IN（v0.0.26）**：

| # | 方向 | 范围 |
|---|------|------|
| F1 | **scope 一等实体 + CRUD** | scope 独立存储（id/name/description/createdAt），可动态创建；default 常驻不可删；非 default 可删（cascade 清 per-EP 配置）；release 等可预创建 |
| F2 | **ExtImplConfigRecord 加 scope 维度** | 逻辑 key `implId` → `(scopeId, implId)`；现有记录 migrate `scope=default` |
| F3 | **per-EP 继承 + 激活模型** | default 全 EP 永远激活（不可取消）；其他 scope 每 EP 默认未激活；按 EP 粒度激活；激活初始值复制 default（snapshot 后独立）；支持取消激活回退继承 |
| F4 | **运行时双接口** | 保留 `getExtensionImpls(point)`（≡ default，向后兼容）；新增 `getExtensionImpls(point, scopeId)`（per-EP 回退：激活→取 scope 配置，否则回退 default） |
| F5 | **inventory + PluginConfigService 适配** | inventory 支持 scope 维度返回（按 scopeId 给 ext impl 的 enabled/order/configValues）；PluginConfigService 写操作支持 scope 维度（setImplEnabled/setExclusive/setPointOrders/setImplConfig 带 scopeId）+ scope 激活/取消激活 op |
| F6 | **UI 顶层 scope 切换器** | 扩展点 tab 顶层加 scope 切换器；切 scope 后每 EP 下 impl 开关/顺序/configValues 展示该 scope 配置；default 全亮、其他 scope 未激活 EP 灰显（继承 default 提示）+ 激活/取消激活交互 |

**OUT（本版本明确排除）**：

| 排除项 | 理由 |
|--------|------|
| scope 选择逻辑（调用方按什么规则决定 scopeId） | 用户明确「调用方自决」，本版本只提供 scope 维度与读取能力，agent loop 怎么选 scope 留后续版本 |
| scope 级 plugin 级配置（PluginConfigRecord 加 scope） | 仅 ext-impl 配置层加 scope；plugin 级 enabled/config 不分 scope（plugin 启用是全局开关，scope 只影响 impl 选择） |
| scope 模板/继承链（scope A 继承 scope B） | 用户对齐模型只有「其他 scope 继承 default」一级，不做多级继承 |
| scope 跨 EP 批量激活 | 激活是 per-EP 粒度（与「per-EP 继承」对齐），不做「一键激活全部 EP」 |
| 视觉保真度比对 | 本版本无设计稿（hasDesign=false），视觉保真度门禁跳过 |

### 1.3 关键决策记录（orchestrator 代决 — AFK 授权）

| 决策 | 选择 | 出处 |
|------|------|------|
| 命名 | `scope`（避撞 EP.group 改名，原称 group） | user_query v0.0.26 |
| 继承粒度 | per-EP（每 EP 独立激活/继承，非整 scope） | user_query v0.0.26 |
| 激活初始值 | 复制 default 的当前快照（snapshot 后独立，default 改动不传导） | user_query v0.0.26 |
| 回退语义 | 取消激活 → 该 EP 回退继承 default（运行时取 default 配置） | user_query v0.0.26 |
| 双接口 | 保留 `getExtensionImpls(point)` ≡ default（向后兼容）+ 新增带 scopeId 重载 | user_query v0.0.26 |
| scope 删除 | 非 default 可删，cascade 清 per-EP 配置；default 不可删 | user_query v0.0.26 |
| scope 选择逻辑 | 不做（调用方自决） | user_query v0.0.26 |
| 流程 | 跳过 refs/ 调研（内部演进，Explore 已摸底）；全自动开发 | user_query v0.0.26 + task.json |

---

## 2. 功能点清单

> 本节是产品行为描述。**scope 的数据模型/存储/接口实现细节由 architect 落 `specs/tech/config/`，scope 切换器组件 spec 由架构/coder 落 `specs/ui/components/`**（见 §5），PRD 不发明。

### 2.1 F1 — scope 一等实体 + CRUD

**产品行为**：
- scope 是独立实体，字段：`id`（唯一标识）/ `name`（显示名）/ `description`（说明）/ `createdAt`（创建时间）
- `default` scope 常驻、不可删、不可改 id；系统初始化即存在
- 其他 scope 可动态创建（用户提供 name/description）；release 等 scope 可由系统预创建
- 删除非 default scope → cascade 清除其所有 per-EP 配置（激活记录 + 该 scope 下 ExtImplConfigRecord）
- 删除 default scope → 拒绝（UI 不提供删除入口或后端拒绝并提示）

**约束**：scope 实体存储细节（entity/落盘形态）属架构层，PRD 不规定。CRUD 接口形态属 API 层。

### 2.2 F2 — ExtImplConfigRecord 加 scope 维度

**产品行为**：
- `ExtImplConfigRecord` 逻辑 key 由 `implId` 扩展为 `(scopeId, implId)`
- 同一 impl 在不同 scope 下可有不同的 `enabled` / `order` / `configValues`
- **现有记录 migrate**：升级时把所有现存 `ExtImplConfigRecord` 标记 `scope=default`（无数据损失，default 行为不变）
- migrate 后 `getExtensionImpls(point)` 行为与升级前一致（≡ default scope）

**约束**：migrate 策略（一次性脚本 / 启动时 lazy / 落盘格式）属架构层。PRD 只要求「升级后行为不变 + 现有数据归属 default」。

### 2.3 F3 — per-EP 继承 + 激活模型

**产品行为**（核心，与用户对齐严禁改动）：

| 主体 | 默认态 | 激活 | 取消激活 |
|------|--------|------|---------|
| `default` scope 的每个 EP | 永远激活（基线，不可取消） | N/A（已激活） | 不允许（default 是基线） |
| 其他 scope 的每个 EP | 未激活（继承 default，UI 灰显） | 用户在 UI 点「激活此 EP」→ **初始值复制 default 当前快照**（snapshot 后独立，default 后续改动不传导） | 用户点「取消激活」→ 删除该 scope 此 EP 的激活记录 + per-EP 配置 → 回退继承 default |

**激活初始值复制 default 的语义**：
- 激活瞬间，把 default scope 下该 EP 的所有 impl 的 `enabled` / `order` / `configValues` 复制一份到当前 scope（snapshot）
- 复制后该 scope 此 EP 独立；default 后续改动不传导到已激活的 EP（snapshot 隔离）
- 取消激活 = 删除该 scope 此 EP 的所有 per-EP 配置（含激活记录），运行时回退取 default

**运行时 per-EP 回退（F4 接口语义基础）**：对 `getExtensionImpls(point, scopeId)`：
- `scopeId === 'default'` → 取 default 配置（永远激活）
- `scopeId !== 'default'`：此 EP 已激活 → 取该 scope per-EP 配置；未激活 → 回退取 default 配置（per-EP 粒度回退，非整 scope）

**约束**：「激活记录」的数据结构（是单独 entity 还是 ExtImplConfigRecord 的派生）属架构层。PRD 只要求：能区分「该 scope 此 EP 是否激活」+「激活时复制 default 快照」+「取消激活清配置回退」。

### 2.4 F4 — 运行时双接口

**产品行为**：
- **保留旧接口** `getExtensionImpls(point): T[]`：行为 ≡ `getExtensionImpls(point, 'default')`，**完全向后兼容**（现有调用方零改动）
- **新增重载** `getExtensionImpls(point, scopeId): T[]`：按 §2.3 的 per-EP 回退规则解析（激活→scope 配置，否则 default 配置）
- 两个接口共享 cardinality 解析逻辑（exclusive/list/ordered，见 `plugin_manager_interface.md` §2，effective order 算法不变，只是 order 源从「单份」变「按 scope 取」）
- 两级 enabled 门（plugin.enabled ∧ impl.enabled）不变；plugin 级 enabled 不分 scope（全局），impl 级 enabled 按 scope 取

**约束**：TS 重载签名 / scopeId 默认值 / cardinality 解析内部如何按 scope 取 order 属架构层。PRD 只要求「旧接口行为不变 + 新接口 per-EP 回退」。

### 2.5 F5 — inventory + PluginConfigService 适配

**产品行为**：
- `PluginConfigService.inventory()` 支持 scope 维度：可按 scopeId 返回该 scope 下 ext impl 的 enabled/order/configValues（默认返回 default，与现状一致；带 scopeId 参数返回该 scope 视图）
- inventory 还需返回每个 EP 在该 scope 的激活状态（已激活/继承 default）+ 该 scope 下所有 EP 的激活信息（供 UI 灰显）
- 写操作支持 scope 维度（带 scopeId 参数）：`setImplEnabled(implId, enabled, scopeId?)` / `setExclusive(implId, scopeId?)` / `setPointOrders(pointId, orders[], scopeId?)` / `setImplConfig(implId, values, scopeId?)`
  - `scopeId` 缺省 = `default`（向后兼容）
  - 对未激活 EP 写操作的处理：架构层定（PRD 倾向「自动激活 + 复制 default 快照 + 应用写入」，但实现细节不强制）
- 新增 scope 激活/取消激活 op：`activateEp(scopeId, pointId)`（复制 default 快照）/ `deactivateEp(scopeId, pointId)`（清配置回退）
- 新增 scope CRUD op：`createScope(name, description?)` / `deleteScope(scopeId)`（cascade 清配置）/ `listScopes()`

**约束**：具体方法签名 / scopeId 参数位置 / 写未激活 EP 的语义属架构层。

### 2.6 F6 — UI 顶层 scope 切换器

**产品行为**：
- 扩展点 tab **顶层**（在现有「group 列表 + ext point 区」两栏之上）加 **scope 切换器**
- scope 切换器展示当前选中 scope（默认 default），可下拉/切换到其他 scope，可创建新 scope，可删除非 default scope
- 切 scope 后，下方每 EP 下 impl 的 enabled/order/configValues 展示**该 scope** 的配置
- **default scope**：全 EP 永远激活，所有 impl 开关可操作（全亮）
- **其他 scope**：
  - 未激活 EP → 灰显（impl 开关/order/configValues 不可操作）+ 显示「继承 default」提示 + 提供「激活此 EP」按钮
  - 已激活 EP → 正常显示该 scope 配置（impl 开关/order/configValues 可操作）+ 提供「取消激活」按钮
- 激活 EP 时（用户点「激活此 EP」）→ 后端复制 default 快照 → UI 刷新显示该 scope 独立配置（可改）
- 取消激活 EP 时（用户点「取消激活」）→ 确认后清配置回退 → UI 刷新灰显继承 default

**布局稳定性**（MANDATORY，遵循 `_conventions.md`）：
- 「激活此 EP」/「取消激活」按钮的出现/消失**不得导致其他元素位移**——用预留固定空间（`visibility: hidden` / `opacity: 0`）或绝对定位，禁止 `display: none` + 常规流导致相邻元素跳动
- scope 切换器位置固定，切换 scope 不改变切换器自身位置

**约束**：scope 切换器的组件 spec（命名、Props、testid、视觉基线）由架构/coder 阶段落 `specs/ui/components/plugin-config-page/`（新组件，见 §5）。PRD 只描述交互行为。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

> 每条路径至少一个 API/E2E case。

| ID | 路径 | 覆盖功能 |
|----|------|---------|
| P1 | 调用 `getExtensionImpls(point)`（无 scopeId）→ 返回 ≡ default 配置（向后兼容） | F4 |
| P2 | 系统升级（migrate）→ 现有 `ExtImplConfigRecord` 全部标记 `scope=default` → `getExtensionImpls(point)` 行为与升级前一致 | F2 |
| P3 | 创建新 scope S → 切到 S → 所有 EP 灰显（继承 default）→ 调 `getExtensionImpls(point, S)` 行为 ≡ default | F1+F3+F4 |
| P4 | 在 scope S 激活某 EP E（初始值复制 default）→ 改 E 下某 impl 的 enabled/order/configValues → 调 `getExtensionImpls(E, S)` 取 S 自定义配置；调 `getExtensionImpls(其他EP, S)` 仍取 default（其他 EP 未激活回退） | F3+F4+F5 |
| P5 | 在 scope S 取消激活 EP E → 清 E 的 per-EP 配置 → 调 `getExtensionImpls(E, S)` 回退取 default | F3+F4 |
| P6 | 删除非 default scope S → cascade 清 S 的所有 per-EP 配置 → S 不再可取；default 不受影响；删除 default scope → 拒绝 | F1 |
| P7 | UI：打开扩展点 tab → 顶层 scope 切换器可见，当前=default，全 EP 全亮可操作 → 切到 scope S → 未激活 EP 灰显+「继承 default」+「激活此 EP」按钮；已激活 EP（若有）正常显示+「取消激活」按钮 | F6 |
| P8 | UI：scope S 下点「激活此 EP E」→ 后端复制 default 快照 → UI 刷新 E 显示 S 独立配置（可改 enabled/order/configValues）→ 改后调 `getExtensionImpls(E, S)` 反映改动 | F3+F5+F6 |

### E2E Use Cases（按功能章节）

**F4 — 运行时双接口**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-F4-1 | （API）调 `getExtensionImpls(ContextEnginePoint)` 无 scopeId → 与升级前返回一致（同一 impl 列表、enabled、order） | 向后兼容，旧调用方零改动 |

**F1+F3+F4 — scope 创建 + 继承 + 回退**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-F134-1 | （API）createScope(name="custom") → 切 scopeId=custom → 调 `getExtensionImpls(point, custom)` 多个 EP | 所有 EP 返回 ≡ default（继承，未激活回退）；custom scope 无独立配置 |
| UC-F134-2 | （API）scope=custom 激活 EP `context_engine` → 该 EP 返回 custom 配置（初始=复制 default）；其他 EP 仍回退 default | per-EP 粒度激活+回退正确 |

**F3 — 激活初始值复制 default + 隔离**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-F3-1 | （API）scope=custom 激活 EP E（初始复制 default）→ 在 default 改 E 某 impl order → 调 `getExtensionImpls(E, custom)` | custom 的 E 配置不变（snapshot 隔离，default 改动不传导） |
| UC-F3-2 | （API）scope=custom 激活 EP E → 改 custom E 的 impl enabled → 取消激活 E → 调 `getExtensionImpls(E, custom)` | 回退取 default（custom E 配置已清） |

**F1 — scope 删除 cascade**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-F1-1 | （API）scope=custom 激活多个 EP + 改配置 → deleteScope(custom) → listScopes 不含 custom；调 `getExtensionImpls(point, custom)` 报错/不存在；default 配置不受影响 | cascade 清配置正确，default 隔离 |
| UC-F1-2 | （API）deleteScope('default') | 拒绝（default 不可删），返回错误 |

**F2 — migrate**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-F2-1 | （API）有现存 ExtImplConfigRecord（升级前）→ 升级启动 migrate → 查记录全部 scope=default → `getExtensionImpls(point)` 行为不变 | 数据零损失，行为兼容 |

**F6 — UI scope 切换器**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-F6-1 | UI：打开插件配置页 → 扩展点 tab → 顶层 scope 切换器可见，当前=default | 切换器在顶层；选中 default；下方 EP 全亮可操作 |
| UC-F6-2 | UI：scope 切换器选「custom」→ 下方所有 EP 灰显 + 「继承 default」提示 + 「激活此 EP」按钮；布局无位移 | 切 scope 后正确反映继承态；按钮出现/消失不导致位移 |
| UC-F6-3 | UI：scope=custom 下点某 EP「激活此 EP」→ EP 转为可操作（显示 custom 独立配置）→ 改 impl 开关 → 刷新仍保持 → 调 API 反映改动 | 激活+改配置+持久化链路通 |
| UC-F6-4 | UI：scope=custom 已激活 EP 下点「取消激活」→ 确认 → EP 灰显继承 default | 取消激活 UI 正确回退 |
| UC-F6-5 | UI：scope 切换器创建新 scope（输入 name/desc）→ 创建成功 → 切换器列表含新 scope | 创建 scope UI 通 |
| UC-F6-6 | UI：scope 切换器删除非 default scope → 确认 → 列表移除；default 无删除入口 | 删除 scope UI 通 + default 保护 |

---

## 4. 视觉

本版本**无设计稿**（`hasDesign=false`，见 task.json）。视觉保真度门禁跳过（无 `vision_check.py compare` 比对）。

UI 实现遵循现有 `specs/ui/components/_conventions.md` 通用规范 + 现有 plugin-config-page 视觉风格（terracotta 强调色 / 卡片 / 折叠分组等），scope 切换器组件 spec 由 coder 编码前置产出（视觉基线字段对齐既有风格）。

E2E 验证仅做**单图功能检查**（`vision_check.py` 单图 / `mcp__MiniMax__understand_image`）：scope 切换器可见/选中态正确、灰显/激活态正确、布局无位移（按钮出现/消失不跳动）。

---

## 5. 对齐 ui/tech spec（MANDATORY）

### 5.1 PRD 引用的现有概念（与 spec 一致）

| 引用概念 | spec 出处 | 一致性 |
|---------|----------|--------|
| `ExtensionPoint.group`（必填，功能分区 provider/context/web，仅展示不读运行时） | `specs/tech/plugin_system/[P0]extension_point_interface.md` §2 §3.6 | ✅ 不动，scope 正交于 group |
| `ExtensionPoint.cardinality`（exclusive/list/ordered） | 同上 §2 §3.1 | ✅ 不动，scope 不影响 cardinality 解析 |
| `ExtImplConfigRecord`（implId/enabled/order/configValues） | `specs/tech/config/[P0]plugin_config.md` §2 | ✅ 字段不变，仅 key 加 scopeId 维度 |
| `PluginConfigService`（inventory/setEnabled/setImplEnabled/setExclusive/setPointOrders/setImplConfig） | `specs/tech/config/[P0]plugin_config_service.md` §2 | ✅ 方法名沿用，加 scopeId 参数 |
| `getExtensionImpls(point)`（单参，按 cardinality 解析，effective order） | `specs/tech/plugin_system/[P0]plugin_manager_interface.md` §2 | ✅ 保留向后兼容，新增重载 |
| 两级 enabled 门（plugin.enabled ∧ impl.enabled） | 同上 + plugin_config_service §4.5 | ✅ 不动，plugin 级不分 scope |
| effective order 算法（record order ?? 末尾补位） | plugin_config_service §3.1 | ✅ 算法不变，order 源按 scope 取 |
| `page-plugin-config`（2 tab：插件/扩展点） | `specs/ui/components/plugin-config-page/page-plugin-config.md` | ✅ 不动，scope 切换器加在扩展点 tab 内顶层 |
| `section-ext-point-area`（2 栏：group 列表 + ext point 区，按 type 路由） | 同上 | ✅ 不动，scope 维度叠加在 ext point 区 |
| `common/section-group-list`（通用 group 列表） | `specs/ui/components/common/section-group-list.md` | ✅ 复用不变（group 列表仍是 EP.group） |

### 5.2 新概念「scope」— 需架构阶段落 spec（MANDATORY）

PRD 不发明实现细节，以下需 architect 在架构阶段落 spec：

**需落 `specs/tech/config/`（新文档或扩展现有）**：
- **scope 数据模型**：scope 一等实体（id/name/description/createdAt）的 SchemaDef + 落盘形态（engine/落盘文件）
- **scope 激活记录模型**：per-scope-per-EP 激活状态如何存（独立 entity / ExtImplConfigRecord 派生 / scope 元数据内嵌）—— 架构决策
- **ExtImplConfigRecord 加 scope 维度**：逻辑 key `(scopeId, implId)` 的存储改造（复合 key / 分片键选择）+ migrate 策略（一次性 / lazy）
- **PluginManager 接口扩展**：`getExtensionImpls(point, scopeId?)` 重载签名 + per-EP 回退解析实现（按 scope 取 order/enabled/configValues）
- **PluginConfigService 接口扩展**：scopeId 参数注入现有写操作 + 新增 `activateEp/deactivateEp/createScope/deleteScope/listScopes` op + 写未激活 EP 的语义（自动激活 or 拒绝）
- **inventory 扩展**：按 scopeId 返回 + EP 激活状态字段
- **per-EP 激活初始值复制 default 快照**的事务语义（原子复制 + 隔离保证）

**需落 `specs/ui/components/plugin-config-page/`（新组件 spec）**：
- **scope 切换器组件**（命名建议 `component-scope-switcher` 或 `section-scope-switcher`，由 architect/coder 定）：Props（scopes 列表 / 当前选中 / onSelect / onCreate / onDelete）+ testid + 视觉基线（对齐既有 plugin-config-page 风格）+ 布局稳定性（按钮出现/消失不位移）
- **EP 激活/取消激活 UI**：在 `section-ext-point-area` 或新组件中加「激活此 EP」/「取消激活」按钮 + 灰显态 + 「继承 default」提示；复用既有 impl 组件（radio/checkbox/ordered）但需支持 disabled 态（灰显）
- **page-plugin-config.md / section-ext-point-area.md 更新**：scope 切换器挂载位置 + scope 状态下传到 section-ext-point-area 的 Props 扩展

### 5.3 PRD ↔ ui/tech spec 对齐自检

- ✅ 不发明概念：scope 模型严格按 user_query v0.0.26 对齐结论，不改语义
- ✅ 现有概念引用与 spec 一致（命名、字段、接口签名）
- ✅ 新概念明确标注「需架构阶段落 spec」，PRD 只描述产品行为
- ✅ 与 EP.group 正交（group=功能分区不动，scope=配置层维度新增）
- ✅ 向后兼容（旧接口 + 旧记录 migrate）

---

## 6. Spec Gap（发现的 spec 不准确/不全）

读 spec 过程中未发现需要当即修正的不准确处。`specs/tech/config/[P0]plugin_config.md` + `[P0]plugin_config_service.md` + `specs/tech/plugin_system/[P0]plugin_manager_interface.md` + `[P0]extension_point_interface.md` 描述准确，与本版本需求无矛盾。

唯一 gap 是「scope 维度尚未定义」——这属于本版本要新增的概念，由架构阶段补 spec（见 §5.2），非现有 spec 错误。

---

## 7. 版本

PRD version: v0.0.26（新增 scope 维度，6 功能点 F1-F6，8 关键用户路径）。
