# ET case: 编辑 → 外部改文件 → 保存 → 冲突 modal → 覆盖（强制写入）

> case_id: file_preview_ec5
> 来源: PRD §6 EC-5（UC-5 覆盖）+ test-plan §4 EC-5
> 前置: v0.0.320 冲突检测功能已编码完成（Task 1 后端 + Task 2 前端），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页
- workspace 目录内至少 1 个文本文件（如 `b.md`），内容已知（如 `line1`）
- **需要终端/文件系统访问**（执行者可用 bash 修改文件）

## 操作目标

1. 工作区点 `b.md` → 预览区开 tab（view 模式，读取时拿到 version=V1）
2. 点「编辑」→ 进入 edit 模式
3. 修改内容（如加一行 `overwrite-by-et`）→ dirty ● 出现，**不保存**
4. **外部改文件**（终端执行）：`echo "external-change-$(date +%s)" >> <workspace>/b.md`
5. 回到 app 点「保存」→ 409 冲突 → 弹冲突 modal「文件已被外部修改」
6. 点「覆盖」→ force 重发（带 force:true）→ 强制写入成功 → 回 view
7. 断言：
   - 冲突 modal 出现
   - 点覆盖后保存成功（toast「已保存」或回 view 无错误）
   - view 内容 = 本地草稿（含 `overwrite-by-et` 行）→ **覆盖了外部改动**
   - 磁盘验证（终端 `cat`）：文件内容含本地草稿行（外部 `external-change-` 行可能被覆盖或共存——以本地草稿为最终态）
8. 截图留证：edit 态 + 冲突 modal + 覆盖后 view + toast

## 判定
- pass: 外部改 → 保存 → 冲突 modal → 覆盖 → 强制写入成功回 view，磁盘文件为本地草稿
- small: 覆盖成功但 toast/回 view 有小瑕疵
- blocking: 覆盖不生效 / 保存失败 / 磁盘文件不是本地草稿最终态

## 备注
- 覆盖 = force 重发（PRD §2.7「覆盖：强制写入（带 force 重发）→ 覆盖外部改动 → 成功回 view」）
- force 时不做版本校验（last-write-wins；force 覆盖时文件被再次外部改动 → 最后一次写入胜，PRD §5.3）
- 磁盘验证命令示例：`cat <workspace>/b.md` 确认含 `overwrite-by-et`
