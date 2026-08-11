# ET case: 文件夹点击行为（展开/收起 + hover「打开文件夹」系统打开）

> case_id: file_preview_ec7
> 来源: PRD §6 EC-7（UC-7 覆盖）+ test-plan §4 EC-7
> 前置: v0.0.320 文件树改造已编码完成（Task 2 D7），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页
- workspace 目录内有文件夹（含子文件/子文件夹），如 `src/`（含 `app.ts`）、`docs/`（含 `guide.md`）

## 操作目标

1. 工作区文件树找到文件夹 item（如 `src/`）
2. **点文件夹 item 名字/图标区**（非 twisty）→ 断言展开子目录（不再系统打开——v0.0.320 起文件夹 item 点击 = toggle 展开）
3. **再点同一文件夹 item** → 断言收起
4. **点 twisty** → 同样展开/收起（双入口同一 toggle，防双发）
5. **hover 文件夹 → 点「打开文件夹」按钮**（`.ws-act`，hover 显示）→ 断言系统文件管理器打开目标目录（保留行为）
6. 截图留证：文件夹收起态 + item 点击展开 + 再点收起 + hover 显示「打开文件夹」按钮 + 点后系统打开

## 判定
- pass: 文件夹 item 点击展开/收起 + twisty 等价 + hover「打开文件夹」系统打开，双行为正确
- small: toggle 正常但「打开文件夹」按钮样式/位置有小瑕疵
- blocking: 点文件夹 item 仍系统打开 / 点 twisty 不展开 / 「打开文件夹」按钮缺失或点了没反应

## 备注
- v0.0.320 文件夹 item 点击行为从「系统打开」改为「展开/收起」（PRD §2.4 D7）
- 「打开文件夹」按钮点击 `stopPropagation`（不触发展开），`POST /workspace/open` 系统文件管理器打开（保留）
- 空文件夹无 twisty 不可展开（既有行为）；symlink→dir 可逐层展开（既有行为）
- 「打开文件夹」系统打开动作在 headless 下可能无可见窗口——可验证请求发出（POST /workspace/open 200）或结合桌面观察
