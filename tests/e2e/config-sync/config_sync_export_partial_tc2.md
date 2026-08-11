# ET case: EC-2 导出部分配置（取消工具配置）

> case_id: config_sync_export_partial_tc2
> 来源: test-plan EC-2

## 前置
- dev app 已启动
- 已导出过一份全量配置（EC-1 产物可复用）

## 操作目标

1. 打开「应用设置」→「配置同步」
2. 点「导出配置」
3. 取消勾选「工具配置」folder（联动取消所有工具子节点）
4. 截图（工具配置 folder unchecked，模型配置 folder 仍 checked）
5. 点「导出」
6. 解密下载文件，验证：
   - providers 包含全部 provider
   - tools 为空对象 `{}`（或不含任何工具 key）

## 判定
- pass: 走通，文件 providers 有数据，tools 为空
- small: 走通但 tools 非空（含部分残留）
- blocking: folder 联动不工作 / 导出仍含工具数据
