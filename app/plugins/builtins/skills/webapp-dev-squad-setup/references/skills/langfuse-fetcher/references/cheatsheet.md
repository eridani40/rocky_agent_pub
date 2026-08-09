# Langfuse Fetcher 速查

curl 一行流（不走 `lf.sh` 时）。凭证已 `source test.env`：
```bash
set -a; source ./test.env; set +a
AUTH="$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"
API="$LANGFUSE_BASE_URL/api/public"
```

## 认证 & 探活
```bash
curl -s -u "$AUTH" "$API/health" | python3 -m json.tool
```

## Traces
```bash
# 列最近 20 条
curl -s -u "$AUTH" "$API/traces?limit=20" | python3 -m json.tool

# 某 session 下的 traces（固定最新在前；orderBy 在本版本无效，旧 -timestamp 语法会 400）
curl -s -u "$AUTH" "$API/traces?sessionId=<sid>" | python3 -m json.tool

# 单 trace（详情，返回对象本身，无 data 包裹）
curl -s -u "$AUTH" "$API/traces/<traceId>" | python3 -m json.tool

# 按用户 + 时间窗
curl -s -u "$AUTH" "$API/traces?userId=<uid>&fromTimestamp=2026-07-01T00:00:00Z&toTimestamp=2026-07-31T23:59:59Z"
```

## Observations（trace 下的 span / generation / event）
```bash
# 某 trace 下全部 observation
curl -s -u "$AUTH" "$API/observations?traceId=<traceId>&limit=100" | python3 -m json.tool

# 只要 GENERATION，抽 model + token
curl -s -u "$AUTH" "$API/observations?traceId=<traceId>&type=GENERATION&limit=100" \
  | python3 -c 'import json,sys;[print(o.get("model"),(o.get("usage") or {}).get("totalTokens")) for o in json.load(sys.stdin)["data"]]'
```

## Scores / Sessions / Users
```bash
curl -s -u "$AUTH" "$API/scores?traceId=<traceId>&limit=50" | python3 -m json.tool
curl -s -u "$AUTH" "$API/sessions?limit=20"   | python3 -m json.tool
curl -s -u "$AUTH" "$API/sessions/<sessionId>"| python3 -m json.tool
curl -s -u "$AUTH" "$API/users?limit=20"      | python3 -m json.tool
```

## Saved query（在 Langfuse UI 存好的查询）
```bash
curl -s -u "$AUTH" "$API/queries"                     | python3 -m json.tool   # 列出已存 query
curl -s -u "$AUTH" "$API/queries/<queryId>/execute"   | python3 -m json.tool   # 执行
```

## 响应形状
- list：`{ "data": [...], "meta": { "page","limit","totalItems","totalPages" } }`
- 单资源：对象本身（无 `data` 包裹）

## 备注
- `runId == trace.id`（项目 LangfuseAdapter 显式指定）——拿 runId 直接定位 trace，无需列表搜索。
- generation 的 usage 在 `observation.usage`（input/output/totalTokens/unit）。
- tool span 名形如 `tool:xxx`，入参在 `input.arguments`，结果在 `output`。
