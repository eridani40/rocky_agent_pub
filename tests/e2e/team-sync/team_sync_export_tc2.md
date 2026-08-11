# ET case: 团队同步导出 zip

> case_id: team_sync_export_tc2
> 来源: test-plan EC-1（导出部分）+ leader 派单

## 前置
- dev app 已启动
- 已在团队同步 landing 页

## 操作目标

1. 点「导出团队」
2. 验证 zip 下载成功（文件名 `rocky_agent_team_{name}_{timestamp}.zip`）
3. 解压 zip 验证内容：
   - manifest.json 存在（含 slug/name/description/leaderName/members）
   - AGENTS.md 存在
   - .rocky/ 全套（agents/ 无 memberId 后缀、skills/、memory/、settings.json 等）
   - 无 members/ outputs/ reports/ states/ specs/ 等排除目录
4. toast「导出成功」提示

## 判定
- pass: zip 下载 + 可解压 + 含 manifest/AGENTS.md/.rocky 全套 + 排除目录不存在
- small: zip 下载但个别文件缺失（非关键）/ 文件名偏差
- blocking: 下载失败 / zip 损坏 / 关键文件缺失
