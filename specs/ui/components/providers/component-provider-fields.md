# component-provider-fields

> 层级: component
> 文件: app/web/src/components/providers/component-provider-fields.tsx
> 参考: specs/ui/components/providers/_overview.md §5

## 职责
连接配置表单：展示 label / baseUrl / apiKey / **protocol（单选）** / **拼接地址展示区** 并把变更上抛 onChange(patch)。
边界：不持本地副本、不感知保存；父级（provider-detail）持 draft。apiKey 字段用 ：value=已保存 apiKey，onCommit 提交新值→`onChange({apiKey: next})`→父级标 dirty→表单级 save 落库（commit≠save）。PUT `'***'` 哨兵仍为向后兼容占位（前端拿明文正常提交即覆盖）。
- protocol 单选控件（替代「无此字段」）：选项 = `protocolOptions.map(p => ({id, label}))`，value = ProtocolName id
- 拼接地址 mono 展示区（read-only）：文本 = `{draft.baseUrl}{selectedProtocol.path}`，实时随两字段变化

## Props
- id: ProtocolName;     // 'anthropic_messages'
- label: string;        // 'Anthropic Messages 风格'
- path: string;         // '/v1/messages'
- label: string
- baseUrl: string
- apiKey: string
- enabled: boolean
- protocolId: ProtocolName;   // 新增
- draft: ProviderDraftFields
- onChange: (patch: Partial<ProviderDraftFields>) => void
- protocolOptions: ProtocolOption[]

## 状态 / 交互
- protocol 选择：选项 ≤ 4 时复用 （按 _conventions.md §10 硬规则：禁止原生 `<select>`）
  - 当前 protocolOptions 仅 1 项（anthropic_messages），渲染单卡
  - 未来扩到 > 4 时需新建 ，仍禁原生 select
- 拼接地址实时计算（derived，无本地状态）：
  - 文本 = `${draft.baseUrl}${selectedPath}` - 空态：baseUrl 空 + path 空 → 展示空字符串（占位文本「先填 Base URL 与选择 protocol」）

## 视觉基线
> 无版本设计稿（reqs/[working] v0.0.53 仅 req.md）→ 视觉基线沿用 v0.0.7 既有 component-provider-fields 规格。
> 拼接地址用 mono 字体 + read-only 浅底容器（与 baseUrl 输入框同宽）+ 灰色 muted 文本（提示非可编辑字段）。
> protocol 单选卡片复用  既有视觉（accent border + 浅底 + 勾）。

## 复用关系
- 被组合：component-provider-detail
- 组合了：（protocol 单选）/ （enabl

## 消费方
- `app/web/src/components/providers/component-provider-detail.tsx`
