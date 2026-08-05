# playground-skills-entry — 会话悬浮菜单 skills 入口（3 tab 展示）

> PRD 路径 A/B/C（`specs/prd/version_logs/v0.0.205.t2_cons/change_log.md` §3）。
> 纯自然语言，零断言零录制；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式。

## Use Case
作为用户，我想在会话里点悬浮菜单的 skills 入口，看到当前会话可见的所有 skills 按 session/group/global 三层分组展示，以便排查 agent 用错 skill 或验证 squad override 是否生效。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先）。
- 至少某一层有 skill 可看（app/builtin 全局层通常非空；executor 可先在当前 workspace 的 `.rocky/skills/<name>/SKILL.md` 放一个最小 skill 验证 session 层）。

## 操作目标（编号步骤）

1. **进入任一会话**：照 `specs/ui/overall/00-app-guide.md` §3.1 从 nav-rail 点 Playground 入口落到 chat 页（或选已有会话）。
2. **看悬浮菜单**：会话右上悬浮工具条，从上到下纵排 3 个图标：长期记忆 / 定时任务 / **skills**（最下方，本版新增）。
3. **打开 skills 弹层**：点 skills 图标 → 弹层打开，顶部 3 tab：session / group / global，默认选中 session tab。
4. **验 session tab 卡片**：卡片列表，每卡有渐变星形 logo + name + desc + 来源徽标；**只展示无开关**（无 toggle/删除/预览按钮）。
5. **切 group tab**：playground 无 squad → 空态（icon + muted 文案，如「无 group skills」）。
6. **切 global tab**：看到 builtin + app 层全局 skills 列表（当前环境若有的条目）。
7. **关闭弹层**：点遮罩或关闭按钮，弹层关闭。

## 验收口径（executor 自由心证）
- **pass**：skills 入口存在（悬浮菜单第 3 项）、弹层 3 tab 分组正确、卡片渲染 name+desc+徽标、playground group tab 空态、可关闭。
- **small**：走通但文案/视觉小瑕疵（不影响主路径）。
- **blocking**：skills 入口找不到 / 弹层打不开 / tab 分组错乱 / 卡片不渲染 / 关键 API 500。

## 依赖
- `specs/ui/overall/00-app-guide.md` §3.1（Playground 路径）
- `specs/prd/version_logs/v0.0.205.t2_cons/change_log.md` §定案1（skills 入口）+ §3 路径 A/B/C
- `specs/ui/components/chat-page/component-chat-float-menu.md`（悬浮菜单）+ `component-skills-modal.md`（弹层，T3 编码前置产出）
