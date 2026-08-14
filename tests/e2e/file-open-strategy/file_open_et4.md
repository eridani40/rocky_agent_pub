# ET case: 文件树点 photo.png(>5MB) → 内置弹层 viewer 不回归

> case_id: file_open_et4
> 来源: test-plan §4 ET-4（覆盖 PRD §5 路径 7：图片（含 >5MB）内置弹层 viewer 无回归无大小限制）

## 前置条件
- ET 环境已启动（env.sh start file_open_et4，WEB_URL 可用）
- 会话 workspace 内含 `photo.png`（37MB > 5MB，fixtures/photo.png）

## 操作目标

1. 进入 Playground chat 页，右侧 workspace 面板文件树可见 `photo.png`
2. 在文件树点击 `photo.png`
3. 断言（判定信号）：
   - **内置弹层 viewer 出现**（图片查看弹层，img 完整渲染 + 标题）
   - **无系统打开 / 无预览 tab**
   - 图片 >5MB 仍弹层（无大小限制）
4. 截图留证（**vision_check.py 判读弹层渲染**，禁 Read 看图）
5. Esc/遮罩关闭弹层

## 判定
- pass: 点 photo.png → 内置弹层 viewer 出现且渲染正常（vision_check 确认）
- small: 弹层出现但视觉瑕疵（标题/尺寸小问题）
- blocking: 点 photo.png 系统打开 / 预览 tab / 弹层不出现 / 渲染失败

## 备注
- 图片（png/jpg/jpeg/gif/webp/svg）无条件内置弹层 viewer（v0.0.269 行为），无大小限制
- >5MB 文本阈值只对文本生效，图片不 stat 直接弹层
