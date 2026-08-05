"""
Langfuse REST 客户端：封装 langfuse trace 查询的 HTTP 细节 + oracle 轮询编排。
参考：design_case_schema.md §3 oracle step；从 step_exec.py 提取（v0.0.125 机械拆分）
职责：
  - langfuse REST GET（basic auth）
  - 按 sessionId 查首条 trace
  - 展开 trace.observations（id 字符串列表 → 对象列表）
  - fetch_trace_satisfying：有界轮询到 ready_check 通过（oracle 编排，与 check 引擎解耦）
不变量：纯提取，函数体与逻辑与原 step_exec.py 完全一致。
"""
import json
import time
import urllib.parse


def langfuse_get(base_url: str, pk: str, sk: str, path: str, timeout: float = 10):
    """langfuse REST GET（basic auth）；失败返 None。"""
    import urllib.request
    import base64 as _b64
    url = f'{base_url}{path}'
    req = urllib.request.Request(url)
    cred = _b64.b64encode(f'{pk}:{sk}'.encode()).decode()
    req.add_header('Authorization', f'Basic {cred}')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


def fetch_trace(base_url: str, pk: str, sk: str, session_id: str):
    """调 langfuse REST API 按 sessionId 查首条 trace；无 trace 返 None。"""
    path = f'/api/public/traces?limit=1&sessionId={urllib.parse.quote(session_id)}'
    data = langfuse_get(base_url, pk, sk, path, timeout=10)
    if data is None:
        return None
    items = data.get('data') or []
    return items[0] if items else None


def expand_observations(base_url: str, pk: str, sk: str, trace: dict) -> dict:
    """
    trace.observations 可能是 id 字符串列表（langfuse 默认）——逐个 fetch 详情，
    替换为对象列表，让 check 能访问 .name/.type 等字段。
    已是对象列表则原样返回；fetch 失败的 id 保留原值（不阻断）。
    """
    obs = trace.get('observations')
    if not isinstance(obs, list) or not obs:
        return trace
    if isinstance(obs[0], dict):
        return trace  # 已是对象列表
    expanded = []
    for oid in obs:
        if not isinstance(oid, str):
            expanded.append(oid)
            continue
        path = f'/api/public/observations/{urllib.parse.quote(oid)}'
        detail = langfuse_get(base_url, pk, sk, path, timeout=5)
        expanded.append(detail if detail is not None else {'id': oid})
    trace['observations'] = expanded
    return trace


def fetch_trace_satisfying(
    base_url: str, pk: str, sk: str, session_id: str,
    ready_check, timeout: float, poll_interval: float = 0.5,
):
    """
    有界轮询：fetch trace → expand → ready_check(trace) 通过则返回 trace，
    未就绪继续轮询，超时返回 None。
    ready_check(trace) -> bool 由调用方提供（注入 check 引擎依赖，避免本模块耦合 check_engine）。
    """
    deadline = time.monotonic() + timeout
    trace = None
    while time.monotonic() < deadline:
        trace = fetch_trace(base_url, pk, sk, session_id)
        if trace is not None:
            # 展开 observations：langfuse trace.observations 默认是 id 字符串列表，
            # check 需访问 .name/.type 等 → 逐个 fetch 详情填充为对象列表
            trace = expand_observations(base_url, pk, sk, trace)
            if ready_check(trace):
                return trace
            trace = None  # 未就绪，继续轮询
        time.sleep(poll_interval)
    return None
