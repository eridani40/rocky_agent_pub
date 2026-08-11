# ET case: EC-4 导入工具配置（仅 web_search）

> case_id: config_sync_import_tool_tc4
> 来源: test-plan EC-4

## 前置
- dev app 已启动
- 准备一份仅含 web_search 工具配置的导出文件（先全量导出再手动构造，或导出仅勾选 web_search）

## 操作目标

1. 打开「应用设置」→「配置同步」
2. 点「导入配置」
3. 选择仅含 web_search 工具的导出文件
4. 截图：树形导入页应只显示 web_search（及 providers 如果文件含）
5. 取消勾选所有 provider（只导入工具）
6. 勾选 web_search → 点「导入」→ 确认 → 执行
7. 验证：导入成功 toast
8. 检查本地 web_search 配置是否被替换，其他工具不受影响

## 判定
- pass: 导入成功，web_search 被替换，其他工具不变
- small: 走通但导入结果提示不够清晰
- blocking: 导入失败 / 覆盖了不该覆盖的工具
