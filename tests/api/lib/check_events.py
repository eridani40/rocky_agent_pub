"""
SSE 事件流函数 + 表达式词法掩码（从 check_engine 拆出）
参考：design_check_lang.md §3；design.md §3 预留抽离
"""
import re
from typing import Any


def mask_fn_args(s: str) -> str:
    """把流函数括号（及括号内内容）完整替换为无括号占位符，用于顶层布尔/括号检查"""
    result, i = [], 0
    while i < len(s):
        matched = False
        for fn in ('count', 'order', 'absent'):
            tok = fn + '('
            if s[i:i+len(tok)] == tok:
                result.append(fn + '_MASKED_')  # 不含括号，避免后续括号误判
                depth, j = 1, i + len(tok)
                while j < len(s) and depth > 0:
                    if s[j] == '(':
                        depth += 1
                    elif s[j] == ')':
                        depth -= 1
                    j += 1
                i, matched = j, True
                break
        if not matched:
            result.append(s[i])
            i += 1
    return ''.join(result)


def mask_quoted(s: str) -> str:
    """把引号内字符串内容替换为等长 'x' 占位符（保留引号本身），避免 rhs 字面量里的
    op/连接词（如 .title == "cats and dogs" / .msg ~= "a==b"）被误判为顶层复合。
    仅用于原子性扫描；rhs 实际解析仍走原串，字符串字面值不受影响。"""
    out, quote = [], None
    for c in s:
        if quote is None:
            out.append(c)
            if c in ('"', "'"):
                quote = c
        elif c == quote:
            out.append(c)
            quote = None
        else:
            out.append('x')
    return ''.join(out)


def parse_filter(s: str) -> dict:
    """解析 type=X 或 type=X,field=Y 过滤条件"""
    conditions = {}
    for part in s.split(','):
        part = part.strip()
        if '=' in part:
            k, v = part.split('=', 1)
            conditions[k.strip()] = v.strip()
    return conditions


def _deep_find(obj: Any, key: str) -> Any:
    """递归找 key（广度优先：顶层 → dict 值 → list 元素）。
    返回首个匹配值；找不到返回 None。用于解 SSE 嵌套（如 session_status_update state）。
    """
    if not isinstance(obj, (dict, list)):
        return None
    # 当前层
    if isinstance(obj, dict) and key in obj:
        return obj[key]
    # 深入一层：dict 值 / list 元素
    children = obj.values() if isinstance(obj, dict) else obj
    for child in children:
        if isinstance(child, (dict, list)):
            found = _deep_find(child, key)
            if found is not None:
                return found
    return None


def match_event(event: dict, conditions: dict) -> bool:
    """检查事件是否匹配所有条件。
    查找顺序：顶层 → event.data 一级 → _deep_find 深度遍历（BUG-002：解 SSE 嵌套如 state）。
    向后兼容：顶层/1 级命中逻辑不变，深度遍历仅作后备触发。
    """
    for k, v in conditions.items():
        ev_val = event.get(k)
        if ev_val is None:
            # event.data 一级（向后兼容：保留原 1 级查找路径）
            data_field = event.get('data') or {}
            if isinstance(data_field, dict):
                ev_val = data_field.get(k)
            # 顶层 + 1 级都 None → 深度遍历后备（解 SSE `event.data.data.state` 嵌套）
            if ev_val is None:
                ev_val = _deep_find(event, k)
        if str(ev_val) != str(v):
            return False
    return True


def eval_stream_fn(events: list, fn: str, fn_arg: str) -> Any:
    """
    事件流函数求值。
    - count(filter) → int
    - order(A < B) → bool（首个 A 在首个 B 之前）
    - absent(filter) → bool（流中无匹配事件）
    """
    if fn == 'count':
        conditions = parse_filter(fn_arg)
        return sum(1 for e in events if match_event(e, conditions))

    if fn == 'absent':
        conditions = parse_filter(fn_arg)
        return not any(match_event(e, conditions) for e in events)

    if fn == 'order':
        # order(A < B)
        m = re.match(r'([a-z_][a-z0-9_]*)\s*<\s*([a-z_][a-z0-9_]*)', fn_arg)
        if not m:
            return False
        a_type, b_type = m.group(1), m.group(2)
        idx_a, idx_b = None, None
        for i, e in enumerate(events):
            if idx_a is None and e.get('type') == a_type:
                idx_a = i
            if idx_b is None and e.get('type') == b_type:
                idx_b = i
        if idx_a is None or idx_b is None:
            return False
        return idx_a < idx_b

    return None
