"""
check 表达式引擎：原子性解析 + 求值。
事件流函数拆至 check_events.py；fail 自解释提示拆至 check_explain.py。
数组谓词语法（§四.2）：<path>[] any/all <sub_path> <op> <rhs>
  示例：.providers[] any .id == "builtin" / .items[] all .enabled == true
"""
import re
from dataclasses import dataclass
from typing import Any, Optional
from check_events import eval_stream_fn, mask_fn_args, mask_quoted
from check_explain import available_keys_hint, stream_dist_hint, eval_path, _ABSENT
from case_loader import CaseLoadError  # 顶层安全：case_loader 惰性 import parse_atomic，无 load 期环


@dataclass
class AtomicCheck:
    """原子 check 解析结果；pred_q 非 None 时为数组谓词类型"""
    source: str           # '' = 主输出，非空 = SSE 流名
    path: str             # 路径；谓词时为数组路径
    fn: Optional[str]     # 流函数 count/order/absent
    fn_arg: str
    op: Optional[str]     # 比较 op 或 exists/absent；谓词时为 None
    rhs: Any
    raw: str
    pred_q: Optional[str] = None   # 'any'/'all'（数组谓词量词）
    pred_sub_path: str = ''        # 子谓词路径
    pred_op: Optional[str] = None  # 子谓词 op
    pred_rhs: Any = None           # 子谓词 rhs


_BOOL_RE = re.compile(r'(?:^|\s)(and|or|&&|\|\|)(?:\s|$)', re.IGNORECASE)
_CMP_OPS = ['!~=', '~=', '>=', '<=', '==', '!=']  # 长优先，避免 != 抢占 !~=


def parse_atomic(expr: str) -> AtomicCheck:
    """解析单条 check 表达式；非原子 → CaseLoadError。"""
    s = expr.strip()
    if not s:
        raise CaseLoadError("empty check")
    cleaned = mask_fn_args(mask_quoted(s))
    if _BOOL_RE.search(cleaned):
        raise CaseLoadError(f"non-atomic: contains boolean connective in '{expr}'")
    if '(' in cleaned:
        raise CaseLoadError(f"non-atomic: nested expression in '{expr}'")

    # 数组谓词：<path>[] any/all <sub_expr>（非贪心匹配第一个 []，防嵌套谓词绕过）
    pred_m = re.match(r'^(.*?)\[\]\s+(any|all)\s+(.+)$', s, re.IGNORECASE)
    if pred_m:
        return _parse_pred_expr(pred_m.group(1).strip(), pred_m.group(2).lower(), pred_m.group(3).strip(), expr)

    # 流函数：STREAM_NAME.(count|order|absent)(args)
    m = re.match(r'^([a-z_][a-z0-9_]*)\.(count|order|absent)\(([^)]*)\)\s*(.*)', s)
    if m:
        source, fn, fn_arg, after = m.group(1), m.group(2), m.group(3).strip(), m.group(4).strip()
        if fn == 'count':
            op, rhs = _split_op(after, expr)
            if op is None:
                raise CaseLoadError(f"non-atomic: count() requires binary op in '{expr}'")
            return AtomicCheck(source=source, path='', fn=fn, fn_arg=fn_arg, op=op, rhs=rhs, raw=expr)
        else:
            if after:
                raise CaseLoadError(f"non-atomic: unexpected tokens after {fn}() in '{expr}'")
            return AtomicCheck(source=source, path='', fn=fn, fn_arg=fn_arg, op=None, rhs=None, raw=expr)

    return _parse_path_expr(s, expr)


