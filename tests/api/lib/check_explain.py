"""
fail 自解释辅助 + jq 风路径求值（从 check_engine 拆出以控制行数）。
- eval_path / _tokenize_path：完整路径求值，_ABSENT 哨兵表示缺失
- available_keys_hint：路径不存在时生成可用键提示
- stream_dist_hint：事件分布字符串，count/absent fail 时附加

被 check_engine 导入；不反向依赖 check_engine，无循环依赖。
"""
from typing import Any

# 路径不存在哨兵（与 check_engine._ABSENT 同一对象，通过 check_engine 导出）
_ABSENT = object()

# 键列表截断上限
_MAX_KEYS = 10
# 分布字符串截断上限（字符数）
_MAX_DIST_LEN = 200


# ──────────────────────────────────────────────────────────────────────────────
# jq 风路径求值
# ──────────────────────────────────────────────────────────────────────────────

def eval_path(obj: Any, path: str) -> Any:
    """对 obj 按 path 语法求值；返回 _ABSENT 表示路径不存在。"""
    if not path or path == '.':
        return obj
    tokens = _tokenize_path(path)
    cur = obj
    for tok in tokens:
        if cur is _ABSENT or cur is None:
            return _ABSENT
        if tok['type'] == 'field':
            cur = cur.get(tok['name'], _ABSENT) if isinstance(cur, dict) else _ABSENT
        elif tok['type'] == 'index':
            if isinstance(cur, list):
                try:
                    cur = cur[tok['index']]
                except IndexError:
                    return _ABSENT
            else:
                return _ABSENT
        elif tok['type'] == 'filter':
            if not isinstance(cur, list):
                return _ABSENT
            k, v = tok['key'], tok['val']
            cur = next(
                (e for e in cur if isinstance(e, dict) and str(e.get(k)) == str(v)),
                _ABSENT,
            )
    return cur


def _tokenize_path(path: str) -> list:
    """把 jq 风路径字符串拆为 token 列表（field / index / filter）。"""
    tokens, i = [], (1 if path.startswith('.') else 0)
    while i < len(path):
        if path[i] == '[':
            j = path.index(']', i)
            inner = path[i + 1:j].strip()
            i = j + 1
            if '=' in inner:
                k, v = inner.split('=', 1)
                tokens.append({'type': 'filter', 'key': k.strip(), 'val': v.strip()})
            else:
                try:
                    tokens.append({'type': 'index', 'index': int(inner)})
                except ValueError:
                    tokens.append({'type': 'field', 'name': inner})
        else:
            if path[i] == '.':
                i += 1
            j = i
            while j < len(path) and path[j] not in ('.', '['):
                j += 1
            if j > i:
                tokens.append({'type': 'field', 'name': path[i:j]})
            i = j
    return tokens


# ──────────────────────────────────────────────────────────────────────────────
# 路径键提示
# ──────────────────────────────────────────────────────────────────────────────

def available_keys_hint(obj: Any, path: str) -> str:
    """针对「路径不存在」情形，生成可用键提示字符串。
    返回格式：'<missing> (available at <parent>: key1, key2, ...)'
    若父节点不是 dict 则只返回 '<missing>'。

    参数：
        obj: 根对象（通常是 HTTP 响应 dict）
        path: 完整路径，如 '.current.totalTokens'
    """
    parent_path, _ = _split_last_segment(path)
    # 用简化版求值（返回 None 而非哨兵，避免引入循环依赖）
    parent = _nav_to(obj, parent_path)
    if not isinstance(parent, dict) or not parent:
        return '<missing>'
    keys = list(parent.keys())
    truncated = keys[:_MAX_KEYS]
    suffix = ', ...' if len(keys) > _MAX_KEYS else ''
    keys_str = ', '.join(truncated) + suffix
    at_label = parent_path if parent_path else '.'
    return f'<missing> (available at {at_label}: {keys_str})'


def _split_last_segment(path: str) -> tuple:
    """把路径拆为父路径和最后一段。
    '.current.totalTokens' → ('.current', 'totalTokens')
    '.state' → ('', 'state')
    """
    last_dot = path.rfind('.')
    last_bracket = path.rfind('[')
    if last_dot <= 0 and last_bracket < 0:
        return ('', path.lstrip('.'))
    if last_dot > last_bracket:
        return (path[:last_dot], path[last_dot + 1:])
    return (path[:last_bracket], path[last_bracket:])


def _nav_to(obj: Any, path: str) -> Any:
    """简化路径导航，仅用于 available_keys_hint 的父节点定位；缺失返回 None。"""
    if not path or path == '.':
        return obj
    cur = obj
    i = 1 if path.startswith('.') else 0
    while i < len(path):
        if cur is None or not isinstance(cur, (dict, list)):
            return None
        if path[i] == '[':
            j = path.index(']', i)
            inner = path[i + 1:j].strip()
            i = j + 1
            if isinstance(cur, list):
                try:
                    cur = cur[int(inner)]
                except (ValueError, IndexError):
                    return None
            else:
                return None
        else:
            if path[i] == '.':
                i += 1
            j = i
            while j < len(path) and path[j] not in ('.', '['):
                j += 1
            key = path[i:j]
            cur = cur.get(key) if isinstance(cur, dict) else None
            i = j
    return cur


# ──────────────────────────────────────────────────────────────────────────────
# 事件分布提示
# ──────────────────────────────────────────────────────────────────────────────

def stream_dist_hint(events: list) -> str:
    """把事件列表压缩为分布字符串，用于 count/absent fail 时附加到 actual。
    格式：'stream events: session_meta_update×3, summary_task_update[status=running]×1'
    任务型事件（含 data.status）附加 [status=X]；截断至 _MAX_DIST_LEN 字符。
    """
    if not events:
        return 'stream events: (empty)'

    from collections import Counter
    counter: Counter = Counter()
    for e in events:
        etype = e.get('type', '?')
        status = None
        data = e.get('data')
        if isinstance(data, dict):
            status = data.get('status')
        counter[(etype, status)] += 1

    parts = []
    for (etype, status), cnt in counter.most_common():
        label = f'{etype}[status={status}]' if status is not None else etype
        parts.append(f'{label}×{cnt}')

    full = 'stream events: ' + ', '.join(parts)
    if len(full) > _MAX_DIST_LEN:
        full = full[:_MAX_DIST_LEN - 3] + '...'
    return full
