---
name: web-app-testing
description: webapp 测试与环境统一手册——AT mjs case（node --test）/ ET env.sh / 视觉 / dump + 环境划分·端口分配（版本编码+注册表+lsof+窗口）·DATA_DIR 隔离·启停协议。何时用：写/跑测试、起/停环境、配端口、隔离数据目录、清残留进程。
source: agent
production_method: consolidation
evolvable: true
updated: '2026-08-15T13:30:00.000Z'
---
# web-app-testing（测试 + 环境统一手册）

## 何时用
- **AT（API 测试）**：api-test-designer 写 `case.test.mjs`，api-test-executor 起 env + `node --test`
- **ET（E2E 测试）**：e2e-test-executor 按 case.md 玩 app
- **视觉判定 / UI 分析**：vision_check.py + playwright-cli dump 页面
- **test-plan 设计**：版本验证前产出 AT/ET case 清单
- **环境管理**：起/停 dev/test 环境、分配端口、隔离 DATA_DIR、清残留进程

## 三轨总览
| 轨 | 路径 | 框架 | 入口 |
|----|------|------|------|
| AT | `${TESTS_DIR}/api/` | `case.test.mjs`（node:test + fetch）+ 真实调 API + 429 skip | env_start → `node --test` → env_shutdown |
| ET | `${TESTS_DIR}/e2e/` | case.md 自然语言 + executor agent + env.sh 启停 | `bash ${TESTS_DIR}/e2e/env.sh start/stop` + 委派 executor |
| 视觉 | `${TESTS_DIR}/e2e/vision_check.py` | 单图检查 / 多图对比 | `python3 ${TESTS_DIR}/e2e/vision_check.py ...` |

**两轨禁并发**：AT 与 ET 共享端口注册表（`${TESTS_DIR}/lib/port_alloc.sh`）+ DATA_DIR，必须串行。跑前先查对方占用（lsof 端口段 / .env_port / ps vite）。

## 环境与端口（测试前置）

一套环境 = **进程 + 端口 + 数据目录** 三件事，隔离不到位症状千奇百怪（抢端口/连错服务/误杀兄弟 worktree/测试污染 dev 数据）。

### 环境划分（dev / test / prod + 自动化测试隔离段）
每环境一个显式身份（`APP_ENV`/`NODE_ENV`）+ 专属 `.env` + 专属 DATA_DIR：

| 环境 | 身份变量 | 端口（参考） | DATA_DIR | .env |
|------|---------|-------------|----------|------|
| dev | `APP_ENV=dev` | API 3710 / WEB 8788 | `~/.xxx_dev` | `dev.env`（开发者自填 key） |
| test | `APP_ENV=test` | API 3700 / WEB 8787 | `~/.xxx_test` | `test.env`（提交 schema 无 secrets） |
| prod | `APP_ENV=prod` | API 3720 / WEB 8789 | `~/.xxx_prod` | `prod.env`（签名凭证占位） |
| 自动化测试段 | `NODE_ENV=test` | **独立段**（见下） | `~/.xxx_test/<wt>` 或 `~/.xxx_et_<case>` | test.env + 全局 secrets |

**secrets 分离**：提交的 test.env 只放非机密 schema（provider id 等「指路 id」），真密钥放 gitignored 全局 secrets（`${SECRETS_TEST}`）；启动脚本 overlay 两层。**dev 不碰测试端口**，两者互不干扰。

### 端口分配（四层方案）
端口是机器级全局资源，多 worktree / 多 case 并跑必须靠机制错开：

1. **段前缀 + 版本编码基址**：端口 = 段前缀 + worktree 版本后三位（如 v0.0.215 → 215）。段前缀按「环境 × 服务类型」分千段：AT API `42xxx` / WEB `44xxx`；ET API `43xxx` / WEB `45xxx` / CDP `46xxx`。版本后三位优先取 worktree 目录名（会话版本真相），无版本号回退 package.json；`10#$patch % 1000` 强制十进制。
2. **全局注册表**：`~/.xxx_test/_registry/${KIND}-${KEY}.env`（key = worktree 名或 case_id），字段 worktree/kind/key/api_port/web_port/cdp_port/pid/started_at。启动成功→写，释放→删；读时 pid 死就地清 stale 行。这是 boot-race 防抢关键。
3. **lsof 双校验**：候选循环 `base..base+window`，每个口先查注册表（防 boot-race）再 lsof 实际占用（主判定），都空才用。
4. **窗口回退**：基址偶发占用时在 +0~19 窗口内回退找空口（窗口值实践值 19）。

**禁裸 `lsof -ti:$port | xargs kill`**——误杀兄弟 worktree 根源；清残留走启停协议的 pidfile 精确 kill。

### DATA_DIR 隔离（按粒度派生）
| 粒度 | 场景 | 模式 | 生命周期 |
|------|------|------|----------|
| per-worktree | AT 整版测试 | `$HOME/.xxx_test/${WORKTREE}` | 随 worktree 存活 |
| per-case | ET 单 case | `$HOME/.xxx_et_${CASE_ID}` | case 结束即删 |
| 共享池 | provider 配置等只读资源 | `$HOME/.xxx_test/app_config/` | symlink 进各 DATA_DIR |

