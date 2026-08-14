# ET case: 文件树点 big.md(6MB+) → 系统打开 + 返回无残留

> case_id: file_open_et2
> 来源: test-plan §4 ET-2（覆盖 PRD §5 路径 3 + 路径 10：>5MB 文本系统打开 + 无残留 tab/报错 pill）

## 前置条件
- ET 环境已启动（env.sh start file_open_et2，WEB_URL 可用）
- 会话 workspace 内含 `big.md`（19MB > 5MB，fixtures/big.md）

## 操作目标

1. 进入 Playground chat 页，右侧 workspace 面板文件树可见 `big.md`
2. 在文件树点击 `big.md`
3. 断言（判定信号）：
   - **app 内无预览 tab 出现**（中间预览区不变）
   - **无 viewer 弹层**
   - **无报错 pill**
   - （系统程序如 TextEdit 启动属 OS 行为，不阻塞判定）
4. 返回后（等 2-3s）再次断言：**无残留预览 tab / 无报错 pill**（路径 10）
5. 截图 + snapshot 留证

## 判定
- pass: 点 big.md → 无预览 tab / 无弹层 / 无报错 pill，返回后也无残留
- small: 系统打开但有小瑕疵（短暂 pill 后消失等）
- blocking: 点 big.md 进预览 tab（尝试加载 19MB）/ 报错 pill / 残留 tab

## 备注
- >5MB 文本（.md/.json/.py）→ 系统打开不进预览（stat 判定 size>5MB → 系统打开）
- 路径 10：打开后返回无残留 tab / 无报错 pill
