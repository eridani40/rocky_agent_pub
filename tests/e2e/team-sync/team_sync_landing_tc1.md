# ET case: 团队同步 landing 页

> case_id: team_sync_landing_tc1
> 来源: test-plan EC-1（landing 部分）+ leader 派单

## 前置
- dev app 已启动（dev.env, API_PORT=3710, WEB_PORT=8788）
- 当前有 squad（dev 数据目录）

## 操作目标

1. 打开「应用设置」→ 用户设置区（非系统收起区）
2. 找到「团队同步」tab（在记忆/config_sync 之后）
3. 点击进入 → 截图 landing 页
4. 验证 landing 页渲染正确：
   - 显示当前团队名 + 成员数
   - 两个入口按钮：「导出团队」/「导入团队」

## 判定
- pass: tab 存在 + landing 页两个入口按钮渲染正确 + 团队信息显示
- small: 渲染正确但文案/信息有小瑕疵
- blocking: tab 不存在 / landing 页空白 / 按钮缺失
