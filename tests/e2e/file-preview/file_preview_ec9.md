# ET case: 保存成功闭环（toast「已保存」+ 回 view + dirty 清除）

> case_id: file_preview_ec9
> 来源: PRD §6 EC-9（UC-4 覆盖）+ test-plan §4 EC-9
> 前置: v0.0.320 预览区编辑保存功能已编码完成（Task 2 D4/D6），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页
- workspace 目录内至少 1 个文本文件（如 `a.md`），内容已知（如 `line1`）

## 操作目标

1. 工作区点 `a.md` → 预览区开 tab（view 模式，记录原始内容）
2. 点「编辑」→ 进入 edit 模式（textarea）
3. 修改内容（如追加 `edited-by-et-<ts>`）→ dirty ● 出现
4. 点「保存」→ 断言保存闭环：
   - toast「已保存」出现
   - 自动回 view 模式（textarea → 渲染视图）
   - dirty ● 清除（tab 标题旁圆点消失）
   - view 内容 = 修改后的新内容（本地草稿已落盘）
5. 磁盘验证（终端）：`cat <workspace>/a.md` 确认包含 `edited-by-et-<ts>` 行（真实落盘）
6. 再点「编辑」→ 内容 = 保存后的最新内容（version 已更新，无冲突）
7. 截图留证：edit 态（dirty ●）+ 点保存后 toast + 回 view + 磁盘内容

## 判定
- pass: 保存成功 → toast「已保存」+ 回 view + dirty 清除 + 磁盘真实落盘
- small: 保存成功但 toast/回 view 时机有小瑕疵
- blocking: 保存失败 / 无 toast / 不回 view / dirty 不清除 / 磁盘未落盘

## 备注
- 保存协议：POST save 带 expectedVersion（PRD §2.6 D4）→ 成功 toast「已保存」+ 切回 view
- 保存成功后 tab version 标记更新为返回的新 version（PRD §2.6）
- 保存失败 → 留在 edit 模式显示错误（textarea 保留供重试，PRD §5.2）——本 case 不覆盖失败路径（EC-4/5 覆盖冲突）
- 无 autosave（不点保存不落盘，PRD §2.6）