def _parse_pred_expr(arr_path: str, quantifier: str, sub_expr: str, raw: str) -> AtomicCheck:
    """解析数组谓词子式；子谓词不能含 bool 连接词或嵌套谓词。"""
    if _BOOL_RE.search(mask_quoted(sub_expr)):
        raise CaseLoadError(f"non-atomic: predicate sub-expr contains boolean connective in '{raw}'")
    if re.search(r'\[\]\s+(?:any|all)\s+', sub_expr, re.IGNORECASE):
        raise CaseLoadError(f"non-atomic: nested array predicate in '{raw}'")
    try:
        sub_path, sub_op, sub_rhs = _extract_path_op_rhs(sub_expr, raw)
    except CaseLoadError:
        raise CaseLoadError(f"non-atomic: invalid predicate sub-expr in '{raw}'")
    return AtomicCheck(
        source='', path=arr_path or '.', fn=None, fn_arg='',
        op=None, rhs=None, raw=raw,
        pred_q=quantifier, pred_sub_path=sub_path, pred_op=sub_op, pred_rhs=sub_rhs,
    )


def _parse_path_expr(s: str, raw: str) -> AtomicCheck:
    """解析 [source.]path op rhs 或 path unary_op"""
    s, source = s.strip(), ''
    m = re.match(r'^([a-z_][a-z0-9_]*)(\.|$)', s)
    if m and m.group(1) not in ('exists', 'absent'):
        candidate = m.group(1)
        after = s[len(candidate):]
        if after.startswith('.') or after.startswith('['):
            source, s = candidate, after
    path, op, rhs = _extract_path_op_rhs(s, raw)
    return AtomicCheck(source=source, path=path, fn=None, fn_arg='', op=op, rhs=rhs, raw=raw)


def _extract_path_op_rhs(s: str, raw: str):
    """提取 path、op、rhs；一元 op(exists/absent) → rhs=None"""
    s = s.strip()
    for op in ('exists', 'absent'):
        if s == op:
            return '', op, None
        if s.endswith(' ' + op):
            return s[:-(len(op)+1)].strip(), op, None
    # 在引号掩码串上扫描 op（防止 rhs 字面量内的 op 误判为顶层复合）
    masked = mask_quoted(s)
    hits, covered = [], set()
    for tok in _CMP_OPS:
        start = 0
        while True:
            idx = masked.find(tok, start)
            if idx < 0:
                break
            pos = set(range(idx, idx + len(tok)))
            if not (pos & covered):
                hits.append((idx, tok))
                covered |= pos
            start = idx + 1
    if not hits:
        raise CaseLoadError(f"non-atomic: no op found in '{raw}'")
    if len(hits) > 1:
        raise CaseLoadError(f"non-atomic: multiple comparison ops in '{raw}'")
    idx, op = hits[0]
    return s[:idx].strip(), op, _parse_rhs(s[idx + len(op):].strip())


def _split_op(s: str, raw: str):
    """从 count() 后内容提取 op + rhs（rhs 中再现比较 op = 复合，拒载）"""
    s = s.strip()
    if not s:
        return None, None
    for tok in _CMP_OPS:
        if s.startswith(tok):
            rhs_s = s[len(tok):].strip()
            masked = mask_quoted(rhs_s)
            for t2 in _CMP_OPS:
                if t2 in masked:
                    raise CaseLoadError(f"non-atomic: multiple comparison ops in '{raw}'")
            return tok, _parse_rhs(rhs_s)
    raise CaseLoadError(f"non-atomic: expected op after count() in '{raw}'")


def _parse_rhs(s: str) -> Any:
    """解析 rhs 字面量"""
    s = s.strip()
    if s == 'null':
        return None
    if s == 'true':
        return True
    if s == 'false':
        return False
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    try:
        return float(s) if '.' in s else int(s)
    except ValueError:
        return s



def eval_check(ast: AtomicCheck, main_output: Any, streams: dict) -> dict:
    """对单条 AtomicCheck 求值，返回 {expr, pass, actual, note?}。"""
    if ast.pred_q is not None:
        return _eval_pred_check(ast, main_output)
    if ast.fn:
        events = streams.get(ast.source, {}).get('events', [])
        actual = eval_stream_fn(events, ast.fn, ast.fn_arg)
        if ast.op is None:
            res = {'expr': ast.raw, 'pass': bool(actual), 'actual': actual}
        else:
            res = _apply_scalar_op(ast.op, actual, ast.rhs, ast.raw)
        # fail 时附加流内事件分布，帮助定位是哪种事件缺少/多余
        if not res['pass']:
            dist = stream_dist_hint(events)
            res['actual'] = f'{res["actual"]} ({dist})'
        return res
    if ast.source:
        events = streams.get(ast.source, {}).get('events', [])
        actual = eval_path(events, ast.path) if ast.path else events
        return _apply_op(ast.op, actual, ast.rhs, ast.raw)
    else:
        root = main_output
        actual = eval_path(main_output, ast.path) if ast.path else main_output
        return _apply_op(ast.op, actual, ast.rhs, ast.raw, root=root, path=ast.path)


