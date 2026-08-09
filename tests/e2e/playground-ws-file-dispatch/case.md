# workspace 文件类型分流 + 图片预览

## Use Case
用户在 workspace 文件树点击不同类型文件，验证分流逻辑：图片走只读 viewer，文本走 editor，未识别类型走系统打开（无「二进制文件无法预览」错误 pill）。

## 前置条件
- 已进入一个有 workspace 的会话页面（studio/playground 均可）
- workspace 文件树可见

## 操作目标

1. **点击 png 图片** → 弹出图片 viewer（modal），显示图片内容，只读无编辑入口，✕/遮罩/Esc 可关闭
2. **点击 jpg/webp/gif/svg**（如存在）→ 同样走图片 viewer
3. **点击 .md/.txt/.json/.log 等文本文件**（12 格式白名单：md/json/jsonl/yaml/xml/toml/csv/tsv/txt/ini/env/log）→ 走 editor（可编辑）
4. **点击 .url 文件** → 浏览器打开链接（不弹错误）
5. **点击 .py/.java/.ts 等未识别类型**（.ts 不在白名单）→ 触发系统打开（不出现「无法预览」占位 pill、不报错）

## 验收口径

- **pass**：上述分流全部正确，无「二进制文件无法预览」错误 pill 出现
- **small**：分流正确但有视觉瑕疵（如 viewer 尺寸不完美）
- **blocking**：png 仍报「二进制无法预览」/ 图片 viewer 不弹 / 文本文件打不开 / 未识别类型弹错误 pill
