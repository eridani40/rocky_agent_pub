# component-ext-impl-ordered

> 层级: component
> 文件: app/web/src/components/plugin-config-page/component-ext-impl-ordered.tsx

## 职责 `ordered` 类型扩展点的实现列表。每 impl 同时具备：**拖拽排序手柄** + **独立 enabled 开关**，两者各自独立互不干扰（排序只改 `order`，开关只改 `enabled`）。典型场景：多个 handler 类扩展点的执行顺序 + 启停。
边界：只管「同一 point 内排序 + 独立启停」；排序结果通过 `onReorder` 上抛，开关状态通过 `onToggle` 上抛，父级（`section-ext-point-area`）负责合并持久化。

## Props
- pointId: string
- impls: {
- implId: string
- pluginId: string
- enabled: boolean
- order: number;               // 显示顺序（1..n，父级已按 order 升序传入；顺序号用此值）
- configSchema?: object
- description?: string
- onReorder: (from: number, to: number) => void;     // 从索引 from 移到索引 to
- onToggle: (implId: string, next: boolean) => void; // 单项独立翻转 enabled
- onConfig?: (implId: string) => void; // 点配置入口回调
- disabled?: boolean

## 状态 / 交互
- **拖拽排序**：使用 （示意 `onReorder(from, to)`），拖完由父级（page-plugin-config）调用 `setPointOrders` op 持久化
- **独立开关**：使用 ，点击翻转 `enabled`，不影响 `order`
- **关键约束**：拖拽手柄与开关是**两个独立交互**，事件不互相冒泡触发——拖拽不能误改 enabled，点开关不能误触拖拽
-  每项在 implId 标题下显示 `description` 副文本（11px muted），无描述（空串）则不渲染该节点
-  顺序号显示 `order` 值（连续 1..n，从 1 开始）
-  disabled=true：整组灰显（容器 ），`draggable=false`（禁拖）、 disabled。用于未激活 EP「继承 default」只读视图。
-  父级 section-ext-point-area 在**所有场景**下都传 `disabled=true`（配置代码化只读，radio/checkbox/ordered 均不可编辑）。disabled prop 语义从「未激活 EP 灰显」扩展为「配置只读化」通用 disabled。
- **齿轮按钮在 disabled 下也渲染**（删 `!disabled` 守卫）——v0.0.67 全页只读化把齿轮一起藏了导致用户看不到 config（bug-B），v0.0.71 恢复显示 + modal 改 readOnly。齿轮按钮自身 `aria-disabled="false"` + `pointer-events-auto` 覆盖父级 pointer-events-none，仍可点击（见 `component-impl-config-btn.md`）。

## 复用关系
- 项内含「配置」入口时（impl.configSchema 存在）：齿轮按钮 `component-impl-config-btn`→ 父级挂载 `compo

## 消费方
- `app/web/src/components/plugin-config-page/component-ext-impl-router.tsx`
