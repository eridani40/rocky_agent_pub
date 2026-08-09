# playground-md-image-view — Markdown Viewer 图片渲染 + 点击放大 + 危险协议拦截

> 纯自然语言 case（v0.0.188 范式）；PRD `specs/prd/version_logs/v0.0.286.md_image/prd.md` UC-1/2/4/5/7 的 E2E 主链路冒烟。
> executor 读 case.md + `specs/ui/overall/00-app-guide.md` §3.1，按 snapshot 文案/位置自选定位方式。

## Use Case

作为用户，我想在 workspace 面板点开一个包含本地图片、网络图片和不安全链接的 `.md` 文件，看到图片正确渲染（而不是原始 markdown 语法）、能点击放大查看、危险的 javascript: 链接被拦截不执行——验证 markdown viewer 的图片渲染主链路。

## 前置条件

- env.sh 已起好环境（headless 或 electron 模式）。
- Playground 已建/选一个会话；workspace 面板可见（chat 页右侧第 3 栏；若收起则点展开 chevron）。
- **executor 需在 workspace 目录创建一个 fixture `.md` 文件 + 一张本地小图**（<2MB），方法见下方步骤 1-2。

## 操作目标（编号步骤）

### 准备 fixture（步骤 1-2）

1. **创建 fixture 图片**：在 workspace 目录下建 `images/` 子目录，放入一张小图片（<2MB，如 `test.png`）。
   - 方法：可用 agent 帮忙生成（发消息「在 workspace 的 images 目录放一张小 png 图片」），或 executor 通过文件系统/ IPC 手动创建。
   - 图片要小（<2MB），避免触发 too-large 分支干扰主路径。
2. **创建 fixture md 文件**：在 workspace 根目录建 `md-image-test.md`，内容包含以下 5 段（每段间空行分隔）：

   ```markdown
   # 图片渲染测试

   ![本地图片](images/test.png)

   ![网络图片](https://www.google.com/favicon.ico)

   ![危险链接](javascript:alert(1))

   ![不存在的图](images/not-exist.png)
   ```

   - 第 1 段标题用于确认 viewer 正常打开。
   - `![本地图片](images/test.png)` = UC-1 本地相对路径图片。
   - `![网络图片](https://...)` = UC-2 网络图片。
   - `![危险链接](javascript:alert(1))` = UC-7 危险协议。
   - `![不存在的图](images/not-exist.png)` = UC-5 error 降级。

### 主验证（步骤 3-7）

3. **进入 chat 页 + 确认 workspace 可见**：照 `00-app-guide.md` §3.1——从 nav-rail 点 Playground → 选/建会话 → 确认右侧 workspace 文件树面板可见。

4. **UC-1/2/5/7：点开 fixture md 文件 → 验证图片渲染**：在 workspace 文件树找到刚建的 `md-image-test.md`，点击它 → app 内弹出 md viewer modal（默认「👁 查看」模式）。
   - **UC-1 本地相对路径**：验证 `![本地图片](images/test.png)` 渲染成**实际图片**（`<img>`，可见图形内容），**不是**显示原始语法文本 `![本地图片](images/test.png)`。
   - **UC-2 网络图片**：验证 `![网络图片](https://...)` 渲染成图片（`<img>`），直渲加载（可能短暂 loading 后出现）。
     - 注：网络图片加载依赖外网可达性。若 headless 环境无外网导致网络图加载失败（显示 alt + 错误态），记 small，**非 blocking**。
   - **UC-5 error 降级**：验证 `![不存在的图](images/not-exist.png)` 不崩布局、不弹错误窗——显示 alt 文本「不存在的图」+ 错误/未找到提示（muted 样式）。
   - **UC-7 危险协议拦截**：验证 `![危险链接](javascript:alert(1))` **没有**渲染成图片、**没有**弹出 alert 对话框、**没有**执行脚本——显示降级文本（alt 文本或原始文本，muted 样式）。
     - 注：验证后检查页面是否有 alert 弹窗（playwright 可检测 dialog 事件）；有 alert = **blocking**。

5. **UC-4：点击放大本地图片**：在 viewer 里找到 UC-1 渲染出的本地图片，点击它。
   - **验证**：弹出放大预览（全屏遮罩 + 大图），图片可见且放大。
   - **关闭**：按 Esc 或点遮罩关闭放大预览，回到 md viewer。

6. **（可选）点击放大网络图片**：若 UC-2 网络图成功渲染，点击它验证也能放大。
   - 若网络图未渲染（无外网），跳过此步，记 small，**非 blocking**。

7. **关闭 md viewer**：点 ✕ 或按 Esc 关闭 md viewer modal，回到 chat 区。

## 验收口径（executor 自由心证）

- **pass**：
  - UC-1 本地相对路径图片渲染成 `<img>`（非原始语法）
  - UC-2 网络图片渲染成 `<img>`（若外网可达）
  - UC-4 点击本地图片弹出放大预览 + Esc/遮罩可关闭
  - UC-5 不存在的图片不崩布局、显示 alt + 错误提示
  - UC-7 javascript: 危险协议被拦截（不渲染图片、不执行脚本、无 alert 弹窗）
  - 主链路贯通
- **small**：主路径走通但有视觉/文案小瑕疵；或网络图片因无外网未渲染（需注明）；不影响本地图片+点击放大+危险拦截三核心
- **blocking**：
  - 本地相对路径图片**不渲染**（显示原始 markdown 语法 `![...]`）
  - 点击图片**无放大预览**弹出
  - javascript: 危险协议**未拦截**——出现 alert 弹窗或脚本执行
  - md viewer 弹不出 / 内容不渲染 / 关键元素找不到

## 依赖

- `specs/ui/overall/00-app-guide.md` §3.1（Playground 路径 + workspace 面板点文件分流）
- `specs/ui/components/common/component-modal-md-editor.md`（md viewer 可见文案：👁 查看 / ✕ 关闭）
- `specs/prd/version_logs/v0.0.286.md_image/prd.md` §4 UC-1/2/4/5/7（图片渲染用户路径）
