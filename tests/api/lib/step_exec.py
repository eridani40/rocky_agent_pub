"""
步骤执行器：动作类分发 + save + check
参考：design_case_schema.md §3；change_plan v0.0.190 D 节 step_exec.py（去 replay 分支 + 加 429 skip）
files 原语：写入 DATA_DIR/<path>，case 结束时自动清理（run_case.py _cleanup_files）

v0.0.190 起 AT 改真实调 API（不录制不回放），_do_oracle 不再按 mode 分支 skip。
429/529/503 → 抛 RateLimitedError，run_case 捕获后该 case 标 skipped（不算 fail、不阻塞）。
"""
import time
import os
import json
from typing import Any

from interp import interpolate, interpolate_strict, http_request
from check_engine import parse_atomic, eval_check, AtomicCheck
from files_action import do_files, FilesActionError
from langfuse_client import fetch_trace_satisfying as _langfuse_fetch_trace_satisfying


class StepFailError(Exception):
    """步骤确定性失败（非异常情况，预期可能 fail）"""
    pass


class RateLimitedError(Exception):
    """
    触发 provider 限流（HTTP 429/529/503 或 body error type 含 rate_limit/overloaded）。
    run_case 捕获后该 case 标 result='skipped', reason='429'，不重试不阻塞别的 case。
    保守判定：避免正常 fail 误判为 skip（否则 case 假绿）。
    """
    pass


# 限流 HTTP 状态码集合（覆盖 anthropic 529 overloaded + 通用 429/503）
_RATE_LIMITED_STATUSES = {429, 503, 529}
# 限流 body error type 字面量（精确匹配，不做模糊包含避免误判）
_RATE_LIMITED_ERROR_TYPES = {'rate_limit', 'overloaded', 'rate_limit_error'}


def _is_rate_limited(status: int, body: Any) -> bool:
    """
    判定响应是否为 provider 限流。
    保守谓词：status ∈ {429,503,529} 或 body.error.type 字面量匹配 rate_limit/overloaded。
    """
    if status in _RATE_LIMITED_STATUSES:
        return True
    if isinstance(body, dict):
        err = body.get('error')
        if isinstance(err, dict):
            etype = err.get('type') or err.get('code')
            if isinstance(etype, str) and etype.lower() in _RATE_LIMITED_ERROR_TYPES:
                return True
    return False


def exec_step(step: dict, ctx: dict, sse: Any = None) -> dict:
    """
    执行单个 step，返回执行结果 dict：
    {pass, action, main_output, responses, checks_results, extra}
    sse = SseCollector 实例（无 SSE 订阅时为 None）
    RateLimitedError 不在此捕获（让 run_case 把整个 case 标 skipped）。
    """
    action = _detect_action(step)

    # 处理 sse.sub（step 级订阅，惰性建连）
    sse_sub = (step.get('sse') or {}).get('sub', [])
    if sse_sub and sse is not None:
        for sub in sse_sub:
            # topic/group 是 SSE 订阅路由标识（残留必错）：插值失败会静默订阅错误频道
            topic = interpolate_strict(sub['topic'], ctx, 'sse.sub.topic')
            group = interpolate_strict(sub['group'], ctx, 'sse.sub.group')
            as_name = sub.get('as') or f"stream_{sub['topic']}_{len(sse._streams)}"
            sse.subscribe(topic, group, as_name)

    # 执行动作
    main_output = None
    responses = []
    extra = {}
    try:
        if action == 'requests':
            main_output, responses = _do_requests(step, ctx)
        elif action == 'run':
            main_output, responses = _do_run(step, ctx)
        elif action == 'poll':
            main_output, responses, extra = _do_poll(step, ctx)
        elif action == 'wait':
            if sse is None:
                raise StepFailError('wait action requires SSE collector')
            main_output, extra = _do_wait(step, ctx, sse)
        elif action == 'oracle':
            main_output, extra = _do_oracle(step, ctx)
        elif action == 'files':
            main_output, extra = do_files(step, ctx)
        # action == 'none'：纯订阅/纯 check step
    except (StepFailError, FilesActionError) as e:
        return {
            'pass': False, 'action': action,
            'main_output': None, 'responses': responses,
            'checks_results': [], 'extra': {'error': str(e)},
        }

    # save 在 check 前
    save_map = step.get('save') or {}
    if save_map:
        try:
            _apply_save(save_map, main_output, ctx)
        except StepFailError as e:
            return {
                'pass': False, 'action': action,
                'main_output': main_output, 'responses': responses,
                'checks_results': [], 'extra': {'error': str(e)},
            }

    # oracle step 在未配置 langfuse 时 skip（动作返 extra={'skipped': True}）→ check 也 skip
    if extra.get('skipped'):
        return {
            'pass': True, 'action': action,
            'main_output': main_output, 'responses': responses,
            'checks_results': [], 'extra': extra,
        }

    # check
    checks_exprs = step.get('check') or []
    streams_snap = sse.get_streams_snapshot() if sse else {}
    checks_results = []
    all_pass = True
    for expr in checks_exprs:
        ast = _get_ast(expr)
        res = eval_check(ast, main_output, streams_snap)
        checks_results.append(res)
        if not res['pass']:
            all_pass = False

    return {
        'pass': all_pass,
        'action': action,
        'main_output': main_output,
        'responses': responses,
        'checks_results': checks_results,
        'extra': extra,
    }


