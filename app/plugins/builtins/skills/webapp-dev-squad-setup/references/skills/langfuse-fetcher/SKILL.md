---
name: langfuse-fetcher
description: 通用只读 Langfuse 查询工具。当需要从 Langfuse 实例 ad-hoc 查/导出数据（列 traces、取 trace/observation/score/session 详情、按 session/user/tag 过滤、翻页拉满、跑 saved query、一键 trace 缓存命中率分析）时使用。凭证从 test.env/prod.env 注入（LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY），HTTP Basic 认证。只读 GET，不写不删。与 langfuse-verification 互补：本 skill 只管「把数据查出来」，不管「断言对不对」。
---

# Langfuse Fetcher

通用、只读的 Langfuse 查询 CLI + Python 客户端。**只做一件事：把 Langfuse 里的数据查出来给你看 / 导出 / 再加工。** 不耦合测试流程、不做断言、不发 trace。

## 何时用

- 「这个 session 在 langfuse 里长什么样？」→ `lf.sh session <id>` 或 `lf.sh traces --session=<id>`
- 「最近 10 条 trace 的 token 用量？」→ `lf.sh traces --limit=10 | jq ...`
- 「这条 trace 下的所有 generation / tool span？」→ `lf.sh observations --trace=<id> --type=GENERATION`
- 「导出某用户全部 traces 到文件做离线分析」→ Python 客户端的 `paginate()`
- 「Langfuse 里记的某字段到底是什么值」（debug / 对账）→ `lf.sh trace <id>`

> **与 `langfuse-verification` 的边界**：那个 skill 是测试 oracle——驱动一次真请求、等 SDK flush、断言「session 内容 == trace 记录」。本 skill 不发请求、不等 flush、不断言，只读已有数据。要验证 → 用 verification；要查/看/导 → 用 fetcher。

## 前置条件

1. `test.env`（repo 根）含三项凭证（缺失 → CLI 直接报错退出，**不静默 SKIP**——SKIP 语义属于 verification oracle）：
   ```
   LANGFUSE_BASE_URL      # 如 http://localhost:3000 或 https://cloud.langfuse.com
   LANGFUSE_PUBLIC_KEY    # pk-lf-...
   LANGFUSE_SECRET_KEY    # sk-lf-...
   ```
2. langfuse 实例可达：`lf.sh health` 返回 200。

## 凭证注入

- CLI 自动从 repo 根 `test.env` 读取（`set -a; source test.env`），也支持环境变量直接覆盖（env > test.env）。
- **查 prod 实例**（prod trace 分析等）：`set -a; source prod.env; set +a` 后再跑 `lf.sh` / 脚本（prod.env 里是同 localhost 实例的另一组 key；`cache_prefix_analysis.py` / `trace_cache_report.py` 的 `load_creds()` 自动 prod.env 优先，无需手动 source）。
- 认证：HTTP Basic，`user = LANGFUSE_PUBLIC_KEY`，`password = LANGFUSE_SECRET_KEY`（与项目 `langfuse-verification` 实测一致）。
- 所有请求都是 `GET /api/public/*`，只读。

## CLI 速查（`lf.sh`）

```
lf.sh health                         探活 GET /api/public/health
lf.sh traces   [filters]             列 trace（默认 limit=50）
lf.sh trace    <id>                  单 trace 详情
lf.sh observations [filters]         列 observation（--type=SPAN|GENERATION|EVENT）
lf.sh observation <id>               单 observation 详情
lf.sh scores   [filters]             列 score
lf.sh score    <id>                  单 score 详情
lf.sh sessions [filters]             列 session
lf.sh session  <id>                  单 session 详情
lf.sh users    [filters]             列 user
lf.sh user     <id>                  单 user 详情
lf.sh query    <queryId>             执行已保存的 query（GET /queries/{id}/execute）
lf.sh raw      <path>                逃生舱：任意 GET /api/public/<path>（path 可含 ?a=b）
```

**过滤参数**（`--key=value`，直接转成 langfuse query string；常用别名见下）：

| CLI 别名 | Langfuse 参数 | 适用 | 例 |
|---|---|---|---|
| `--session` | `sessionId` | traces | `lf.sh traces --session=sess_x` |
| `--user` | `userId` | traces / scores | `lf.sh traces --user=user_1` |
| `--trace` | `traceId` | observations / scores | `lf.sh observations --trace=tr_x` |
| `--type` | `type` | observations | `--type=GENERATION` |
| `--name` | `name` | traces | 按名字模糊 |
| `--tag` | `tags` | traces | `--tag=prod` |
| `--from` / `--to` | `fromTimestamp` / `toTimestamp` | 多 list | ISO 时间窗 |
| `--limit` / `--page` | `limit` / `page` | 所有 list | 分页 |

