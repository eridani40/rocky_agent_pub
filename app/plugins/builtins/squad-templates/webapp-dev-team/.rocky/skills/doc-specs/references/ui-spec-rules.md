# UI 协议文档规范

## 目录结构

```
${SPECS_DIR}/ui/
├── overall/                    # 全量 UI 协议文档
│   ├── ${PAGE_NAME}.md          # 按页面/组件组织
│   └── ...
└── version_logs/
    └── v${VERSION}/change_log.md  # 版本增量
```

## 用途

UI 协议文档是 **E2E 测试的唯一选择器来源**。E2E verifier 只读此文档获取可观测节点，不读前端源码。

## 页面文档模板

```markdown
# {PageName}

- **路由**: /${PATH}
- **版本**: [v0.1]

## 页面结构

{简要描述页面的主要区域和布局}

## 可观测节点

| data-testid | 元素描述 | HTML 类型 | 可见条件 | 引入版本 |
|-------------|---------|-----------|---------|---------|
| sidebar-nav | 侧边栏导航容器 | nav | 始终可见 | [v0.1] |
| sidebar-item-${NAME} | 导航项 | button | 始终可见 | [v0.1] |
| chat-input | 聊天输入框 | textarea | 页面加载后 | [v0.1] |
| chat-send-btn | 发送按钮 | button | 输入框非空时 | [v0.1] |
| loading-spinner | 加载动画 | div | 请求进行中 | [v0.1] |

## 动态节点

{描述根据状态动态出现/消失的节点}

| data-testid | 触发条件 | 消失条件 | 引入版本 |
|-------------|---------|---------|---------|
| error-toast | API 返回错误 | 5s 后自动消失 | [v0.1] |
| empty-state | 列表为空 | 列表有数据 | [v0.1] |

## 交互状态

{描述节点在不同状态下的表现}

| data-testid | 状态 | 表现 |
|-------------|------|------|
| chat-send-btn | disabled | opacity: 0.5, cursor: not-allowed |
| chat-send-btn | loading | 显示 spinner，禁用点击 |
```

## data-testid 命名约定

- 格式：`${COMPONENT}-${ELEMENT}`，kebab-case
- 组件名与代码中的组件名对应，但用 kebab-case
- 列表项用 `${COMPONENT}-item-${IDENTIFIER}` 模式
- 动态 ID 用大括号标注：`chat-message-${ID}`

### 命名示例

| 场景 | 命名 |
|------|------|
| 侧边栏 | `sidebar`, `sidebar-item-${NAME}` |
| 聊天消息 | `chat-message-${ID}`, `chat-message-content` |
| 表单 | `form-${NAME}`, `form-${NAME}-submit` |
| 模态框 | `modal-${NAME}`, `modal-${NAME}-close` |
| 错误提示 | `error-${CONTEXT}` |

## 核心规则

1. **E2E 测试的唯一选择器来源** — verifier 不读前端代码
2. **coder 同步更新** — 每次前端变更必须同步更新对应页面文档
3. **版本标注** — 每个节点标注引入版本 `[vX.Y]`
4. **可见条件必填** — 不能只写"可见"，要写清楚在什么条件下可见
5. **单文件 ≤ 200 行**，超出按区域拆分

## 与其他文档的关系

- **PRD** 定义"用户能做什么" → UI 文档定义"怎么观测到用户做了什么"
- **Tech** 定义"怎么实现" → UI 文档定义"实现后暴露哪些观测点"
- **E2E 测试** 读 PRD 知道测什么 + 读 UI 文档知道怎么定位元素