_ACTION_KEYS = ('requests', 'request', 'run', 'poll', 'wait', 'oracle', 'files')


def _detect_action(step: dict) -> str:
    for key in _ACTION_KEYS:
        if key in step:
            return 'requests' if key == 'request' else key
    return 'none'


def _do_requests(step: dict, ctx: dict):
    """
    执行 requests 列表，返回 (main_output, responses)。
    step 可选 timeout 字段（load 期已校验 int [1,240]）透传给每个 http_request 调用，
    缺省 30（旧硬编码值，现状不变）——真 LLM 长同步调用超过默认 30s 时用它声明更长值。
    """
    items = step.get('requests') or [step.get('request')]
    timeout = step.get('timeout', 30)
    responses = []
    main_output = None
    for item in items:
        multipart = None  # 简写形式不支持 multipart，仅 object-form 支持
        if isinstance(item, str):
            # 简写：METHOD PATH [JSON]
            parts = item.strip().split(' ', 2)
            method = parts[0].upper()
            path = parts[1] if len(parts) > 1 else '/'
            body = json.loads(parts[2]) if len(parts) > 2 else None
        else:
            method = item.get('method', 'GET').upper()
            path = item.get('path', '/')
            body = item.get('body')
            multipart = item.get('multipart')  # 可选；有则忽略 body

        expected = item.get('status', [200, 201, 202, 204]) if isinstance(item, dict) else [200, 201, 202, 204]
        result = http_request(method, path, body, ctx, multipart=multipart, timeout=timeout)
        # 429/529/503 或 body error type 字面匹配 → 限流 skip（保守判定避免正常 fail 误判）
        if _is_rate_limited(result['status'], result['body']):
            raise RateLimitedError(
                f"request {method} {path} rate-limited: status={result['status']}, "
                f"body_snippet={str(result['body'])[:200]}"
            )
        if result['status'] not in expected:
            raise StepFailError(
                f"request {method} {path} returned status {result['status']}, expected {expected}"
            )
        responses.append({
            'method': method, 'path': path,
            'status': result['status'], 'body': result['body'],
        })
        main_output = result['body']

    return main_output, responses


def _do_run(step: dict, ctx: dict):
    """
    打 POST /session/{sid}/run 同步等 agent loop 终态。
    返回 (main_output, responses)
    """
    run_cfg = step.get('run', {})
    sid = ctx.get('sid')
    if not sid:
        raise StepFailError('run action requires ctx.sid (set via setup save)')

    content = run_cfg.get('content', '')
    if not content:
        raise StepFailError('run.content is required and must be non-empty')

    body: dict = {'content': interpolate(content, ctx)}
    if 'providerId' in run_cfg:
        body['providerId'] = run_cfg['providerId']
    if 'modelId' in run_cfg:
        body['modelId'] = run_cfg['modelId']

    result = http_request('POST', f'/session/{sid}/run', body, ctx)
    # 限流 skip：HTTP status 或 body error type 任一命中即抛
    if _is_rate_limited(result['status'], result['body']):
        raise RateLimitedError(
            f"/session/{sid}/run rate-limited: status={result['status']}, "
            f"body_snippet={str(result['body'])[:200]}"
        )
    if result['status'] not in (200, 201, 202):
        raise StepFailError(f'/session/{sid}/run returned {result["status"]}: {result["body"]}')

    main_output = result['body']
    # 异步 run 内部仍可能因 provider 限流失败：stopReason=error + error.type 命中 → skip
    if isinstance(main_output, dict):
        stop_reason = main_output.get('stopReason')
        last_error = main_output.get('lastError') or main_output.get('error')
        if stop_reason == 'error' and isinstance(last_error, dict):
            etype = (last_error.get('type') or last_error.get('code') or '').lower()
            if etype in _RATE_LIMITED_ERROR_TYPES:
                raise RateLimitedError(
                    f"/session/{sid}/run async error rate-limited: error={last_error}"
                )
    responses = [{'method': 'POST', 'path': f'/session/{sid}/run',
                  'status': result['status'], 'body': main_output}]
    return main_output, responses


