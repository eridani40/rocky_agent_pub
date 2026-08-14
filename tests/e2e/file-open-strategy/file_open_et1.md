# ET case: 文件树点 data.csv(1KB) → 系统打开不进预览

> case_id: file_open_et1
> 来源: test-plan §4 ET-1（覆盖 PRD §5 路径 1+8：csv/tsv 无条件系统打开）
> 前置: v0.0.339 文件打开策略已编码（openLocalPath 分流）

## 前置条件
- ET 环境已启动（env.sh start file_open_et1，WEB_URL 可用）
- 会话 workspace 内含 `data.csv`（1KB，fixtures/data.csv）

## 操作目标

1. 进入 Playground chat 页，右侧 workspace 面板文件树可见 `data.csv`
2. 在文件树点击 `data.csv`
3. 断言（判定信号）：
   - **app 内无预览 tab 出现**（中间预览区不变）
   - **无 viewer 弹层**
   - **无报错 pill**
   - （系统程序如 Numbers/Excel 启动属 OS 行为，不阻塞判定）
4. 截图 + snapshot 留证

## 判定
- pass: 点 csv → app 内无预览 tab / 无弹层 / 无报错 pill（系统打开成功）
- small: 系统打开但有小瑕疵（如延迟、误报 pill 短暂出现后消失）
- blocking: 点 csv 进了预览 tab / 弹 viewer / 报错 pill

## 备注
- csv/tsv 无条件系统打开（不 stat，onEditor 不调）——覆盖路径 1（1KB 小文件也系统打开）+ 路径 8（≤5MB CSV 仍系统打开无条件）