**通用选项**：`--raw`（输出原始 JSON 不美化）、`--out=FILE`（写文件）、`--help`。

> 不知道参数叫啥 / 上表没覆盖 → 用 `raw` 逃生舱直传：`lf.sh raw 'traces?limit=5'`。
>
> **排序说明（langfuse 3.x 实测）**：traces 等 list 端点**固定按时间倒序（最新在前）**，`orderBy` 参数被 Zod 校验但实际不改变方向——旧语法 `orderBy=-timestamp` 会直接 400，bracket 形式 `orderBy[order]=ASC` 虽不报错却也无效。所以本 skill **不提供 `--order`**：查「最近」直接用默认即可；要按时间范围筛选用 `--from`/`--to`；要 ASC / 自定义排序用 Langfuse UI 存好的 query（`lf.sh query <id>`）。

## 常用查询

```bash
# 探活
lf.sh health

# 看 session 下所有 trace（默认 DESC=最新在前）
lf.sh traces --session=<sessionId>

# 看 trace 详情 + 它下面所有 observation（generation/tool span/event）
lf.sh trace <traceId>
lf.sh observations --trace=<traceId> --limit=100

# 只要 LLM generation，抽 id + model + token
lf.sh observations --trace=<traceId> --type=GENERATION \
  | python3 -c 'import json,sys; [print(o["id"], o.get("model"), (o.get("usage") or {}).get("totalTokens")) for o in json.load(sys.stdin)["data"]]'

# 最近 20 条 trace 的 id + 名 + 总 token
lf.sh traces --limit=20 \
  | python3 -c 'import json,sys; [print(t["id"], t.get("name"), (t.get("usage") or {}).get("totalTokens")) for t in json.load(sys.stdin)["data"]]'

# 导出某用户全部 trace 到文件（翻页拉满 → 用 Python 客户端）
python3 .rocky/skills/langfuse-fetcher/references/langfuse_client.py traces --userId=user_1 --out=out.json
```

## 字段速查（list 响应形状）

langfuse v3 list 端点统一返回：
```json
{ "data": [ ... ], "meta": { "page": 1, "limit": 50, "totalItems": 123, "totalPages": 3 } }
```
- `trace`: `id` / `name` / `sessionId` / `userId` / `timestamp` / `input` / `output` / `usage{input,output,total,unit}` / `metadata` / `tags`
- `observation`: `id` / `traceId` / `type`(SPAN|GENERATION|EVENT) / `name` / `startTime` / `model`(GENERATION) / `input` / `output` / `usage`(GENERATION) / `metadata` / `level`(DEBUG|DEFAULT|WARNING|ERROR)
- `score`: `id` / `traceId` / `name` / `value` / `dataType`(NUMERIC|CATEGORICAL) / `comment` / `source`

> 单资源端点（`trace <id>` 等）返回该对象本身，**不**包 `{data}`。

## 翻页拉满（Python 客户端）

`lf.sh` 一次一页；要拉满用 `references/langfuse_client.py` 的 `paginate()`：

```python
import sys; sys.path.insert(0, "<repo>/.rocky/skills/langfuse-fetcher/references")
from langfuse_client import LangfuseClient
c = LangfuseClient.from_test_env()           # 自动读 test.env
for tr in c.paginate(c.list_traces, userId="user_1", page_size=100):
    print(tr["id"], tr.get("timestamp"))
```

## 缓存命中率分析（prompt cache）

**一键入口（首选，零 LLM 参与）**：给 env + trace id 全自动「下载 + 逐步前缀对比 + 命中率表」：

```bash
# 人类入口（scripts/）：--env 只是去读 repo 根 <env>.env 拿 LANGFUSE_* 凭证（缺省 prod）
bash scripts/cache_analyze.sh --env prod --tid <traceId> [--threshold=70]

# 等价直调内核（agent 常用；load_creds 自动 prod.env 优先，无需 source）
python3 .rocky/skills/langfuse-fetcher/references/trace_cache_report.py --trace=<traceId>

# 离线复分析（不联网，用已下载的 logs/<traceId>/）
python3 .rocky/skills/langfuse-fetcher/references/trace_cache_report.py --dir=logs/<traceId>
```