def _eval_pred_check(ast: AtomicCheck, main_output: Any) -> dict:
    """求值数组谓词：any=至少一个满足，all=全部满足；空数组 any=False/all=True。"""
    arr = eval_path(main_output, ast.path) if ast.path not in ('', '.') else main_output
    if arr is _ABSENT:
        return {'expr': ast.raw, 'pass': False, 'actual': '<absent>', 'note': 'array path not found'}
    if not isinstance(arr, list):
        return {'expr': ast.raw, 'pass': False, 'actual': repr(arr), 'note': f'expected list, got {type(arr).__name__}'}
    results = [_apply_op(ast.pred_op, eval_path(e, ast.pred_sub_path) if ast.pred_sub_path else e, ast.pred_rhs, ast.raw)['pass'] for e in arr]
    ok = (any(results) if results else False) if ast.pred_q == 'any' else (all(results) if results else True)
    matched = f'{sum(results)}/{len(results)} matched'
    res = {'expr': ast.raw, 'pass': ok, 'actual': matched}
    if not ok:
        res['note'] = matched
    return res


def _apply_op(op: str, actual: Any, rhs: Any, expr: str, root: Any = None, path: str = '') -> dict:
    """根据 op 对 actual 求值（含一元 exists/absent）。
    root + path 用于键缺失时生成可用键提示（仅二元比较路径）。
    """
    if op == 'exists':
        ok = actual is not _ABSENT and actual is not None
        return {'expr': expr, 'pass': ok, 'actual': 'present' if ok else '<absent>'}
    if op == 'absent':
        ok = actual is _ABSENT or actual is None
        return {'expr': expr, 'pass': ok, 'actual': '<absent>' if ok else 'present'}
    if actual is _ABSENT:
        # 键不存在时附加可用键提示
        if root is not None and path:
            hint = available_keys_hint(root, path)
        else:
            hint = '<missing>'
        return {'expr': expr, 'pass': False, 'actual': hint}
    return _apply_scalar_op(op, actual, rhs, expr)


def _apply_scalar_op(op: str, actual: Any, rhs: Any, expr: str) -> dict:
    """对标量执行 op 比较"""
    note = None
    if op == '==':
        ok = _eq(actual, rhs)
    elif op == '!=':
        ok = not _eq(actual, rhs)
    elif op in ('>=', '<='):
        if not isinstance(actual, (int, float)) or not isinstance(rhs, (int, float)):
            return {'expr': expr, 'pass': False, 'actual': actual, 'note': f'type_error: expected number, got {type(actual).__name__}'}
        ok = actual >= rhs if op == '>=' else actual <= rhs
    elif op == '~=':
        ok = _contains(actual, rhs)
    elif op == '!~=':
        ok = not _contains(actual, rhs)
    else:
        return {'expr': expr, 'pass': False, 'actual': actual, 'note': f'unknown op {op}'}
    res = {'expr': expr, 'pass': ok, 'actual': actual}
    if not ok:
        res['note'] = note or f'expected {rhs!r}'
    return res


def _contains(actual: Any, rhs: Any) -> bool:
    """~= 语义：字符串含子串 或 数组含元素"""
    if isinstance(actual, str) and isinstance(rhs, str):
        return rhs in actual
    return isinstance(actual, list) and rhs in actual


def _eq(a: Any, b: Any) -> bool:
    if a is None:
        return b is None
    if isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return str(a) == str(b)
