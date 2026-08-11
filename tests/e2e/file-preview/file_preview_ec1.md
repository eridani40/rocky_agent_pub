# ET case: 工作区点编程语言文件 → 预览区开 tab

> case_id: file_preview_ec1
> 来源: PRD §6 EC-1（UC-1 覆盖）+ test-plan §4 EC-1
> 前置: v0.0.320 文件预览区功能已编码完成（Task 2/3），dev 环境已启动

## 前置条件
- dev app 已启动（dev.env, API_PORT=3710, WEB_PORT=8788），进入有 workspace 的 chat 页（playground 或 studio 单聊）
- 会话 workspace 目录内有 `.py` 文件（如 `src/app.py`；若无则先在工作区创建测试文件）

## 操作目标

1. 打开「应用设置」无关 —— 直接进入 chat 页右侧 workspace 面板，文件树可见
2. 在文件树中点击一个编程语言文件（如 `app.py`）
3. 断言：
   - 预览区（中间栏）出现，新建 tab「app.py」（view 模式）
   - tab 标题 = 文件名 basename；内容区显示文件纯文本内容（`<pre>` 渲染，无语法高亮）
   - **不再弹出系统打开 / 弹层 modal**（v0.0.320 起编程语言文件进内置 viewer）
4. 截图留证：tab + 内容区 + 无弹层

## 判定
- pass: 点 `.py` → 预览区开 tab 显示内容，无系统打开/弹层
- small: 预览区开 tab 成功但有视觉瑕疵（tab 标题/内容区样式小问题）
- blocking: 点 `.py` 仍系统打开 / 弹层弹出 / 预览区不开 tab / 内容不显示

## 备注
- 编程语言后缀（py/js/ts/jsx/tsx/java/go/rs/c/cpp/h/hpp/cs/rb/php/swift/kt/sh 等）全部映射 `'code'` 分类 → 内置 viewer（PRD §2.3 D11）
- 与旧行为对比：v0.0.280 前编程语言走系统打开；v0.0.320 起改内置 viewer
