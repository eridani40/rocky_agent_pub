# component-ext-impl-radio

> 层级: component
> 文件: app/web/src/components/plugin-config-page/component-ext-impl-radio.tsx

## 视觉基线
边界：只管「同一 point 内单选」，不感知其他扩展点；不负责持久化，选中结果通过 `onSelect` 回调上抛给父级（`section-ext-point-area`）。

## Props
- pointId: string
- impls: {
- implId: string
- pluginId: string
- selected: boolean;           // 是否为当前选中的实现
- configSchema?: object
- description?: string
- onSelect: (implId: string) => void;  // 选中某实现；父级负责互斥（取消其余）
- onConfig?: (implId: string) => void; // 点配置入口回调
- disabled?: boolean

## 状态 / 交互
- 单选语义：点未选项 → `onSelect(implId)`；父级把该 impl 设 ，同 point 其余  重渲染
- 已选中的 radio 不可取消（互斥语义下至少要有一个 active，取消由「选别的」实现）
-  每项在 implId 标题下显示 `description` 副文本（11px muted），无描述（空串）则不渲染该节点
-  disabled=true：整组灰显（容器 ），radio input 强制 disabled。用于未激活 EP「继承 default」只读视图。
-  父级 section-ext-point-area 在**所有场景**下都传 `disabled=true`（配置代码化只读，radio/checkbox/ordered 均不可编辑）。disabled prop 语义从「未激活 EP 灰显」扩展为「配置只读化」通用 disabled。
- **齿轮按钮在 disabled 下也渲染**（删 `!disabled` 守卫）——v0.0.67 全页只读化把齿轮一起藏了导致用户看不到 config（bug-B），v0.0.71 恢复显示 + modal 改 readOnly。齿轮按钮自身 `aria-disabled="false"` + `pointer-events-auto` 覆盖父级 pointer-events-none，仍可点击（见 `component-impl-config-btn.md`）。

## 复用关系
- 项内含「配置」入口时（impl.configSchema 存在）：齿轮按钮 `component-impl-config-btn`→ 父级挂载 `compo

## 消费方
- `app/web/src/components/plugin-config-page/component-ext-impl-router.tsx`