产物落盘 `./logs/<traceId>/`（step-NN.json + usage.json + **result.md 报告**（markdown，含全部分析结果，可直接 @ 给人看）；logs/ 已 gitignore）。报告三段：① 相邻 step（1→2、2→3…）前缀对比——system 逐 block / tools 逐项（按 name）/ messages 逐条，先报「前缀一致 ✅ / 分歧 ❌ @位置 + A/B 原文片段（diff 代码块）」；② 每 step 命中率 = `cache_read/(cache_read+input)` 表，低于阈值 ❌ LOW 高亮；③ LOW step 归因（前缀分歧位置 vs provider 侧异常）。口径：比较前剥离 `cache_control` 键（断点标记前移不算分歧，MiniMax 实测不受影响）。

**手动分步流程（需要自定义时）**：

**Step 1 — 拿用量与缓存命中数**（logical generation 的 `usageDetails`）：

```bash
lf.sh observations --trace=<traceId> --type=GENERATION --limit=100 | python3 -c '
import json,sys
for o in json.load(sys.stdin)["data"]:
    if o.get("type")!="GENERATION": continue
    ud = o.get("usageDetails") or {}
    print(o.get("name"), "input:", ud.get("input"), "cache_read:", ud.get("cache_read_input_tokens"), "output:", ud.get("output"))'
```

口径：本项目每条 LLM 调用产两条 generation——`llm-N-logical`（含 usageDetails，`cache_read_input_tokens` 在这）与 `llm-N-physical`（usage 全 0，但 **`input` 就是发给 provider 的原始请求负载**，metadata.physicalWire=true）。物理条用于取负载，逻辑条用于取命中数。

**Step 2 — 拉 physical 请求负载，跑前缀稳定性分析**：

```bash
# 直接从 trace 拉全部 physical 输入并两两比较（推荐）
python3 references/cache_prefix_analysis.py --trace=<traceId>

# 或对本地保存的请求负载文件
python3 references/cache_prefix_analysis.py req1.json req2.json [req3.json]
```

脚本输出：system/tools 是否一致、首个分歧点（哪条消息/哪个块/字符偏移/内容上下文）、理论可缓存前缀占比、每个 `cache_control` 断点保护的内容是否作为前缀原样出现在下一请求。

**Step 3 — 解读**（实测判据，2026-07 v0.0.185 案例）：

- **间隔不是主因要看连续请求**：同一 run 内相隔秒级的请求 cache_read 仍极低 → 是前缀不稳定，不是 TTL。
- **命中数 ≈ 稳定前缀大小**：如 cache_read=23296 恰好等于 system+msg[0] 稳定段 → provider（MiniMax）自动前缀缓存在工作，瓶颈是内容稳定性。
- **常见不稳定源**：压缩上下文消息内嵌的滑动窗口（head 保留区每轮换消息 id）、内嵌动态时间戳/状态。summary 正文稳定不代表整消息稳定——用脚本的首个分歧点定位。
- **forked run 写 memory → system 内嵌 memory 段重渲染**（2026-07-22 prod trace 01KY3RS06K4XW38HJB91JJ6HGX 案例）：memory_extract 每写一条 long-term memory，下一步 system 的 `# Long-term User Memory` 段插入新条目 → system 是 prompt 最前缀，中段一变后面 messages 全失效（cache_read 掉 128）。**根因是 forked system 复用规则 bug**（跨 session 比父 summary.version vs 本 scope null 恒 true → 每步重建），已修（context-engine.ts `shouldRebuild` 加「本 scope 有 summary 才比版本」守卫）。修复后 forked 整 run 冻结父 system，此类掉缓存应消失；再见到 forked trace 命中率阶梯式掉 128 → 先查 system 是否还在变。
- cache_read 远低于稳定前缀大小（如稳定 23k 却只命中 128）→ provider 侧异常，单独记。

## 资源

- `lf.sh` — 主 CLI（自包含，凭证从 test.env，pretty JSON 输出，可管道到 jq/python）
- `references/langfuse_client.py` — 可导入只读客户端（`LangfuseClient` + 自动翻页 `paginate()` + 命令行入口）
- `references/cheatsheet.md` — curl 一行流速查（不走 lf.sh 时）
- `references/trace_cache_report.py` — **一键 trace 缓存分析内核**：`--trace=<id>` 自动下载到 `logs/<id>/` + 相邻 step 前缀对比（system 逐 block / tools 逐项 / messages 逐条，剥离 cache_control，分歧附 A/B 原文片段）+ 命中率表 <70% ❌ 高亮 + LOW 归因；`--dir` 离线复分析。**人类入口 = `scripts/cache_analyze.sh --env prod --tid <id>`**（--env 只是去读 <env>.env 拿凭证）
- `references/cache_prefix_analysis.py` — 缓存前缀稳定性深挖（`--trace=<id>` 或本地负载两两比较：首个分歧点 + 可缓存占比 + cache_control 断点稳定性；一键报告后需断点级细节时用）