def _do_poll(step: dict, ctx: dict):
    """轮询直到 until 条件满足或超时（≤10s，load 期已校验）"""
    cfg = step['poll']
    req_str = cfg['request']
    until_expr = cfg['until']
    every = float(cfg.get('every', 0.5))
    timeout = float(cfg['timeout'])

    # 解析 until 为 AST（load 期已校验为原子）
    ast = _get_ast(until_expr)

    parts = req_str.strip().split(' ', 2)
    method = parts[0].upper()
    path = parts[1] if len(parts) > 1 else '/'
    body = json.loads(parts[2]) if len(parts) > 2 else None

    deadline = time.monotonic() + timeout
    rounds = 0
    last_body = None
    while time.monotonic() < deadline:
        result = http_request(method, path, body, ctx)
        last_body = result['body']
        rounds += 1
        check_res = eval_check(ast, last_body, {})
        if check_res['pass']:
            return last_body, [{'method': method, 'path': path,
                                 'status': result['status'], 'body': last_body}], \
                   {'poll_rounds': rounds, 'satisfied': True}
        time.sleep(every)

    raise StepFailError(
        f'poll timeout after {timeout}s ({rounds} rounds), '
        f'last actual: {last_body}'
    )


def _do_wait(step: dict, ctx: dict, sse: Any):
    """等待 SSE 命名流条件满足（≤10s，load 期已校验）"""
    cfg = step['wait']
    stream_name = cfg['stream']
    until_expr = cfg['until']
    timeout = float(cfg['timeout'])

    ast = _get_ast(until_expr)

    def check_fn(events: list) -> bool:
        streams = {stream_name: {'events': events}}
        return eval_check(ast, None, streams)['pass']

    t0 = time.monotonic()
    ok = sse.wait_for_condition(stream_name, check_fn, timeout)
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    if not ok:
        events = sse.get_events(stream_name)
        raise StepFailError(
            f'wait timeout after {timeout}s on stream {stream_name!r}, '
            f'until={until_expr!r}, events_count={len(events)}'
        )
    return None, {'satisfied': True, 'elapsed_ms': elapsed_ms}


def _do_oracle(step: dict, ctx: dict):
    """
    Langfuse oracle 编排器（真实调 API，无 record/replay 概念）。
    LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY 任一缺失 → skip（不算 fail，case 仍可继续）。
    实际 HTTP + 轮询在 langfuse_client.fetch_trace_satisfying（check 引擎通过
    ready_check 闭包注入，避免 langfuse_client 与 check_engine 耦合）。
    """
    cfg = step['oracle']
    lf = cfg.get('langfuse', {})
    timeout = float(lf.get('timeout', 8))
    ready_when = lf.get('ready_when', 'output != null')
    sid = ctx.get('sid')
    if not sid:
        raise StepFailError('oracle requires ctx.sid')

    base_url = os.environ.get('LANGFUSE_BASE_URL', '').rstrip('/')
    pk = os.environ.get('LANGFUSE_PUBLIC_KEY', '')
    sk = os.environ.get('LANGFUSE_SECRET_KEY', '')
    if not base_url or not pk or not sk:
        # 未配置 langfuse → skip oracle（不影响 case 主判定，只缺一条跨层证据）
        return None, {'skipped': True, 'reason': 'langfuse_not_configured'}

    ast = _get_ast(ready_when)

    def ready_check(trace):
        return eval_check(ast, trace, {})['pass']

    trace = _langfuse_fetch_trace_satisfying(base_url, pk, sk, str(sid), ready_check, timeout)
    if trace is None:
        raise StepFailError(f'oracle: no trace satisfying {ready_when!r} for session {sid} within {timeout}s')
    return trace, {'satisfied': True}


_ast_cache: dict = {}  # parse_atomic 缓存（load 期已校验，运行期不再抛）


def _get_ast(expr: str) -> AtomicCheck:
    """带缓存的 parse_atomic（load 期已校验，运行期不再抛异常）"""
    if expr not in _ast_cache:
        _ast_cache[expr] = parse_atomic(expr)
    return _ast_cache[expr]


def _apply_save(save_map: dict, main_output: Any, ctx: dict) -> None:
    """从 main_output 提取变量到 ctx（save 在 check 前）"""
    from check_engine import eval_path, _ABSENT
    for var_name, path_expr in save_map.items():
        val = eval_path(main_output, path_expr)
        if val is _ABSENT:
            raise StepFailError(f"save '{var_name}' path {path_expr!r} not found in main output")
        ctx[var_name] = val
