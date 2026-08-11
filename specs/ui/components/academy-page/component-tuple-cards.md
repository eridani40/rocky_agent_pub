# component-tuple-cards（学生详情四元组卡）

> 层级: component
> 文件: app/web/src/components/academy-page/component-tuple-cards.tsx

## 职责
渲染学生某版本的四元组卡片组（System Prompt / Skills / Memory / 模型），垂直堆叠。每卡 head 右侧一个动作按钮，动作一律**上抛父级**（modal state 归 `page-academy`）。

边界：不发请求（模型卡的 PATCH 由 `section-student-detail` 承担）、不持 modal state、不做版本选择（`content` 已是选中版本的内容）。

> **[v0.0.219] Tools 卡移除**：原五元组去 Tools 卡（仅删 UI 入口）；`version.json.tools` 数据字段 + `MdEditorTarget.saveKind='tools'` union 保留为 dead-but-harmless（装配链 `resolveToolSet` 仍用 tools 数据，见 `[P0]session_kind_extension.md §4`）。

## Props
```ts
interface Props {
  studentName: string;
  /** 当前选中版本 label（md-editor subtitle 用） */
  selLabel: string;
  /** formal 可编辑 / process 只读 */
  selectedIsFormal: boolean;
  /** GET .../version/:vid 的 content（skills = 目录 + 文件树；memory = MemoryEntrySummary[] 真实条目） */
  content: VersionContent['content'] | undefined;
  modelSel: ModelSelection | null;
  onOpenMdEditor: (args: MdEditorOpenArgs) => void;
  /** 打开 Skills 浏览弹层（Skills 不经 md 编辑器通道） */
  onOpenSkillBrowser: () => void;
  /** [v0.0.219] 打开版本 memory 只读 modal（Memory 卡「查看」） */
  onOpenMemoryModal: () => void;
  onModelChange: (sel: ModelSelection) => void;
}
```

## 状态 / 交互

| # | 卡 | sub | body | 动作按钮 | 动作去向 |
|---|---|---|---|---|---|
| 1 | 📝 System Prompt | `AGENTS.md` | AGENTS.md 全文 mono 预览（max-h 170px 滚动；空 → 「（空）」） | formal「查看 / 编辑」· process「查看」 | `onOpenMdEditor({fileName:'AGENTS.md', saveKind:'agentsMd'})` |
| 2 | 🧩 Skills | `.rocky/skills/ · N 个 skill · M 个文件`（M = Σ fileCount） | skill chip 列表（🧩 名 + mono muted「N 文件」）；空 → 「暂无数据」 | 「查看」 | **`onOpenSkillBrowser()`** → `component-skill-browser-modal` |
| 3 | 🧠 Memory | `.rocky/memory/ · {count} 个条目`（count = `content.memory.length`） | memory 条目 chip / 摘要；空 → 「暂无记忆条目」 | 条目数 > 0「查看」· 空 undefined | **`onOpenMemoryModal()`** → `component-version-memory-modal`（只读） |
| 4 | 🤖 模型 | `version.json · v{label}` | 28×28 avatar + modelId（未设 → 「未设置（跟随默认模型）」）+ `provider: X` | formal 才渲染 `InputModelPicker` | `onModelChange(sel)` |

**Skills 卡不走 md 编辑器（硬约束）**：曾把 skill 目录名拼成假 markdown 传 `onOpenMdEditor` 且 `saveKind='agentsMd'`，保存即把 AGENTS.md 覆盖成目录名列表（system prompt 丢失）。现 Skills 只有一条通道 = skill browser + `18-academy §1.11` 单文件端点；`MdEditorTarget.saveKind` 保持 `'agentsMd' | 'tools'`，**不新增 `'skillFile'`**（那条路不存在 = 数据丢失按构造消失）。

**Memory 卡走 version memory modal（[v0.0.219]）**：`content.memory` 现返 `MemoryEntrySummary[]` 真实条目（`resolveVersionContent` 扩读 `.rocky/memory/*.md`，api §1.8）。Memory 卡显条目数（`tuple.memoryCount`）+ 「查看」开 `component-version-memory-modal`（只读，禁 `useMemoryCrud`——那是 session 级读写）；空显 `tuple.memoryEmpty`，无动作按钮。

- **可见文案**（E2E）：卡标题「System Prompt」「Skills」「Memory」「模型」/ 按钮「查看 / 编辑」「查看」「自定义」/ sub 文案见上表 / 空态「（空）」「暂无数据」「暂无记忆条目」「{count} 个条目」「未设置（跟随默认模型）」（i18n ns=`academy` 的 `tuple.*`）。
- 动作按钮 `data-action-key="academy.version.edit"`（四卡共用卡壳）。

## 复用关系
- 被组合：`section-student-detail`（右列 tuple-grid）。
- 组合：`chat-page/component-input-model-picker`（模型卡）、`academy-styles`（CARD / BTN_GHOST / BTN_SM / AVATAR_BASE）。
- 上抛的三条弹层通道互不相通：`onOpenMdEditor` → `component-modal-md-editor`；`onOpenSkillBrowser` → `component-skill-browser-modal`；`onOpenMemoryModal` → `component-version-memory-modal`。

## 视觉基线
- 设计稿来源：`demo/03-student-detail.html` 的 `.tuple-card`。
- 尺寸：卡垂直堆叠 gap 12px；head `padding 11px 15px`、body `padding 13px 15px`；skill chip `padding 6px 10px` 左右 + `rounded-md`。
- 字体：卡标题 13px/600；sub 11px muted；body 文本 12–12.5px；代码/chip mono。
- 边框：卡 `CARD`（border + rounded）+ head 底 border；head 底色 `bg-bg-warm`。
- 配色：skill chip `border-border` + `bg-surface`；模型 avatar indigo。

## 消费方

- `app/web/src/components/academy-page/section-student-detail.tsx`
