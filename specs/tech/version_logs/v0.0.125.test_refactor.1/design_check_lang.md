# check 表达式语言文法

> 归属：`design.md §0` 目录页拆分文件。定义 check 表达式的 path 语法 / op 集 / 事件流函数 / 原子性机器判定。
> 实现：`check_engine.py`（递归下降解析 + 求值；per-check 独立结果 + actual）。三类目标（response / SSE 流 / langfuse）同一断言语言。

## 0. 表达式总形态（EBNF 概要）

```
check       := lhs SP op SP rhs                 # 二元比较（原子）
             | lhs SP unary_op                   # 一元（exists/absent/order/absent-事件）
lhs         := source path?                      # 数据源 + 路径
source      := ε                                 # 缺省 = 当前 step 主输出（response/run 结果）
             | STREAM_NAME                        # SSE 命名流（source 后跟事件流函数或 path）
path        := ('.' field | '[' filter ']' | '[' index ']')+
op          := '==' | '!=' | '>=' | '<=' | '~=' | '!~='
unary_op    := 'exists' | 'absent'
rhs         := STRING | NUMBER | BOOL | 'null'
```

**一条 check = 恰好一个 `lhs op rhs`（或一个 `lhs unary_op`）**——这是原子性的机器判定基石（见 §4）。

## 1. path 语法（作用于 response / trace / SSE 事件对象）

| 语法 | 含义 | 示例 |
|---|---|---|
| `.field` | 对象字段 | `.state` / `.summary.content` |
| `.a.b.c` | 嵌套 | `.error.code` |
| `[N]` | 数组索引（`[-1]` = 末尾，`[-2]` 倒二） | `.messages[0]` / `.messages[-1]` |
| `[field=value]` | 数组元素过滤（选第一个匹配项） | `.messages[role=tool]` / `.content[type=text]` |
| `[field=value][N]` | 过滤后再索引 | `.messages[role=tool][0].isError` |
| `[field=value].sub` | 过滤后取字段 | `.messages[role=assistant].content[0].text` |

**过滤语义**：`[k=v]` 在数组上遍历，返回**第一个** `elem[k] == v` 的元素（v 按字面比较，数字/字符串自动识别）。找不到 → path 求值为「不存在」（配 `exists`/`absent` 判定；配二元 op 时 actual=`<absent>`，通常 fail）。

**多请求响应引用**：step 有多 `requests` 时，`.responses[N]` 引用第 N 个请求的响应体（`N` 从 0），缺省 path（无 source 无 `.responses`）指向最后一个请求响应。示例：`.responses[0].id`。

## 2. op 集（二元 + 一元）

| op | 语义 | 适用类型 | actual 示例 |
|---|---|---|---|
| `==` | 相等（字面，数字/字符串/bool/null 自动识别） | 标量 | actual: `"running"` |
| `!=` | 不等 | 标量 | |
| `>=` `<=` | 数值/字典序比较 | number（字符串报类型错） | |
| `~=` | contains（字符串包含子串 / 数组包含元素） | string/array | actual: `"...tool..."` |
| `!~=` | not contains | string/array | |
| `exists` | path 求值存在（一元） | any | actual: `present`/`absent` |
| `absent` | path 求值不存在（一元） | any | actual: `present`/`absent` |

**类型不匹配处置**：`>= <=` 用于非数值 → check 结果 = fail，note=`type_error: expected number, got <type>`（不是 load 期拒载，是运行期 fail，因为 actual 值运行时才知）。

## 3. 事件流函数（source = SSE 命名流时专用）

SSE 流是**事件序列**（每帧一个 event 对象，含 `type`/`data` 等字段）。流上的断言用专用函数（一元或产生标量供二元比较）：

| 函数 | 语义 | 用法（原子 check 形态） |
|---|---|---|
| `count(<filter>)` | 匹配 filter 的事件数（产标量 number） | `main.count(type=run_end) == 1` |
| `order(A < B)` | 首个 A 类事件在首个 B 类事件之前（一元 bool） | `main.order(run_start < run_end)` |
| `absent(<filter>)` | 流中无匹配事件（一元 bool） | `main.absent(type=error)` |

