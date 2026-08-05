# component-ext-impl-checkbox

> 层级: component
> 文件: app/web/src/components/plugin-config-page/component-ext-impl-checkbox.tsx

## 职责 `list` 类型扩展点的实现列表。每项为一个 plugin 的扩展实现，**每 impl 前 checkbox 独立勾选启用**——实现之间互不影响，可同时启用多个或全不启用。
边界：只管「同一 point 内多选」，不负责顺序、不感知互斥；启用状态通过 `onToggle` 上抛父级（`section-ext-point-area`）。

## Props
- pointId: string
- impls: {
- implId: string
- pluginId: string
- enabled: boolean;            // 该实现是否启用
- configSchema?: object
- description?: string
- onToggle: (implId: string, next: boolean) => void;  // 单项独立翻转
- onConfig?: (implId: string) => void; // 点配置入口回调
- disabled?: boolean

## 状态 / 交互
- 多选语义：每个 checkbox 独立翻转，点 → `onToggle(implId, !enabled)`
- **关键约束**：每个 impl 的 `enabled` 由父级独立维护，严禁共享 state 字段导致联动
-  每项在 implId 标题下显示 `description` 副文本（11px muted），无描述（空串）则不渲染该节点
-  disabled=true：整组灰显（容器 ），checkbox 强制 disabled。用于未激活 EP「继承 default」只读视图。
-  父级 section-ext-point-area 在**所有场景**下都传 `disabled=true`（配置代码化只读，radio/checkbox/ordered 均不可编辑）。disabled prop 语义从「未激活 EP 灰显」扩展为「配置只读化」通用 disabled。
- **齿轮按钮在 disabled 下也渲染**（删 `!disabled` 守卫）——v0.0.67 全页只读化把齿轮一起藏了导致用户看不到 config（bug-B），v0.0.71 恢复显示 + modal 改 readOnly。齿轮按钮自身 `aria-disabled="false"` + `pointer-events-auto` 覆盖父级 pointer-events-none，仍可点击（见 `component-impl-config-btn.md`）。

## 复用关系
- 项内含「配置」入口时（impl.configSchema 存在）：齿轮按钮 `component-impl-config-btn`→ 父级挂载 `compo
