# PRD 文档规范

## 格式说明

- 本文档为**快照式**，包含当前版本全量产品需求
- 每个条目标注 `[vX.Y]` 表示引入版本
- 条目被修改时追加 `[vX.Y modified]`，保留原版本号
- 已废弃的条目标注 `[deprecated vX.Y]`，不删除

## 目录结构

PRD 文档位于 `${SPECS_DIR}/prd/overall/`，按编号拆分为多个文件，**每个文件不超过 200 行**。

```
${SPECS_DIR}/prd/
├── overall/                           # 全量产品文档
│   ├── 01-product-framework.md        # 产品框架：定位、用户画像、功能全景
│   ├── 02-session-management.md       # 会话管理
│   ├── 03-chat-experience.md          # 对话体验
│   ├── 04-settings.md                 # 设置
│   ├── 05-file-browser.md             # 文件浏览
│   ├── 06-library.md                  # 知识库
│   ├── 07-mcp.md                      # MCP
│   └── 08-sandbox.md                  # 沙箱
└── version_logs/                      # 版本增量产品文档
    └── v${VERSION}/change_log.md
```

### Section 3 拆分规则

功能需求（§3）通常是最大的章节，**按功能模块拆分**，每个模块一个文件：

- `3-features-scaffold.md` — 脚手架功能
- `3-features-session-settings.md` — 会话管理 + Settings
- `3-features-chat-ui-1.md` — Chat UI 第一部分（消息展示、输入区）
- `3-features-chat-ui-2.md` — Chat UI 第二部分（Tool Call 渲染、流式展示）
- `3-features-agent-core.md` — Agent 核心
- `3-features-file-browser.md` — 文件浏览器

命名格式：`3-features-${MODULE_SLUG}.md`。当某个功能模块内容接近 200 行时，按子功能进一步拆分（如 `chat-ui-1`、`chat-ui-2`）。

### contents.md 模板

```markdown
# {项目名} - 产品需求文档

> 当前版本：vX.Y | 最后更新：YYYY-MM-DD

## 目录

| 章节 | 文件 | 说明 |
|------|------|------|
| §1 产品概述 | [1-product-overview.md](1-product-overview.md) | 定位、用户、核心价值 |
| §2 UI 风格 | [2-ui-style.md](2-ui-style.md) | 视觉风格、布局、组件规范 |
| §3.1-3.4 脚手架 | [3-features-scaffold.md](3-features-scaffold.md) | v0.1 脚手架功能 |
| §3.5-3.6 会话+设置 | [3-features-session-settings.md](3-features-session-settings.md) | 会话管理、Settings |
| ... | ... | ... |
| §4 非功能需求 | [4-non-functional.md](4-non-functional.md) | 性能、安全、可用性 |
| §5 约束与依赖 | [5-constraints.md](5-constraints.md) | 技术约束、外部依赖 |
| §6 里程碑 | [6-milestones.md](6-milestones.md) | 版本规划 |
```

## 章节文件模板

每个章节文件只包含该章节的内容，不重复文档标题和版本头。

### §1 产品概述（`1-product-overview.md`）

```markdown
## 1. 产品概述

### 1.1 产品定位 [v1.0]
### 1.2 目标用户 [v1.0]
### 1.3 核心价值 [v1.0]
```

### §2 UI 风格（`2-ui-style.md`）

```markdown
## 2. UI 风格与交互规范 [vX.Y]

### 2.1 整体风格 [vX.Y]
### 2.2 布局结构 [vX.Y]
### 2.3 通用组件风格 [vX.Y]
```

### §3 功能需求（`3-features-${SLUG}.md`）

```markdown
## 3. 功能需求（{模块名}）

### 3.X {功能模块名} [vX.Y]

**描述**：{功能说明}
**优先级**：P0 / P1 / P2
**用户故事**：作为{角色}，我希望{行为}，以便{价值}

#### 用户行为链路
#### 功能交互细节
#### 界面要素
#### 子功能
```

## 版本标注示例

```markdown
### 2.3 消息压缩 [v1.1]
<!-- v1.1 引入的新功能 -->

### 2.1 Agent Loop [v1.0] [v1.2 modified]
<!-- v1.0 引入，v1.2 修改了循环策略 -->

### 2.5 旧版通知系统 [v1.0] [deprecated v1.3]
<!-- v1.0 引入，v1.3 废弃 -->
```

## 增量更新规则（重要）

PRD 是**快照式**文档，必须始终反映全量功能。当新版本引入功能时：

1. **必须在 §3 追加功能章节**：新版本的每个用户可感知功能都必须新增完整的章节文件或在已有文件中追加小节（描述、优先级、用户故事、用户行为链路、交互细节、界面要素、子功能），而不是仅在里程碑表中提及
2. **内部重构可简化**：纯内部重构如果用户无感知，可以不新增 §3 章节，但应在 §4 非功能需求中说明
3. **UI 变更必须更新 §2**：如果新版本改变了整体布局或交互规范，必须更新 `2-ui-style.md`
4. **里程碑表保持同步**：`6-milestones.md` 中的"包含功能"字段应与 §3 中的章节编号对应
5. **新增文件更新 TOC**：如果创建了新的 `3-features-*.md` 文件，必须在 `contents.md` 中添加条目

## 行数预算

每个章节文件**硬限 200 行**。超出时拆分为多个文件（如 `3-features-chat-ui-1.md` + `3-features-chat-ui-2.md`）。目录总行数不设上限。

## 编写原则

1. **一个功能一个小节**：不混合多个功能
2. **用户行为链路必填**：每个功能必须描述完整的操作路径（入口 -> 操作 -> 结果）
3. **交互细节具体化**：不说"用户可以管理项目"，要说"用户点击侧边栏'项目列表' -> 悬停行显示操作按钮 -> 点击'删除'弹出确认弹窗"
4. **UI 风格先于功能**：§2 UI 规范确定后，功能需求中的界面要素必须符合 §2 的约定
5. **验收标准明确**：每个功能都有可验证的标准
6. **优先级清晰**：P0 必须交付，P1 应该交付，P2 尽量交付
7. **向前兼容**：修改时只追加标注，不删除历史信息
8. **全量覆盖**：每次新版本发布后，§3 中的功能章节数必须等于项目累计的全部用户可感知功能数
9. **行数约束**：每个章节文件不超过 200 行，目录总行数不设上限
