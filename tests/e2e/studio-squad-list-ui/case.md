# studio-squad-list-ui — Studio 团队列表 UI 升级验证

## Use Case
作为 Rocky 的 Studio 用户，我想看到团队列表升级为彩色头像+两行布局+排序置顶，验证视觉效果和交互正常。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- 至少 2 个 squad 存在（便于验证排序和置顶）。

## 操作目标（编号步骤）

1. **进入 Studio**：照 `specs/ui/overall/00-app-guide.md`——从 nav-rail 点 Studio 入口，落到团队首页。
2. **查看团队列表**：观察左侧 sidebar 的 squad 列表：
   - 每行有 32×32 彩色字母头像（不同 squad 颜色不同）
   - 两行布局：第一行团队名（15px 半粗），第二行「X 在线 · Y 工作中」（11px 灰色）
   - 如果有工作中的成员，第二行「工作中」数字前有橙色脉冲圆点动画
3. **验证排序**：列表按最后活跃时间倒序（最新活跃的 squad 排前面）。
4. **验证置顶**：hover 某行 squad，出现 pin 按钮（图钉图标），点击置顶：
   - 置顶的 squad 排到列表最前
   - 刷新页面后置顶状态保持（localStorage 持久化）
5. **验证选中态**：点击某个 squad，该行高亮（accent 背景色）。
6. **验证 SSE 实时更新**（可选）：打开另一个窗口操作 member（如 hire/deploy/bench），观察 sidebar 数字实时更新。

## 验收口径（executor 自由心证）
- **pass**：列表显示彩色头像+两行布局，排序正确，置顶交互正常，选中态正确。
- **small**：显示正常但有视觉小瑕疵（间距/颜色微差）。
- **blocking**：列表不显示/头像不显示/排序错误/置顶不工作/选中态失效。

## 依赖
- specs/ui/overall/00-app-guide.md（Studio 路径）
- temp/sidebar-design-options.html Option B（视觉基线）
