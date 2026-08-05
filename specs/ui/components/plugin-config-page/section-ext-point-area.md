# section-ext-point-area

> 层级: section
> 文件: app/web/src/components/plugin-config-page/section-ext-point-area.tsx

## 职责
扩展点 tab 主区域。2 栏：左 = group 列表（**复用 `common/section-group-list`**），右 = 选中 group 下的扩展点及其实现，按扩展点 type 分组渲染对应 `component-ext-impl-*`。
**数据源**：REST CRUD 无 SSE——groups/points 来自父级 `page-plugin-config` 挂载 `GET /config/plugin` inventory；impl 的 enable/order/config 上抛父级（v0.0.67 全页只读化后写 handler 均 noop，配置代码声明在 `app/plugins/scopes/*.yaml`）。齿轮 modal（`component-schema-config-modal`）改 readOnly 模式。无 SSE。
边界：group 列表复用 common 组件，不自己实现列表逻辑。
：每个扩展点 header 新增副文本行显示 `pointDescription`（来自 inventory 透传的 ext point 级描述，同 point 内所有 impl 共享，无则空串不渲染）。该描述从 group 下任一 impl 节点的 `pointDescription` 字段取（同 point 一致），用于用户理解该扩展点做什么。
：scope 维度叠加（已被 v0.0.67 部分回退）。
：**配置只读化**——scope 配置代码声明（`app/plugins/scopes/*.yaml`），运行时不可改。

## Props
- groups: { groupId: string; points: ExtPoint[] }[]
- onImplToggle: (implId: string, next: boolean) => void
- onExclusiveSelect: (implId: string) => void
- onReorder: (pointId: string, from: number, to: number) => void
- onSaveImplConfig: (implId: string, values: Record<string, unknown>) => void
- currentScopeId?: string
- activatedPoints?: Set<string>
- pointId: string
- activated: boolean
- type: 'exclusive' | 'list' | 'ordered'
- impls: Impl[]
- pointDescription?: string
- implId: string; pluginId: string
- selected?: boolean; enabled?: boolean; order?: number

## 状态 / 交互
- `selectedGroupId`：左栏选中 group，右侧渲染其 points（按嵌套 points[] 迭代）
- `collapsedPoints`：各扩展点折叠态（pointId → collapsed），点头标切换
- `modalImpl` state 改存 `{ implId, configSchema, config }`（不再存 schemaConfig）；打开条件 `impl.configSchema` 存在
-  每个扩展点 header 在标题行下方渲染 `pointDescription` 副文本（11px muted，无则不渲染），帮助用户理解该扩展点用途
- 每个扩展点按 `type` 路由：
- impl 有 `configSchema` → 卡片右侧齿轮入口（`component-impl-config-btn`，v0.0.71 D4 disabled 下也渲染）→ `component-schema-config-modal`（强制 readOnly）
- **所有 EP impl 列表强制 disabled**（radio/checkbox/ordered 灰显展示）； 齿轮按钮在 disabled 下也渲染（修 bug-B）
-  非 default scope 未激活 EP：不渲染 impl 列表，渲染 `ext-point-{pointId}-inactive-hint`（i18n `page.epInactiveHint`）
