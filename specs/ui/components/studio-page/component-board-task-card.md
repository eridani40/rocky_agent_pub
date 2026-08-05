# component-board-task-card（看板 Task 单卡）

> 文件: app/web/src/components/studio-page/component-board-task-card.tsx

## 职责
渲染单张 task 卡片，包含：
- title + status + assignee + source + priority 元信息行
- 「所属 requirement」引用 span（`src · req:{...}`）——**feature gate 条件渲染**：`isFeatureOkrOn()` 为 false（默认）时不渲染（不留空 span 占位；v0.0.223 OKR/req 漏出移除，`specs/tech/app/[P1]feature_gate.md`）；gate 开时照旧显示
- 编辑 / 归档 / 恢复 / 复制按钮（hover 区域右上角）
- @ 按钮（活跃区 + 未归档 + onAtMention 存在时）
- dependsOn 灰链（被依赖 task effectiveArchived=true → 「已归档」灰链）

## Props
- task: TaskBoardItem
- members: Member[]
- board: Board
- zone: 'active' | 'archive'
- onEdit: (t: EditTarget) => void
- onArchive: (k: BoardEntityKind, id: string, gid?: string) => void
- onRestore: (k: BoardEntityKind, id: string, gid?: string) => void
- onDuplicate: (tid: string) => void
- onAtMention?: (payload: BoardMentionPayload) => void