- **filter 文法**：`type=X`（事件 type 等于 X）或 `type=X,field=Y`（多条件 AND，逗号分隔；field 是事件对象内字段）。仅支持 `=`（等值），不支持范围。
- `count(...)` 是**产标量的 lhs**，必须配二元 op + number rhs（`count(...) == N` / `count(...) >= N`）——单独 `main.count(type=x)` 不成 check（无 op，拒载）。
- `order(A < B)` / `absent(...)` 是**一元 bool check**（自身即完整 check，无 op）。
- `order` 只支持二元序（`A < B`）；多级序拆成多条原子 check（`order(a<b)` + `order(b<c)`），符合原子性。

**SSE 事件对象形状**：runner 从 `GET /sse` 帧解析出的 `data` 字段（即 `AgentEvent`，含 `type`），事件流函数的 `type=X` 匹配 `event.type == X`（如 `run_start`/`run_end`/`message_start`/`tool_call`/`tool_result`）。权威事件类型见 `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md`（runner 不硬编码枚举，只做字符串匹配）。

## 4. 原子性校验（load 期机器判定）

**规则（req 硬规则 1）**：一条 check = 单 path + 单 op + 单期望值；禁复合。

`check_engine` 在 load 期对每条 check 字符串做**结构解析**，判定原子性，非原子 → 拒载：

| 拒载情形 | 判据 | 报错 |
|---|---|---|
| 含布尔连接词 | 顶层出现 ` and ` / ` or ` / `&&` / `\|\|` | `non-atomic: contains boolean connective` |
| 多个比较 op | 解析出 >1 个 op token（`==`/`!=`/`>=`/`<=`/`~=`/`!~=`）在同一表达式顶层 | `non-atomic: multiple comparison ops` |
| 嵌套括号表达式（非函数调用） | `(` 出现但不是 `count(`/`order(`/`absent(` 的函数括号 | `non-atomic: nested expression` |
| 空 check | 空串 | `empty check` |

**机器判定算法**（`check_engine.parse_atomic(s)`）：
1. tokenize（识别 STREAM_NAME / path token / op token / 函数 `count`/`order`/`absent` / 字面量）。
2. 计数顶层 op token：`count > 1` → 非原子。
3. 扫描 ` and `/` or `/`&&`/`||`（大小写不敏感，词边界）→ 命中即非原子。
4. 括号只允许出现在事件流函数名后（`count(`/`order(`/`absent(`），其它裸括号 → 非原子。
5. 通过 → 产出 `AtomicCheck { source, path, op, rhs, fn? }` AST。

> 「一条 check 只有一个比较」= 顶层 op token 计数 ≤1 且无布尔连接词。`order(a<b)` 内的 `<` 是**函数参数分隔符**（在 `order(` 括号内），不计入顶层 op 计数——tokenizer 在函数括号内不把 `<` 当顶层 op。

## 5. per-check 结果（运行期）

每条 check 求值产出独立结果对象（写入 `steps/NN/checks.json`）：

```json
{ "expr": ".state == \"idle\"", "pass": true, "actual": "idle" }
{ "expr": "main.count(type=run_end) == 1", "pass": false, "actual": 0, "note": "expected 1" }
{ "expr": ".error.code exists", "pass": false, "actual": "<absent>" }
```

- `actual` 是 lhs 求值的**实际值**（fail 时最关键的诊断信息，req「fail 附 actual」硬要求）。
- 二元 op：actual = lhs 求值结果；一元 op：actual = `present`/`absent`；事件函数：actual = 函数返回值（count 的数 / order 的 bool）。
- `note` 仅在类型错/额外说明时出现。

## 6. 三类目标同一语言的落地

| 目标 | source 形态 | 示例 |
|---|---|---|
| **response**（requests/run/poll 主输出） | 缺省（无前缀） | `.state == "idle"` / `.messages[role=tool][0].isError == false` |
| **SSE 序列**（命名流） | `<stream>` 前缀 + 事件流函数 | `main.count(type=tool_result) == 1` / `main.order(run_start < run_end)` |
| **langfuse trace**（oracle 后） | 缺省（oracle step 内 check 主输出 = trace 对象） | `.output != null` / `.observations[0].type == "GENERATION"` |

三者共用 §1 path 语法 + §2 op 集；SSE 额外有 §3 事件流函数。同一 `check_engine.eval(ast, ctx)` 按 source 分派数据源，求值逻辑统一。