铁律：绝对路径展开（`$HOME/...`，禁字面 `~` 拼接）；case_id 白名单 `^[a-z0-9-]+$`；共享资源 symlink 不 copy。

### 启停协议（nohup + pidfile 精确 kill）
- **启动**：source schema+secrets → 清端口孤儿（cmdline marker 验证）→ `nohup` 后台起 server → 写 pidfile（`/tmp/${APP}-${WORKTREE}.pid` 或 ET 三行 `/tmp/${APP}-et-${CASE_ID}.pid`）→ 轮询 health（500ms 间隔，15~60s 超时）→ 写 portfile + 登记注册表，**输出 BASE_URL 等环境变量**。
- **停止**：读 pidfile → 倒序 kill（electron → web → server，父后死防孤儿化）→ 二次 SIGKILL 清顽固 → 删 pidfile/portfile → 释放注册表。ET 额外回收 chrome 孤儿 + `rm -rf` 本 case DATA_DIR。**禁 pkill -f 宽匹配**。
- **清残留**：杀前先验证 cmdline 含自己 marker（`index.ts|web|electron|bun|vite` 等），不匹配跳过——防 pid 复用误杀。进程树 BFS 收集 descendants 倒序杀。
- 删 worktree 前跑 `bash ${TESTS_DIR}/worktree_cleanup_check.sh`（exit 0=可删）。

**写 case 的人不碰端口**：case 只读 env_start 输出的 `BASE_URL` 环境变量。

## AT 框架（${TESTS_DIR}/api）

**正常写 mjs case，无自制 DSL**（2026-08-15 拍板放弃 case.yaml DSL）：node 内置 test runner + 原生 fetch + `node:assert/strict`，零自研解释器。

### 目录结构
```
${TESTS_DIR}/api/{module}/${CASE_ID}/case.test.mjs
${TESTS_DIR}/api/env_start.sh / env_shutdown.sh    # 环境启停（端口/DATA_DIR/pidfile 机制见上节）
```

### case 写法（可直接抄）
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3700';

