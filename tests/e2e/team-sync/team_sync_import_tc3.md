# ET case: 团队同步导入建队

> case_id: team_sync_import_tc3
> 来源: test-plan EC-1（导入部分）+ leader 派单

## 前置
- dev app 已启动
- 已有导出的 zip（复用 team_sync_export_tc2 产物）

## 操作目标

1. 在团队同步 landing 页点「导入团队」
2. 选择导出的 zip 文件
3. 截图 preview 页：manifest 信息卡（团队名/描述/leader/成员数）
4. 团队名输入框（预填 manifest.name）
5. 点「导入」→ 确认 modal → 执行
6. 验证：建队成功 toast + 新团队出现在 squad 列表
7. 可选：新团队与源团队配置一致（成员名一致）

## 判定
- pass: preview 信息卡 + 填名 + 确认建队成功 + toast
- small: 建队成功但 preview 信息有瑕疵
- blocking: 无法导入 / 预览失败 / 建队失败 / toast 缺失
