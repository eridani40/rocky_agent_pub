#!/bin/bash
# API 测试共用检查库（shell 版，可选；runner.py 是主路径）
# 通用化版本：不绑定任何特定项目，BASE_URL 通过环境变量注入。
#
# 依赖的 env 变量:
#   BASE_URL  —— 仅用于打印/调试，实际判定基于传入的 response body（默认 http://localhost:3701）
#
# 用法（在 case 的 run.sh 中）:
#   source "$ROOT/tests/api/lib/check.sh"
#   run_checks "$body" "$checkpoint_file"
#   check_status "$actual_status" "$expected_status"

BASE_URL="${BASE_URL:-http://localhost:3701}"

# 执行单个 check 判定
# check_json <response_body> <path> <op> <value>
# 输出 "pass" 或 "fail: reason"
check_json() {
  local body="$1" path="$2" op="$3" value="$4"

  # 提取路径值
  local actual
  actual=$(echo "$body" | jq -r "$path // \"__NULL__\"" 2>/dev/null)

  if [ "$actual" = "__NULL__" ] || [ "$actual" = "null" ]; then
    if [ "$op" = "exists" ] && [ "$value" = "false" ]; then
      echo "pass"
    elif [ "$op" = "exists" ]; then
      echo "fail: $path is null/missing"
    elif [ "$op" = "ne" ] && [ "$value" = "null" ]; then
      echo "pass"
    else
      echo "fail: $path not found (actual=null)"
    fi
    return
  fi

  case "$op" in
    eq)
      if [ "$actual" = "$value" ]; then echo "pass"; else echo "fail: $path expected '$value' got '$actual'"; fi
      ;;
    ne)
      if [ "$actual" != "$value" ]; then echo "pass"; else echo "fail: $path should not equal '$value'"; fi
      ;;
    contains)
      if echo "$actual" | grep -qF "$value"; then echo "pass"; else echo "fail: $path does not contain '$value'"; fi
      ;;
    regex)
      if echo "$actual" | grep -qE "$value"; then echo "pass"; else echo "fail: $path '$actual' !~ /$value/"; fi
      ;;
    exists)
      echo "pass"
      ;;
    gt)
      if [ "$(echo "$actual > $value" | bc -l 2>/dev/null || echo 0)" = "1" ]; then echo "pass"; else echo "fail: $path $actual not > $value"; fi
      ;;
    gte)
      if [ "$(echo "$actual >= $value" | bc -l 2>/dev/null || echo 0)" = "1" ]; then echo "pass"; else echo "fail: $path $actual not >= $value"; fi
      ;;
    lt)
      if [ "$(echo "$actual < $value" | bc -l 2>/dev/null || echo 0)" = "1" ]; then echo "pass"; else echo "fail: $path $actual not < $value"; fi
      ;;
    lte)
      if [ "$(echo "$actual <= $value" | bc -l 2>/dev/null || echo 0)" = "1" ]; then echo "pass"; else echo "fail: $path $actual not <= $value"; fi
      ;;
    *)
      echo "fail: unknown op '$op'"
      ;;
  esac
}

# 执行一个 step 的所有 checks
# run_checks <response_body> <step_json_file>
# 返回 0=全部通过, 1=有失败
run_checks() {
  local body="$1" checkpoint_file="$2"
  local all_pass=true

  local check_count=$(jq '.expect.checks | length' "$checkpoint_file")
  for i in $(seq 0 $((check_count - 1))); do
    local path=$(jq -r ".expect.checks[$i].path" "$checkpoint_file")
    local op=$(jq -r ".expect.checks[$i].op" "$checkpoint_file")
    local value=$(jq -r ".expect.checks[$i].value" "$checkpoint_file")
    local result=$(check_json "$body" "$path" "$op" "$value")

    if [ "$result" = "pass" ]; then
      echo "  [PASS] $path $op $value"
    else
      echo "  [FAIL] $result"
      all_pass=false
    fi
  done

  if $all_pass; then return 0; else return 1; fi
}

# 检查 HTTP 状态码
# check_status <actual_status> <expected_status>
check_status() {
  if [ "$1" = "$2" ]; then
    echo "  [PASS] status $1 == $2"
    return 0
  else
    echo "  [FAIL] status expected $2 got $1"
    return 1
  fi
}
