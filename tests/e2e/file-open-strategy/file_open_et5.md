# ET case: 聊天链点 data.csv(1KB) → 系统打开（与文件树一致）

> case_id: file_open_et5
> 来源: test-plan §4 ET-5（覆盖 PRD §5 路径 2：聊天链点 csv 系统打开，两处一致铁律）

## 前置条件
- ET 环境已启动（env.sh start file_open_et5，WEB_URL 可用）
- 会话 workspace 内含 `data.csv`（1KB，fixtures/data.csv）
- 会话 chat 区有一条 agent 回复，内含指向 `data.csv` 的 markdown 链接（相对路径）

## 操作目标

1. 进入 Playground chat 页，会话内 agent 回复含 `[data.csv](data.csv)` 或等效链接
2. 点击聊天消息里的 csv 链接
3. 断言（判定信号）：
   - **app 内无预览 tab 出现**（中间预览区不变）
   - **无 viewer 弹层**
   - **无报错 pill**
   - （系统程序启动属 OS 行为，不阻塞判定）
4. 截图 + snapshot 留证

## 判定
- pass: 聊天链点 csv → 系统打开（与文件树行为一致，无预览 tab / 弹层 / 报错）
- small: 系统打开但有小瑕疵
- blocking: 聊天链点 csv 进预览 tab / 弹 viewer / 报错 pill / 与文件树行为不一致

## 备注
- 两处铁律：文件树 + 聊天链共享 openLocalPath 分发 lib → csv 无条件系统打开（v0.0.339）
- 若会话无现成链接，先让 agent 回复一条含 csv 相对路径链接的消息
