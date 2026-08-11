# ET case: EC-1 导出全部配置

> case_id: config_sync_export_all_tc1
> 来源: test-plan EC-1

## 前置
- dev app 已启动（dev.env, API_PORT=3710, WEB_PORT=8788）
- 已有至少 1 个 provider（minimax 等）

## 操作目标

1. 打开「应用设置」→ 展开系统配置 → 找到「配置同步」tab
2. 截图 landing 态（应有两个大按钮：导出配置 / 导入配置）
3. 点「导出配置」→ 截图（应显示树形勾选页，所有节点默认全选）
4. 不修改任何勾选 → 点「导出」按钮
5. 验证：文件下载成功（文件名格式 `rocky_agent_config_*.json`）
6. 解密下载文件，验证内容包含全部 provider + 4 个工具 tab 配置

## 判定
- pass: 全流程走通，文件下载 + 解密后包含全部 provider + 4 工具 tab
- small: 走通但文件名格式轻微偏差或解密内容有小差异
- blocking: 导出不工作 / 树形页不显示 / 下载失败
