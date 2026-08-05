"""纯逻辑自测（不依赖 server）— python3 tests/api/lib/selftest/run_selftest.py"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import tempfile
import yaml
from check_engine import parse_atomic, eval_path, eval_check, _ABSENT
from check_events import eval_stream_fn
from case_loader import load_case, CaseLoadError
from test_multipart import test_multipart_encoding

_passed = 0
_failed = 0


def ok(name: str, cond: bool) -> None:
    global _passed, _failed
    if cond:
        print(f'  PASS: {name}')
        _passed += 1
    else:
        print(f'  FAIL: {name}')
        _failed += 1


def raises(name: str, fn, exc_type=Exception) -> None:
    global _passed, _failed
    try:
        fn()
        print(f'  FAIL: {name} (no exception raised)')
        _failed += 1
    except exc_type as e:
        print(f'  PASS: {name} → {type(e).__name__}: {e}')
        _passed += 1
    except Exception as e:
        print(f'  FAIL: {name} (wrong exception {type(e).__name__}: {e})')
        _failed += 1


# ─── §1 parse_atomic 原子性 ───────────────────────────────────────────────────

def test_parse_atomic():
    print('\n§1 parse_atomic 原子性:')

    # 正例
    ast = parse_atomic('.state == "idle"')
    ok('simple eq', ast.op == '==' and ast.path == '.state' and ast.rhs == 'idle')

    ast = parse_atomic('.count >= 1')
    ok('gte', ast.op == '>=' and ast.rhs == 1)

    ast = parse_atomic('.error absent')
    ok('unary absent', ast.op == 'absent')

    ast = parse_atomic('.msg exists')
    ok('unary exists', ast.op == 'exists')

    ast = parse_atomic('main.count(type=run_end) == 1')
    ok('stream count', ast.source == 'main' and ast.fn == 'count' and ast.rhs == 1)

    ast = parse_atomic('main.order(run_start < run_end)')
    ok('stream order', ast.source == 'main' and ast.fn == 'order' and ast.op is None)

    ast = parse_atomic('main.absent(type=error)')
    ok('stream absent', ast.source == 'main' and ast.fn == 'absent')

    ast = parse_atomic('.messages[role=tool][0].isError == false')
    ok('path filter', ast.path == '.messages[role=tool][0].isError' and ast.rhs is False)

    ast = parse_atomic('.stopReason != "tool_call"')
    ok('neq string', ast.op == '!=' and ast.rhs == 'tool_call')

    ast = parse_atomic('.text ~= "hello"')
    ok('contains', ast.op == '~=' and ast.rhs == 'hello')

    # 反例：非原子
    raises('bool and', lambda: parse_atomic('.a == 1 and .b == 2'), CaseLoadError)
    raises('bool or', lambda: parse_atomic('.a == 1 or .b == 2'), CaseLoadError)
    raises('bool &&', lambda: parse_atomic('.a == 1 && .b == 2'), CaseLoadError)
    raises('bool ||', lambda: parse_atomic('.a == 1 || .b == 2'), CaseLoadError)
    raises('nested paren', lambda: parse_atomic('(.a == 1)'), CaseLoadError)
    raises('empty check', lambda: parse_atomic(''), CaseLoadError)
    raises('count no op', lambda: parse_atomic('main.count(type=x)'), CaseLoadError)
    # [GAP M3] 重复比较 op 绕过路径拒载
    raises('double eq .a == 1 == 2', lambda: parse_atomic('.a == 1 == 2'), CaseLoadError)
    raises('double ne .a != 1 != 2', lambda: parse_atomic('.a != 1 != 2'), CaseLoadError)


# ─── §2 eval_path ─────────────────────────────────────────────────────────────

def test_eval_path():
    print('\n§2 eval_path:')
    obj = {
        'state': 'idle',
        'messages': [
            {'role': 'user', 'content': 'hi'},
            {'role': 'assistant', 'content': 'hello'},
            {'role': 'tool', 'isError': False},
        ],
        'nested': {'deep': {'val': 42}},
    }

    ok('.state', eval_path(obj, '.state') == 'idle')
    ok('.nested.deep.val', eval_path(obj, '.nested.deep.val') == 42)
    ok('[0]', eval_path(obj, '.messages[0].role') == 'user')
    ok('[-1]', eval_path(obj, '.messages[-1].role') == 'tool')
    ok('[role=tool]', eval_path(obj, '.messages[role=tool].isError') is False)
    ok('absent field', eval_path(obj, '.noexist') is _ABSENT)
    ok('filter not found', eval_path(obj, '.messages[role=bot]') is _ABSENT)
    ok('empty path', eval_path(obj, '') is obj)


# ─── §3 case_loader 拒载规则 ──────────────────────────────────────────────────

def _make_case_dir(content: dict, case_id: str = 'test_case', module: str = 'test_mod') -> str:
    """在临时目录创建 case.yaml 并返回 case_dir"""
    base = tempfile.mkdtemp()
    mod_dir = os.path.join(base, module)
    case_dir = os.path.join(mod_dir, case_id)
    os.makedirs(case_dir, exist_ok=True)
    with open(os.path.join(case_dir, 'case.yaml'), 'w') as f:
        yaml.dump(content, f)
    return case_dir


def test_case_loader():
    print('\n§3 case_loader 拒载规则:')

    # 正常 case
    valid = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 'step1', 'request': 'GET /ping'}],
    }
    case_dir = _make_case_dir(valid)
    try:
        c = load_case(case_dir)
        ok('valid case loads', c.case == 'test_case')
    except CaseLoadError as e:
        ok(f'valid case loads (FAIL: {e})', False)

    # 未知顶层字段
    bad1 = dict(valid); bad1['extra_field'] = 'x'
    raises('unknown top field', lambda: load_case(_make_case_dir(bad1)), CaseLoadError)

    # case_id 与目录不一致
    bad2 = dict(valid); bad2['case'] = 'wrong_name'
    raises('case id mismatch', lambda: load_case(_make_case_dir(bad2)), CaseLoadError)

    # timeout > 60（v0.0.125 放宽后上限 60；整体 case timeout 是[1,300]，这里测 wait.timeout>60）
    bad3 = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{
            'name': 's1',
            'sse': {'sub': [{'topic': 't', 'group': 'g', 'as': 'main'}]},
        }, {
            'name': 's2',
            'wait': {'stream': 'main', 'until': 'main.count(type=x) == 1', 'timeout': 61},
        }],
    }
    raises('wait.timeout>10', lambda: load_case(_make_case_dir(bad3)), CaseLoadError)

    # poll.timeout > 10
    bad4 = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'poll': {
            'request': 'GET /x', 'until': '.x == 1', 'timeout': 75,
        }}],
    }
    raises('poll.timeout>10', lambda: load_case(_make_case_dir(bad4)), CaseLoadError)

    # 多动作类
    bad5 = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'request': 'GET /x', 'run': {'content': 'hi'}}],
    }
    raises('multi action', lambda: load_case(_make_case_dir(bad5)), CaseLoadError)

    # 非原子 check
    bad6 = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'request': 'GET /x', 'check': ['.a == 1 and .b == 2']}],
    }
    raises('non-atomic check', lambda: load_case(_make_case_dir(bad6)), CaseLoadError)

    # 未知 step 字段
    bad7 = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'script': 'echo hi'}],
    }
    raises('unknown step field (script)', lambda: load_case(_make_case_dir(bad7)), CaseLoadError)

    # [GAP C1] 未声明插值变量拒载（save 从未定义 {undefined_sid}）
    bad8 = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'request': 'GET /session/{undefined_sid}'}],
    }
    raises('undefined interp var', lambda: load_case(_make_case_dir(bad8)), CaseLoadError)

    # [GAP C1] 已 save 的变量不拒载（{sid} 由 setup save 定义）
    good1 = {
        'case': 'test_case', 'module': 'test_mod',
        'setup': [{'name': 'build', 'request': 'POST /session {"title":"t"}', 'save': {'sid': '.id'}}],
        'steps': [{'name': 's1', 'request': 'GET /session/{sid}'}],
    }
    try:
        load_case(_make_case_dir(good1))
        ok('saved var not rejected', True)
    except CaseLoadError as e:
        ok(f'saved var not rejected (FAIL: {e})', False)

    # 修复回归：大写变量名（{sidA}）未定义时也须拒载（旧 bug：只认小写正则，
    # 大写名绕过本检查静默通过，运行期又静默不插值，双重隐蔽）
    bad8_upper = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'request': 'GET /session/{undefinedSidA}'}],
    }
    raises('undefined interp var (uppercase name)',
           lambda: load_case(_make_case_dir(bad8_upper)), CaseLoadError)

    # 大写变量名已 save 时不拒载（{sidA} 由 setup save 定义）
    good1_upper = {
        'case': 'test_case', 'module': 'test_mod',
        'setup': [{'name': 'build', 'request': 'POST /session {"title":"t"}', 'save': {'sidA': '.id'}}],
        'steps': [{'name': 's1', 'request': 'GET /session/{sidA}'}],
    }
    try:
        load_case(_make_case_dir(good1_upper))
        ok('saved uppercase var not rejected', True)
    except CaseLoadError as e:
        ok(f'saved uppercase var not rejected (FAIL: {e})', False)

    # [GAP M1] 跨 step 重名流拒载（case 级唯一）
    bad9 = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [
            {'name': 's1', 'sse': {'sub': [{'topic': 'a', 'group': 'g', 'as': 'main'}]}},
            {'name': 's2', 'sse': {'sub': [{'topic': 'b', 'group': 'g', 'as': 'main'}]}},
        ],
    }
    raises('cross-step duplicate stream', lambda: load_case(_make_case_dir(bad9)), CaseLoadError)


# ─── §4 check_events 流函数 ───────────────────────────────────────────────────

def test_check_events():
    print('\n§4 check_events 流函数:')
    events = [
        {'type': 'run_start', 'data': {}},
        {'type': 'message_start', 'data': {}},
        {'type': 'run_end', 'data': {}},
        {'type': 'run_start', 'data': {}},  # 第二个 run_start
    ]

    ok('count run_start == 2', eval_stream_fn(events, 'count', 'type=run_start') == 2)
    ok('count run_end == 1', eval_stream_fn(events, 'count', 'type=run_end') == 1)
    ok('order run_start < run_end', eval_stream_fn(events, 'order', 'run_start < run_end') is True)
    ok('order run_end < run_start', eval_stream_fn(events, 'order', 'run_end < run_start') is False)
    ok('absent type=error', eval_stream_fn(events, 'absent', 'type=error') is True)
    ok('absent type=run_end (present)', eval_stream_fn(events, 'absent', 'type=run_end') is False)


# ─── §4b check_events match_event 深度遍历（BUG-002）───────────────────────────

def test_match_event_deep():
    """match_event 深度遍历：解 SSE 嵌套（如 session_status_update state 在 data.data）。
    向后兼容：顶层 + data 1 级命中逻辑不变，深搜仅作后备触发。"""
    print('\n§4b match_event 深度遍历 (BUG-002):')
    from check_events import match_event, _deep_find

    # ── 顶层命中（向后兼容）──
    ev = {'type': 'run_start', 'data': {'state': 'idle'}}
    ok('D1 top-level type match', match_event(ev, {'type': 'run_start'}) is True)
    ok('D1 top-level type miss', match_event(ev, {'type': 'run_end'}) is False)

    # ── data 1 级命中（向后兼容）──
    ok('D2 data level state match',
       match_event(ev, {'state': 'idle'}) is True)
    ok('D2 data level state miss',
       match_event(ev, {'state': 'running'}) is False)

    # ── BUG-002: data.data 深层嵌套（SSE session_status_update 真实结构）──
    # session_status_update 帧：frame.data = AgentEvent{type, data:{state:...}}
    # case 断言 `state=interrupted` 实际查 event.data.data.state
    ev_nested = {
        'type': 'session_status_update',
        'data': {
            'type': 'session_status_update',
            'data': {'state': 'interrupted', 'sessionId': 's1'},
        },
    }
    ok('D3 deep state=interrupted match',
       match_event(ev_nested, {'state': 'interrupted'}) is True)
    ok('D3 deep state=interrupted miss',
       match_event(ev_nested, {'state': 'running'}) is False)

    # ── 多条件混合：顶层 + 深层 ──
    ok('D4 multi-cond: type=top + state=deep',
       match_event(ev_nested, {'type': 'session_status_update', 'state': 'interrupted'}) is True)

    # ── _deep_find 直接测：递归找 key ──
    obj = {'a': 1, 'data': {'b': {'c': 'hello'}}}
    ok('DF1 top-level find', _deep_find(obj, 'a') == 1)
    ok('DF2 nested find', _deep_find(obj, 'c') == 'hello')
    ok('DF3 missing key → None', _deep_find(obj, 'nope') is None)

    # ── _deep_find list 内 dict ──
    obj_list = {'items': [{'k': 'v1'}, {'k': 'v2'}]}
    ok('DF4 list[0] find', _deep_find(obj_list, 'k') == 'v1')

    # ── 顶层 None 值不被误判（向后兼容：0/false 是合法值）──
    ev_zero = {'type': 'x', 'data': {'count': 0}}
    ok('D5 zero value treated as found (not None)',
       match_event(ev_zero, {'count': '0'}) is True)

    # ── 多层 data.data.data 嵌套（极端但合法）──
    ev_deep = {'data': {'data': {'data': {'flag': 'on'}}}}
    ok('D6 triple-nested flag find',
       match_event(ev_deep, {'flag': 'on'}) is True)


# ─── §5 eval_check response/stream 求值 ─────────────────────────────────────

def test_eval_check():
    print('\n§5 eval_check:')
    from check_engine import parse_atomic, eval_check

    main_out = {'state': 'idle', 'stopReason': 'no_tool_call', 'count': 3}
    streams = {
        'main': {'events': [
            {'type': 'run_start'},
            {'type': 'run_end'},
        ]}
    }

    ast = parse_atomic('.state == "idle"')
    r = eval_check(ast, main_out, streams)
    ok('response eq pass', r['pass'] is True and r['actual'] == 'idle')

    ast = parse_atomic('.state == "running"')
    r = eval_check(ast, main_out, streams)
    ok('response eq fail', r['pass'] is False)

    ast = parse_atomic('main.count(type=run_end) == 1')
    r = eval_check(ast, main_out, streams)
    ok('stream count pass', r['pass'] is True and r['actual'] == 1)

    ast = parse_atomic('main.order(run_start < run_end)')
    r = eval_check(ast, main_out, streams)
    ok('stream order pass', r['pass'] is True)

    ast = parse_atomic('main.absent(type=error)')
    r = eval_check(ast, main_out, streams)
    ok('stream absent pass', r['pass'] is True)

    ast = parse_atomic('.nofield exists')
    r = eval_check(ast, main_out, streams)
    ok('exists fail', r['pass'] is False)

    ast = parse_atomic('.state exists')
    r = eval_check(ast, main_out, streams)
    ok('exists pass', r['pass'] is True)


# ─── §6 数组谓词断言 ─────────────────────────────────────────────────────────

def test_array_predicate():
    print('\n§6 数组谓词断言 (§四.2 check_engine 扩展):')
    from check_engine import parse_atomic, eval_check, _ABSENT

    # ── 正例：parse_atomic 谓词解析 ──
    ast = parse_atomic('.providers[] any .id == "builtin"')
    ok('pred any parse: pred_q=any', ast.pred_q == 'any')
    ok('pred any parse: path=.providers', ast.path == '.providers')
    ok('pred any parse: sub_path=.id', ast.pred_sub_path == '.id')
    ok('pred any parse: pred_op===', ast.pred_op == '==')
    ok('pred any parse: pred_rhs=builtin', ast.pred_rhs == 'builtin')

    ast = parse_atomic('.items[] all .enabled == true')
    ok('pred all parse: pred_q=all', ast.pred_q == 'all')
    ok('pred all parse: sub_path=.enabled', ast.pred_sub_path == '.enabled')
    ok('pred all parse: pred_rhs=True', ast.pred_rhs is True)

    # 根数组展开（无前缀路径）
    ast = parse_atomic('[] any .kind == "skill"')
    ok('pred root array: path=.', ast.path == '.')

    # 嵌套路径
    ast = parse_atomic('.result.groups[] any .name != "hidden"')
    ok('pred nested path', ast.path == '.result.groups' and ast.pred_op == '!=')

    # ── 正例：eval_check 求值 ──
    main_out = {
        'providers': [
            {'id': 'builtin', 'name': 'Rocky'},
            {'id': 'openai', 'name': 'OpenAI'},
        ],
        'items': [
            {'kind': 'skill', 'enabled': True},
            {'kind': 'skill', 'enabled': True},
        ],
        'empty': [],
    }
    streams = {}

    ast = parse_atomic('.providers[] any .id == "builtin"')
    r = eval_check(ast, main_out, streams)
    ok('any: found → pass', r['pass'] is True)

    ast = parse_atomic('.providers[] any .id == "notfound"')
    r = eval_check(ast, main_out, streams)
    ok('any: not found → fail', r['pass'] is False)

    ast = parse_atomic('.items[] all .enabled == true')
    r = eval_check(ast, main_out, streams)
    ok('all: all match → pass', r['pass'] is True)

    ast = parse_atomic('.providers[] all .id == "builtin"')
    r = eval_check(ast, main_out, streams)
    ok('all: partial match → fail', r['pass'] is False)

    # 空数组语义
    ast = parse_atomic('.empty[] any .id == "x"')
    r = eval_check(ast, main_out, streams)
    ok('any: empty array → false', r['pass'] is False)

    ast = parse_atomic('.empty[] all .id == "x"')
    r = eval_check(ast, main_out, streams)
    ok('all: empty array → true (vacuous)', r['pass'] is True)

    # 路径不存在
    ast = parse_atomic('.noexist[] any .id == "x"')
    r = eval_check(ast, main_out, streams)
    ok('any: absent path → fail', r['pass'] is False and '<absent>' in r.get('actual', ''))

    # 非数组 → fail
    ast = parse_atomic('.providers[0][] any .id == "x"')
    r = eval_check(ast, {'providers': [{'id': 'x'}]}, streams)
    ok('any: non-list → fail', r['pass'] is False)

    # ── 反例：原子性绕过拒载 ──
    raises('pred sub-expr bool and',
           lambda: parse_atomic('.items[] any .a == 1 and .b == 2'), CaseLoadError)
    raises('pred nested predicate',
           lambda: parse_atomic('.a[] any .b[] all .c == 1'), CaseLoadError)

    # 谓词语法不影响原有原子性检查（整体表达式含 bool 连接词）
    raises('outer bool connective on pred',
           lambda: parse_atomic('.items[] any .id == "x" and .items[] all .enabled == true'), CaseLoadError)


# ─── §8 fail 自解释：路径键提示 + 事件分布 ─────────────────────────────────────

def test_fail_explain():
    print('\n§8 fail 自解释（check_explain）:')
    from check_engine import parse_atomic, eval_check, _ABSENT
    from check_explain import available_keys_hint, stream_dist_hint

    # ── A. 路径断言 fail：键不存在时 actual 附加可用键提示 ──
    main_out = {
        'current': {
            'input_cache_read': 0,
            'total_tokens': 100,
            'llmCallCount': 3,
        }
    }
    streams = {}

    # 键不存在 → actual 含 '<missing>' 和父路径可用键
    ast = parse_atomic('.current.totalTokens == 100')
    r = eval_check(ast, main_out, streams)
    ok('missing key: pass=False', r['pass'] is False)
    ok('missing key: actual contains <missing>', '<missing>' in str(r['actual']))
    ok('missing key: actual contains available at .current', 'available at .current' in str(r['actual']))
    ok('missing key: actual lists total_tokens', 'total_tokens' in str(r['actual']))

    # 键存在但值不等 → actual 是值本身，不含提示
    ast2 = parse_atomic('.current.total_tokens == 999')
    r2 = eval_check(ast2, main_out, streams)
    ok('wrong value: pass=False', r2['pass'] is False)
    ok('wrong value: actual is raw value (no hint)', str(r2['actual']) == '100')

    # 键存在且匹配 → pass=True，actual 是值
    ast3 = parse_atomic('.current.total_tokens == 100')
    r3 = eval_check(ast3, main_out, streams)
    ok('correct value: pass=True', r3['pass'] is True)

    # 父节点本身不存在 → actual 含 '<missing>' 但无可用键列表
    ast4 = parse_atomic('.noparent.field == 1')
    r4 = eval_check(ast4, main_out, streams)
    ok('no parent: pass=False', r4['pass'] is False)
    ok('no parent: actual contains <missing>', '<missing>' in str(r4['actual']))

    # available_keys_hint 单元：父节点是 dict，列出其可用键
    hint = available_keys_hint({'stats': {'input': 0, 'output': 10, 'total': 10}}, '.stats.badField')
    ok('hint unit: contains <missing>', '<missing>' in hint)
    ok('hint unit: contains available at .stats', 'available at .stats' in hint)
    ok('hint unit: lists keys', 'input' in hint)

    # ── B. events 断言 fail：actual 附加流内事件分布 ──
    events = [
        {'type': 'session_meta_update', 'data': {}},
        {'type': 'session_meta_update', 'data': {}},
        {'type': 'session_meta_update', 'data': {}},
        {'type': 'summary_task_update', 'data': {'status': 'running'}},
    ]
    streams_ev = {'main': {'events': events}}

    # count fail → actual 含分布字符串
    ast5 = parse_atomic('main.count(type=run_end) == 1')
    r5 = eval_check(ast5, {}, streams_ev)
    ok('events count fail: pass=False', r5['pass'] is False)
    ok('events count fail: actual contains stream events', 'stream events' in str(r5['actual']))
    ok('events count fail: actual contains session_meta_update×3', 'session_meta_update×3' in str(r5['actual']))
    ok('events count fail: actual contains summary_task_update[status=running]×1',
       'summary_task_update[status=running]×1' in str(r5['actual']))

    # count pass → actual 是数字，不含分布字符串
    ast6 = parse_atomic('main.count(type=session_meta_update) == 3')
    r6 = eval_check(ast6, {}, streams_ev)
    ok('events count pass: pass=True', r6['pass'] is True)
    ok('events count pass: actual is int (no dist hint)', r6['actual'] == 3)

    # stream_dist_hint 单元：空流
    dist_empty = stream_dist_hint([])
    ok('dist empty: contains (empty)', '(empty)' in dist_empty)

    # stream_dist_hint 单元：分布格式
    dist = stream_dist_hint(events)
    ok('dist: contains stream events prefix', dist.startswith('stream events: '))
    ok('dist: contains ×3', '×3' in dist)
    ok('dist: status annotation', '[status=running]' in dist)


def test_files_primitive():
    print('\n§10 files 原语（case_loader 校验 + files_action 执行）:')
    import tempfile, json as _json
    from files_action import do_files, cleanup_written_files, FilesActionError

    tmpdir = tempfile.mkdtemp()

    # ── A. case_loader：files 正常校验 ──
    valid_with_files = {
        'case': 'test_case', 'module': 'test_mod',
        'setup': [{'name': 'write fixture', 'files': [
            {'path': 'computer-mock.json', 'content': {'permissions': {'screenRecording': 'granted'}}}
        ]}],
        'steps': [{'name': 'step1', 'request': 'GET /ping'}],
    }
    case_dir_f = _make_case_dir(valid_with_files)
    try:
        c = load_case(case_dir_f)
        ok('files in setup: loads ok', True)
    except CaseLoadError as e:
        ok(f'files in setup: loads ok (FAIL: {e})', False)

    # ── B. case_loader：绝对路径拒载 ──
    bad_abs = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'files': [
            {'path': '/etc/passwd', 'content': {'x': 1}}
        ]}],
    }
    raises('files absolute path rejected', lambda: load_case(_make_case_dir(bad_abs)), CaseLoadError)

    # ── C. case_loader：../ 逃逸拒载 ──
    bad_escape = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'files': [
            {'path': '../../../etc/passwd', 'content': {'x': 1}}
        ]}],
    }
    raises('files ../ escape rejected', lambda: load_case(_make_case_dir(bad_escape)), CaseLoadError)

    # ── D. case_loader：content 非 dict 拒载 ──
    bad_content = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'files': [
            {'path': 'some.json', 'content': 'not a dict'}
        ]}],
    }
    raises('files content non-dict rejected', lambda: load_case(_make_case_dir(bad_content)), CaseLoadError)

    # ── D2. case_loader：encoding=base64 时 content 须为非空 base64 字符串（[v0.0.141] D2 扩展）──
    import base64 as _b64
    _png_bytes = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8  # 假 PNG 头 + 填充，够用于编解码验证
    _png_b64 = _b64.b64encode(_png_bytes).decode('ascii')

    valid_b64_files = {
        'case': 'test_case', 'module': 'test_mod',
        'setup': [{'name': 'write binary fixture', 'files': [
            {'path': 'fixture.png', 'content': _png_b64, 'encoding': 'base64'}
        ]}],
        'steps': [{'name': 'step1', 'request': 'GET /ping'}],
    }
    try:
        load_case(_make_case_dir(valid_b64_files))
        ok('files encoding=base64: loads ok', True)
    except CaseLoadError as e:
        ok(f'files encoding=base64: loads ok (FAIL: {e})', False)

    # dict content + encoding=base64 → 拒载（content 须是字符串不是 dict）
    bad_b64_dict_content = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'files': [
            {'path': 'x.png', 'content': {'a': 1}, 'encoding': 'base64'}
        ]}],
    }
    raises('files encoding=base64 with dict content rejected',
           lambda: load_case(_make_case_dir(bad_b64_dict_content)), CaseLoadError)

    # 空字符串 content + encoding=base64 → 拒载
    bad_b64_empty = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'files': [
            {'path': 'x.png', 'content': '', 'encoding': 'base64'}
        ]}],
    }
    raises('files encoding=base64 with empty content rejected',
           lambda: load_case(_make_case_dir(bad_b64_empty)), CaseLoadError)

    # 未知 encoding 值 → 拒载
    bad_encoding_unknown = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'files': [
            {'path': 'x.bin', 'content': 'zzz', 'encoding': 'gzip'}
        ]}],
    }
    raises('files unknown encoding rejected',
           lambda: load_case(_make_case_dir(bad_encoding_unknown)), CaseLoadError)

    # ── E. files_action：正常写入 ──
    import os as _os
    ctx = {}
    _os.environ['DATA_DIR'] = tmpdir
    step = {'files': [{'path': 'computer-mock.json', 'content': {'permissions': {'screenRecording': 'granted'}}}]}
    main_out, extra = do_files(step, ctx)
    expected_path = _os.path.realpath(_os.path.join(tmpdir, 'computer-mock.json'))
    ok('do_files: written list contains path', expected_path in main_out['written'])
    ok('do_files: file exists on disk', _os.path.isfile(expected_path))
    with open(expected_path) as fh:
        loaded = _json.load(fh)
    ok('do_files: content matches', loaded.get('permissions', {}).get('screenRecording') == 'granted')
    ok('do_files: ctx._written_files populated', expected_path in ctx.get('_written_files', []))

    # ── F. cleanup_written_files：清理后文件消失 ──
    deleted = cleanup_written_files(ctx)
    ok('cleanup: returns deleted list', expected_path in deleted)
    ok('cleanup: file removed from disk', not _os.path.isfile(expected_path))

    # ── F2. files_action：encoding=base64 写入真实二进制字节（[v0.0.141] D2 扩展）──
    ctx_b64 = {}
    _os.environ['DATA_DIR'] = tmpdir
    step_b64 = {'files': [
        {'path': 'fixture.png', 'content': _png_b64, 'encoding': 'base64'}
    ]}
    main_out_b64, _ = do_files(step_b64, ctx_b64)
    expected_png_path = _os.path.realpath(_os.path.join(tmpdir, 'fixture.png'))
    ok('do_files base64: written list contains path', expected_png_path in main_out_b64['written'])
    ok('do_files base64: file exists on disk', _os.path.isfile(expected_png_path))
    with open(expected_png_path, 'rb') as fh:
        raw_written = fh.read()
    ok('do_files base64: bytes match original (round-trip)', raw_written == _png_bytes)
    ok('do_files base64: bytes are NOT the base64 text (not accidentally text-serialized)',
       raw_written != _png_b64.encode('utf-8'))
    cleanup_written_files(ctx_b64)
    ok('do_files base64: cleanup removes binary file', not _os.path.isfile(expected_png_path))

    # 混合 case：同一 step 内一个 dict(JSON) 条目 + 一个 base64 条目并存，互不影响
    ctx_mixed = {}
    step_mixed = {'files': [
        {'path': 'a.json', 'content': {'k': 'v'}},
        {'path': 'b.png', 'content': _png_b64, 'encoding': 'base64'},
    ]}
    main_out_mixed, _ = do_files(step_mixed, ctx_mixed)
    ok('do_files mixed: writes 2 files', len(main_out_mixed['written']) == 2)
    with open(_os.path.realpath(_os.path.join(tmpdir, 'a.json'))) as fh:
        mixed_json = _json.load(fh)
    ok('do_files mixed: dict entry still JSON-serialized', mixed_json == {'k': 'v'})
    with open(_os.path.realpath(_os.path.join(tmpdir, 'b.png')), 'rb') as fh:
        mixed_bin = fh.read()
    ok('do_files mixed: base64 entry still binary', mixed_bin == _png_bytes)
    cleanup_written_files(ctx_mixed)

    # ── G. files_action：DATA_DIR 外路径运行时拒绝 ──
    ctx2 = {}
    # 构造一个路径，load 期合法（相对无 ../）但运行时 DATA_DIR 指向 tmpdir，
    # 通过 symlink 方式模拟：实际用绑定的 DATA_DIR 验证，这里直接测路径逃逸错误。
    # 直接测：path 内含 ../ 但因 load 期已拦截，运行时用 realpath 验证不同驱动目录。
    step_bad = {'files': [{'path': 'x', 'content': {'a': 1}}]}
    _os.environ['DATA_DIR'] = tmpdir
    # 正常应该能写（DATA_DIR/x 在内）
    main_out2, _ = do_files(step_bad, ctx2)
    ok('do_files normal relative: ok', len(main_out2['written']) == 1)
    cleanup_written_files(ctx2)

    # 测试 DATA_DIR 未设置时 FilesActionError
    old_data_dir = _os.environ.pop('DATA_DIR', None)
    try:
        raises('do_files: no DATA_DIR raises', lambda: do_files(step_bad, {}), FilesActionError)
    finally:
        if old_data_dir is not None:
            _os.environ['DATA_DIR'] = old_data_dir
        else:
            _os.environ['DATA_DIR'] = tmpdir

    _os.environ['DATA_DIR'] = tmpdir  # 恢复


# ─── §13 requests 步骤 timeout 字段（v0.0.151 AT 框架增强）────────────────────

def test_requests_timeout():
    """
    requests 步骤可选 timeout 字段：case_loader 校验（合法值通过/越界拒载/非 int 拒载/
    非 requests 步骤拒载）+ step_exec._do_requests 透传给 http_request（显式值 / 缺省 30）。
    背景：v0.0.151 新增 test-only 同步整理端点真 LLM 链单请求可能 >30s，旧硬编码
    urlopen(timeout=30) 必崩 socket.timeout，属框架能力缺口（既有 case 从无 >30s 同步调用）。
    """
    print('\n§13 requests 步骤 timeout 字段:')

    def _case_with_timeout(t):
        return {
            'case': 'test_case', 'module': 'test_mod',
            'steps': [{'name': 's1', 'request': 'GET /ping', 'timeout': t}],
        }

    # ── A. 合法值（含边界 1/240）通过 ──
    for good in (30, 1, 240, 120):
        try:
            load_case(_make_case_dir(_case_with_timeout(good)))
            ok(f'valid timeout ({good}) loads', True)
        except CaseLoadError as e:
            ok(f'valid timeout ({good}) loads (FAIL: {e})', False)

    # ── B. 越界拒载 ──
    for bad in (0, 241, 300, -5):
        raises(f'timeout out of range ({bad})',
               lambda bv=bad: load_case(_make_case_dir(_case_with_timeout(bv))), CaseLoadError)

    # ── C. 非 int 拒载（字符串/浮点/布尔）──
    for bad_type in ('30', 30.5, True):
        raises(f'timeout non-int ({bad_type!r})',
               lambda bv=bad_type: load_case(_make_case_dir(_case_with_timeout(bv))), CaseLoadError)

    # ── D. 缺省不写 → 正常加载（现状不变，无需额外字段）──
    no_timeout = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{'name': 's1', 'request': 'GET /ping'}],
    }
    try:
        load_case(_make_case_dir(no_timeout))
        ok('omitted timeout: loads ok (default behavior unchanged)', True)
    except CaseLoadError as e:
        ok(f'omitted timeout: loads ok (FAIL: {e})', False)

    # ── E. 非 requests 步骤上出现 timeout 字段拒载（poll 已有自己的 poll.timeout）──
    bad_non_requests = {
        'case': 'test_case', 'module': 'test_mod',
        'steps': [{
            'name': 's1',
            'poll': {'request': 'GET /x', 'until': '.x == 1', 'timeout': 5},
            'timeout': 30,
        }],
    }
    raises('timeout field on non-requests step (poll) rejected',
           lambda: load_case(_make_case_dir(bad_non_requests)), CaseLoadError)

    # ── F. step_exec._do_requests：显式 timeout 透传给 http_request ──
    import step_exec
    captured = {}

    def fake_http_request(method, path, body, ctx, multipart=None, timeout=30):
        captured['timeout'] = timeout
        return {'status': 200, 'body': {'ok': True}}

    orig_http_request = step_exec.http_request
    step_exec.http_request = fake_http_request
    try:
        step_exec._do_requests({'name': 's1', 'request': 'GET /ping', 'timeout': 90}, {})
        ok('step_exec passes explicit timeout through', captured.get('timeout') == 90)

        captured.clear()
        step_exec._do_requests({'name': 's2', 'request': 'GET /ping'}, {})
        ok('step_exec default timeout unchanged (30)', captured.get('timeout') == 30)
    finally:
        step_exec.http_request = orig_http_request


# ─── §12 interp（正则加固 + fail-loud 残留检测）───────────────────────────────

def test_interp():
    print('\n§12 interp（大小写变量名 + interpolate_strict 残留检测）:')
    from interp import interpolate, interpolate_strict, InterpolationError

    # ── A. 大写变量名正常插值（旧 bug：正则只认小写，静默不替换）──
    ok('uppercase var: interpolated',
       interpolate('/session/{sidA}/run', {'sidA': 'abc123'}) == '/session/abc123/run')
    ok('mixed-case var: interpolated',
       interpolate('{Squad_Id}-{n2}', {'Squad_Id': 'sq1', 'n2': 2}) == 'sq1-2')

    # ── B. 嵌套结构（dict/list）大写变量插值 ──
    nested = interpolate({'a': ['{X}', {'b': '{Y}'}]}, {'X': '1', 'Y': '2'})
    ok('nested uppercase var: list item', nested['a'][0] == '1')
    ok('nested uppercase var: dict value', nested['a'][1]['b'] == '2')

    # ── C. 未定义变量（小写/大写）在宽松 interpolate 下保留字面量（不报错）──
    ok('lenient interpolate: undefined var kept literal',
       interpolate('{undefinedVar}', {}) == '{undefinedVar}')

    # ── D. interpolate_strict：变量已定义 → 正常插值，无异常 ──
    try:
        result = interpolate_strict('/session/{sidA}/run', {'sidA': 'xyz'}, 'http url path')
        ok('strict: defined var interpolated, no raise', result == '/session/xyz/run')
    except InterpolationError as e:
        ok(f'strict: defined var interpolated, no raise (FAIL: {e})', False)

    # ── E. interpolate_strict：残留未定义变量 → fail-loud 抛 InterpolationError ──
    raises('strict: residual undefined var raises',
           lambda: interpolate_strict('/session/{sidA}/run', {}, 'http url path'),
           InterpolationError)

    # ── F. interpolate_strict 异常信息含变量名 + label（可诊断） ──
    try:
        interpolate_strict('/session/{sidA}/run', {}, 'http url path')
        ok('strict error message: contains var name + label', False)
    except InterpolationError as e:
        msg = str(e)
        ok('strict error message: contains var name + label',
           'sidA' in msg and 'http url path' in msg)


# ─── 主入口 ───────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    test_parse_atomic()
    test_eval_path()
    test_case_loader()
    test_check_events()
    test_match_event_deep()  # §4b BUG-002 深度遍历
    test_eval_check()
    test_array_predicate()
    test_multipart_encoding(ok)  # §7 在独立文件 test_multipart.py
    test_fail_explain()  # §8 fail 自解释
    test_files_primitive()  # §10 files 原语
    test_interp()  # §12 interp（正则加固 + fail-loud 残留检测）
    test_requests_timeout()  # §13 requests 步骤 timeout 字段（v0.0.151 AT 框架增强）

    print(f'\n{"="*50}')
    print(f'Results: {_passed} passed, {_failed} failed')
    if _failed > 0:
        sys.exit(1)
    else:
        print('All tests passed.')
        sys.exit(0)
