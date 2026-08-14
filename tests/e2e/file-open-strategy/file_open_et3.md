# ET case: 文件树点 small.py(100KB) → 内置预览 tab 无回归

> case_id: file_open_et3
> 来源: test-plan §4 ET-3（覆盖 PRD §5 路径 5：≤5MB 文本内置预览无回归）

## 前置条件
- ET 环境已启动（env.sh start file_open_et3，WEB_URL 可用）
- 会话 workspace 内含 `small.py`（100KB ≤ 5MB，fixtures/small.py）

## 操作目标

1. 进入 Playground chat 页，右侧 workspace 面板文件树可见 `small.py`
2. 在文件树点击 `small.py`
3. 断言（判定信号）：
   - **预览区（中间栏）出现 tab**，tab 标题 = `small.py`
   - 内容区显示文件纯文本内容（`<pre>` 渲染）
   - **无系统打开 / 无弹层**
4. 截图 + snapshot 留证

## 判定
- pass: 点 small.py → 预览区开 tab 显示内容，无系统打开/弹层
- small: 预览 tab 打开但有视觉瑕疵（标题/内容样式小问题）
- blocking: 点 small.py 系统打开 / 弹层 / 预览区不开 tab / 内容不显示

## 备注
- ≤5MB 文本 → 内置预览 tab（无回归，v0.0.320 既有行为）
- 100KB 远小于 5MB 阈值，应稳定进内置