test('create session returns 200 with id', async () => {
  const res = await fetch(`${BASE}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `test-${Date.now()}` }),   // 动态实体唯一化，不依赖清理残留
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data?.id, 'session id missing');
});

test('llm reply completes', { timeout: 240_000 }, async (t) => {   // 真调 LLM 步骤给足 timeout
  const res = await fetch(`${BASE}/session/${sid}/run`, { method: 'POST', /* ... */ });
  if (res.status === 429 || res.status === 503 || res.status === 529) return t.skip('429');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.usage?.total_tokens >= 1, 'usage snake_case');
});
```

要点：
- **断言权威 = `${SPECS_DIR}/api/` 契约**（不读产品代码）；字段名 snake_case 对齐契约
- **429/529/503 → `t.skip`**：独立 skip 状态，不算 fail、不重试不阻塞
- SSE/流式：`for await (const chunk of res.body)` 收集后断言内容/顺序
- 归零态字段可能整体缺省 → 断「存在」而非 `== 0`；硬编码无效 ULID 测 404（确定性）
- case 自包含：前置 setup + 清理 teardown 写 case 内（try/finally），不依赖外部状态

### 执行（executor 无脑执行）
```bash
bash ${TESTS_DIR}/api/env_start.sh                          # 起环境；记录输出的 BASE_URL
BASE_URL=<输出值> node --test ${TESTS_DIR}/api/             # 全量（自动发现 **/*.test.mjs，并行调度）
BASE_URL=<输出值> node --test ${TESTS_DIR}/api/chat/create-session/    # 单 case（指定目录/文件）
BASE_URL=<输出值> node --test --test-name-pattern='create' ${TESTS_DIR}/api/   # 按名过滤
bash ${TESTS_DIR}/api/env_shutdown.sh                       # 关环境（必跑，含失败后）
```
- 结果落 `${STATES_DIR}/v${VERSION}/verify/api-test/`：`node --test --test-reporter=tap > tap.txt 2>&1`（spec 人读 / tap|json 机读）
- exit 0 = 全 pass；非 0 = 有 fail；skip 不影响 exit code；assert 失败自带 expected/actual diff

## ET 框架（${TESTS_DIR}/e2e）
### env.sh 启停（orchestrator 用）
```bash
bash ${TESTS_DIR}/e2e/env.sh start ${CASE_ID} [--mode=headless|electron]   # 输出 API_URL / WEB_URL [CDP_URL]
bash ${TESTS_DIR}/e2e/env.sh stop ${CASE_ID}        # pidfile 精确 kill + 删本 case DATA_DIR + 回收 chrome 孤儿
bash ${TESTS_DIR}/e2e/env.sh case-data-dir ${CASE_ID}
bash ${TESTS_DIR}/e2e/run.sh [list | ${CASE_ID}...] [--mode=electron]      # 编排入口
```
- case_id 须匹配 `[a-z0-9-]+`；DATA_DIR = `$HOME/.${APP_NAME}_et_${CASE_ID}`。
- stop 用 pidfile 精确 kill（禁 pkill -f 宽匹配）+ 只杀本服务孤儿（cmdline marker 验证）。

### case.md（PRD 产出，自然语言）
**ET case 由 PRD 负责**：「关键用户路径」每条路径照模板写一个 case.md。**模板 = squad `.rocky/templates/e2e-case-template.md`**（Use Case / 前置条件 / 操作目标编号步骤 / 验收口径三态 / 依赖，纯自然语言零断言）；项目 `${TESTS_DIR}/e2e/` 下已积累的 case 可参考。executor 读 case.md + `${SPECS_DIR}/ui/overall/00-app-guide.md` 导航。

### 范式（agent 玩 app）
orchestrator 起环境 → 委派 e2e-test-executor agent → executor 用 playwright-cli 真实操作 → 每步留证（`${STATES_DIR}/v${VERSION}/verify/e2e/${CASE_ID}/steps/NN-${ACTION}/{screenshot.png,dom.html,snapshot.yml,meta.json}`）→ 自由心证 → orchestrator stop。
**判定三态**：`pass`（全通无瑕疵）/ `small`（走通有瑕疵，不阻塞合并）/ `blocking`（走不下去，阻塞合并）。

## 视觉判定（vision_check.py）
```bash
python3 ${TESTS_DIR}/e2e/vision_check.py path/shot.png '[{"id":1,"check":"页面有登录按钮"}]'    # 单图功能检查
python3 ${TESTS_DIR}/e2e/vision_check.py compare impl.png design.png '[{"id":1,"dimension":"layout","check":"..."}]'  # 多图对比
```
- dimension 建议：font / size / layout / border / color / spacing。
- 判定口径：不要求像素级一致，「整体风格基本一致」=PASS，「明显偏差」=FAIL。
- 配置：`VISION_BASE_URL` / `VISION_AUTH_TOKEN` / `VISION_MODEL`（env 优先，fallback 项目根 env.provider）。
- **铁律：视觉判定一律走本脚本，禁 Read 看图 / 禁 MCP**。

## dump-dev-html（抓 dev 前端页面）
**首选 playwright-cli 视觉方案**，一条命令拿 snapshot（导航）+ 整页 HTML（还原）+ 截图（保底），不写脚本不维护选择器。
```bash
playwright-cli open ${WEB_URL}                 # dev web 地址（按 env 输出/变量区）
playwright-cli snapshot                        # aria-label 结构 + 元素 ref（导航依据）
playwright-cli click ${REF}                     # 切页/进状态
playwright-cli screenshot --filename=x.png     # 截图（保底）
playwright-cli --raw eval "document.documentElement.outerHTML" > x.html   # 整页自包含 HTML
playwright-cli close
```
- 定位走 aria-label / 可见文案（testid 已废弃）。
- 换肤：HTML 多走 `var(--color-*)` → `</body>` 前注入 `:root{--color-*:新值}` override 整页换肤。
- 已废弃勿用：批量 snapshot 脚本 / 手写 python playwright / testid 定位。

## test-plan 设计（AT/ET 用例规划）
**触发**：版本编码完成/进行中，产出 `${STATES_DIR}/v${VERSION}/verify/test-plan.md` + case 规格。
**产出 7 节**：范围概览（版本验证标准）/ 路径→case 映射（最低覆盖 = ${REQS_DIR} 验收全路径）/ UT 回归 / AT case 规格 / ET 3-5 条 / 视觉保真清单（无设计稿→跳过）/ 验证执行顺序（UT → AT → ET，串行）+ 门禁（UT 全绿 / AT ≥90%（429 skip 不算 fail）/ ET blocking=0）。
**AT 入选持久库判定**：入选 = 新后端端点（尤其安全敏感）/ 路由分发改动 / 用户实际踩到 bug 修复（防复发）/ 核心高频路径。不入选 = 纯 UI 文案 / UT 全分支覆盖无新端点。增量控制：多态合一（正负例合并 1 条）；普通 feature 不新增持久 case；冒烟集 ≤20 条。

## references
- `references/env_start.sh` / `references/env_shutdown.sh`：通用 env 启停模板（env 变量驱动，跨项目可复用；真实版本在 `${TESTS_DIR}/api/`）。
- `references/_DEPRECATED.md`：已废弃框架存档（旧 checkpoint.json 驱动 + case.yaml DSL）——勿用，仅留档。

## 判定铁律
- 不真实调 API 不能判通过；响应体不许用 `...` 省略。
- 缺环境条件（凭证/live 依赖）标记 `⏭️ 跳过` 并列出缺什么。
- **AT 与 ET 严禁并发**（共享端口注册表 + DATA_DIR）。
