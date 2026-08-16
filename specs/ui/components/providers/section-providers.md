# section-providers

> 层级: section
> 文件: app/web/src/components/providers/section-providers.tsx
> 参考: specs/ui/components/providers/_overview.md §3-§4

## 职责
providers group 内容区根：持 view 状态机（list | detail）+ draft/snapshot + save diff。
加载 `GET /provider` 时同时取 `protocols: ProtocolMeta[]`（响应顶层附带）cache 给 component-provider-fields 作下拉选项 + 拼接地址 path 来源。
一次加载全程共享（不随 detail 切换重拉）。
边界：自管理；父级在 providers group 时渲染它。通过 `onViewLevelChange` 上抛 view level（含挂载初始 `list`），供父级在 detail 二级页时隐藏同 tab 其余 group。

## 状态 / 交互
- `providers: ProviderInstance[]`（来自 GET /provider items）
- **`protocols: ProtocolMeta[]`**（来自 GET /provider 顶层 protocols 字段）
- list → detail：点 provider 卡 / 添加提供商
- detail → list：面包屑返回 / 保存成功后

## detail 保存模型（v0.0.317 SaveBar）

`component-provider-detail.tsx`（无独立 spec，契约记于此）：
- **dirty**：`isDirty(snapshot, draft)`——draft 与初始 snapshot 任一字段不同（含 protocolId 变化 + models 长度/内容 diff）。
- **[v0.0.317] SaveBar 替换原自定义 inline save-bar**：`<SaveBar variant="detail" dirty={dirty} saving={saving} onSave={handleSave} onCancel={handleReset} />`（`component-save-bar.tsx`）。
- **saving state**：`useState(false)`；handleSave 改 async 包装——`setSaving(true); try { await onSaved(draft) } finally { setSaving(false) }`。
- **reset**：`handleReset = () => setDraft(snapshot)`。
- **[v0.0.349] 删除入口（provider 删除）**：detail SaveBar 右侧「删除」danger 按钮（provider 非 null 才渲染；新建态无）→ ConfirmModal（`providers.json detail.delete*`，通用警示文案——删除后引用其模型的方案条目将失效/会话自动切换）→ onOk 调 `onDeleted()`（新可选 prop，不进 draft/dirty 通道）；section-providers 实现 `handleDeleted(pid)`：`deleteProvider(pid)`（api-client 既有）→ `reload()` → 回 list。删除即时生效不进 diff-save。删除后方案条目 dangling 双语义见 `specs/api/overall/21-model-routing.md §2.7`。
- **[v0.0.350] 类型选择 + 额度总览挂载**：detail draft 加 `name`（ProviderName，缺省 anthropic_compatible；旧 record 无 name 兜底通用；类型选择器见 component-provider-fields spec）；list 分支底部（添加提供商卡之后）渲染 `<CodingPlansQuotaFooter providers={native子集}>`（过滤 name ∈ 4 native coding plan；空则不渲染；仅 list 页，detail 页不挂）。组件 spec：`component-coding-plans-quota-footer.md`。
- **[v0.0.350] name 联动三边界（component-provider-detail `handleFieldsChange` 拦截 patch.name 变更）**：① 选 native 类型 → protocolId 锁 `anthropic_messages`（fields 层 protocol 控件只读置灰禁点）② baseUrl **无条件替换为 preset 推荐地址**（老板 08-15 拍板：切类型=换渠道，地址跟着换——空值/旧渠道地址/自定义值一律覆盖；切完后用户仍可手动改，输入框不锁死）③ 新建且 models 空 → 预填默认模型一条（kimi contextWindow 262144）；已存 provider 不重置 models。切回通用不回填（baseUrl/protocolId 保持现状）。preset 权威 = `provider-type-presets.ts`（`PROVIDER_TYPE_PRESETS` 5 项 + `findProviderTypePreset` / `isNativeCodingPlan`）。保存链 `handleSaved` 透传 name（section → api-client saveProviderWithModels）。

## 列表分组折叠（v0.0.352）

list 视图按 `provider.enabled` useMemo 拆 `enabledProviders` / `disabledProviders`：
- 默认只渲染**启用组**（component-provider-list-card × N）+ 添加提供商卡（恒在启用组之后）
- 停用组**非空才**渲染折叠入口按钮「已停用 (N)」（i18n `fold.disabled` 插值 count；testid `providers-disabled-fold`；收起=虚线边框 / 展开=实线边框；chevron 箭头展开时 rotate-180）
- 展开后 `providers-disabled-list` 容器渲染停用组——**同一 `component-provider-list-card`**，onClick 同样 openDetail 进 detail 二级页（停用 provider 仍可查看/编辑/启用）
- 停用卡灰调复用既有 token（logo `bg-bg-warm text-muted` + muted 徽章），不自创视觉（demo 手写色 → token 映射，编码期偏离①review 接受）
- 卡片 testid `provider-card-{id}`（加在 component-provider-list-card.tsx，启用/停用卡共用）
- 额度总览 footer 挂载位置不变：list 底部（启用组+添加卡+折叠区之后），native provider 非空才渲染

## 复用关系
- 被组合：page-app-config（providers group 时渲染）
- 组合了：component-provider-list-card × N / component-provider-detail / 新增 provider
