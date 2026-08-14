# section-channel-form

> 层级：section
> 文件：app/web/src/components/channel-page/section-channel-form.tsx

## 职责
新建/编辑渠道 config 表单：类型选择（由后端 scope 激活集合派生，page-channel 经 GET /config/channels/impl-types 供给）/ name / appId / appSecret（mask）/ 提交。
- 新建：POST /config/channels（enabled 默认 true → 建完即连）。
- 编辑：PUT /config/channels/:id（appSecret='***' 表示未改，后端 merge 原值）。
边界：受控表单，提交后回调父级（父级 reload 取稳态 + 关表单）。

## 保存模型（v0.0.317 SaveBar）

- **[v0.0.317] dirty 判定**：`isEdit`（editing 有值）→ `implId/name/appId/appSecret` 各 `!==` editing baseline；`editing=null`（新建）→ 任一字段非空即 dirty。
- **[v0.0.317] 底部 SaveBar 替换原提交/取消按钮**：`<SaveBar variant="detail" dirty={dirty} saving={submitting} onSave={...} onCancel={...} />`（`component-save-bar.tsx`）。handleSubmit 改为 SaveBar onSave 回调（组装 input + onSubmit + setErr 提交逻辑不变），从 inline form submit 改为函数调用。
- **types 空态**下提交按钮禁用沿用（见下节）。

## Props
- editing?: ChannelConfig | null;  // null/undefined=新建；有值=编辑（回显 name/appId/appSecret）
- types: { implId: string; label: string }[];  // 渠道 impl 类型列表（label 已经父级 resolveI18nField 解析为本地文案）
- onSubmit: (input: ChannelFormInput) => Promise<void>
- onCancel: () => void
- implId: string;  // 初值 editing?.implId ?? types[0]?.implId ?? ''（无 feishu 硬编码兜底）
- name: string
- appId: string
- appSecret: string;  // 新建=明文；编辑='***'=未改 / 新值=覆盖

## types 空态契约
- `types.length === 0`（后端 impl-types 为空/获取失败）：类型下拉 disabled + 显 `{t('form.noImplTypes')}` 提示 + 提交按钮 disabled。
- 空态**不阻断**既有 config 列表展示与编辑入口（编辑态回显不受影响）。
- options 无任何前端兜底项：types 空 → options 空数组（不伪造 feishu 项）。

## 复用关系
- 组合 component：`component-channel-type-dropdown`（类型选择，v0.0.106）、`component-feish
- 组合 primitive：（编辑表单 appSecret）
- 被组合于：`page-channel`（以 modal 弹层渲染）
