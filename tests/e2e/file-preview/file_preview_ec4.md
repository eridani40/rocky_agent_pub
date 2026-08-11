# ET case: 编辑 → 外部改文件 → 保存 → 冲突 modal → 取消（重新加载）

> case_id: file_preview_ec4
> 来源: PRD §6 EC-4（UC-5 覆盖）+ test-plan §4 EC-4
> 前置: v0.0.320 冲突检测功能已编码完成（Task 1 后端 + Task 2 前端），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页
- workspace 目录内至少 1 个文本文件（如 `a.md`），内容已知（如 `line1`）
- **需要终端/文件系统访问**（执行者可用 bash 修改文件——外部修改用终端完成，模拟他人/agent 改动）

## 操作目标

1. 工作区点 `a.md` → 预览区开 tab（view 模式，读取时拿到 version=V1）
2. 点「编辑」→ 进入 edit 模式
3. 修改内容（如加一行 `edited-by-et`）→ dirty ● 出现，**不保存**
4. **外部改文件**（终端执行）：`echo "external-change-$(date +%s)" >> <workspace>/a.md`（改磁盘 mtime + size → version 变化）
5. 回到 app 点「保存」→ POST save 带 expectedVersion=V1 → **409 冲突** → 弹冲突 modal：
   - 标题「文件已被外部修改」
   - 两选项：「取消」（重新加载最新内容）/「覆盖」（强制写入）
6. 点「取消」→ 重新加载最新内容（GET 拉新 content + version）→ 回 view 模式
7. 断言：
   - 冲突 modal 出现（文案「文件已被外部修改」）
   - 点取消后 view 内容 = 外部修改后的最新内容（含 `external-change-` 行，不含本地 `edited-by-et` 草稿）
   - dirty 清除，回 view
8. 截图留证：edit 态 + 冲突 modal + 取消后 view（最新内容）

## 判定
- pass: 外部改 → 保存 → 冲突 modal 出现 → 取消 → 重新加载最新内容回 view
- small: 冲突 modal 出现且取消生效但有视觉/文案小瑕疵
- blocking: 保存不弹冲突 modal / 直接覆盖成功 / 取消后内容不是最新 / 取消后没回 view

## 备注
- 版本协议：读返回 `version = ${mtimeMs}:${size}`；save 带 expectedVersion 不匹配 → `409 {error:'conflict', currentVersion}`（D9/PRD §2.7）
- **外部改文件操作指引**：执行者在留证步骤间隙用 bash 直接改磁盘文件（`echo ... >>` 或 `sed -i`），确保 mtime/size 变化；改完可先 `stat` 确认 version 变了再回 UI 点保存
- 冲突「取消」= 放弃本地修改 → 重新加载（D4 conflictState → cancel = reload）
- 本 case 只验证「取消」路；「覆盖」路由 EC-5 单独覆盖
