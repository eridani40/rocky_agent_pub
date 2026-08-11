# component-memory-editor-modal（memory entry 新建/编辑弹层）

> 层级: component
> 文件: app/web/src/components/chat-page/component-memory-editor-modal.tsx
> HTTP 契约: `specs/api/overall/15-memory-ui.md` §4（POST）/§5（PATCH）
> 本文是 memory 新建/编辑弹层的**概念权威源**：表单字段 + testid + 校验规则 + 全字段可编辑约束。

## 消费方

- `components/app-dev-config-page/section-user-memory.tsx`
- `components/chat-page/component-memory-editor-fields.tsx`
- `components/chat-page/use-memory-crud.ts`

## 复用关系
- `section-memory-panel`（chat/studio 右侧，prefix=`memory-session`）
- `section-user-memory`（应用设置全局长期记忆，prefix=`memory-user`）
- studio 右侧 tab（prefix=`squad-memory`） 受控组件：`open=false` 不渲染；`open=true` 渲染遮罩 +

## Props
- name?: string;         // undefined = 新建模式（name 可输入）
- intro?: string;        // 一句话摘要
- type?: 'user' | 'feedback' | 'project' | 'reference'
- body?: string
- why?: string
- howToApply?: string
- evolvable?: boolean;   // 是否允许 agent 自动进化（编辑态回填该条实际值）
- open: boolean
- initial?: MemoryEditorInitial
- testIdPrefix: 'memory-session' | 'memory-user' | 'squad-memory'
- onClose: () => void
- onSave: (entry: MemoryWriteInput) => Promise<void> | void; // MemoryWriteInpu...

## 3. 状态 / 交互
- 表单字段：`name`（新建可输入，编辑锁定）/ `intro`（一句话摘要，原 `description`）/ `type` / `body` / `why` / `howToApply` / **`evolvable`**
- `type=feedback|project` 强制 `why + howToApply`（save 按钮 disabled 直到填齐）
- **evolvable 开关全字段可编辑（无置灰、不防呆，PRD §9.2.3 UC-M4）**：无论该条 evolvable 初值为 true 还是 false，开关都可自由切 false↔true，用户对自己记忆有完全控制权。**MUST NOT** 因 evolvable=false 而禁用任何字段（正文/type/intro/开关本身均可编辑）——这是 UI 路径不 gate 的可见体现（HTTP 端点不传 enforceEvolvable）。
- 新建态 evolvable 开关默认 **false**（用户资产，POST 服务端 `defaultEvolvable:false`）；编辑态回填 `initial.evolvable`。
- 保存 → 父调 POST（新建，服务端强制 evolvable=false）/ PATCH（编辑，`setEvolvable` 携带开关值）。
