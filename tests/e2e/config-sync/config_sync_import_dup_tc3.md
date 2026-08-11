# ET case: EC-3 导入含重名 provider

> case_id: config_sync_import_dup_tc3
> 来源: test-plan EC-3

## 前置
- dev app 已启动
- 已有一份导出文件（含至少 1 个 provider）
- 本地已存在与文件中同 label 的 provider（预先确认本地 provider 列表）

## 操作目标

1. 打开「应用设置」→「配置同步」
2. 点「导入配置」
3. 选择之前导出的 .json 文件
4. 截图：应显示树形导入页，与本地重名的 provider 节点应显示「存在重名」标签
5. 截图：验证「存在重名」标签仅提示，不阻止勾选（仍可选中导入）
6. 勾选重名 provider → 点「导入」→ 确认 modal → 执行
7. 验证：导入成功后，本地出现 2 个同 label provider（API 无唯一性约束）
8. 截图模型 tab 确认 2 个同 label provider

## 判定
- pass: 重名标签显示 + 可勾选 + 导入后本地出现重复 label
- small: 走通但标签文案微差异
- blocking: 重名不显示标签 / 阻止勾选 / 导入失败
