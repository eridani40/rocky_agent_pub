"""
case.yaml 加载 + schema 校验
参考：design_case_schema.md §1-§6；change_plan v0.0.190 D 节 case_loader.py
硬规则：
  - timeout>60 的 wait/poll/oracle → 拒载（v0.0.125 用户裁决放宽：默认仍宜 ≤10，真 LLM 长任务上限 60；v0.0.203 再放宽 poll 上限到 180：trainer 真 LLM 多 turn 链路用户授权）
  - 未知顶层/step 字段 → 拒载
  - 多动作类 → 拒载
  - 非原子 check → 拒载
  - 重名命名流 → 拒载
  - 未声明插值变量 → 拒载
v0.0.190 起：删 stub + frame_checks 字段（AT 改真实调 API，无录制无帧合同）。
"""
import os
import re
import yaml
from dataclasses import dataclass
from typing import Any, List, Optional


class CaseLoadError(Exception):
    """case.yaml 校验失败"""
    pass


@dataclass
class Step:
    name: str
    raw: dict   # 原始 step dict


@dataclass
class Case:
    case: str
    module: str
    timeout: int
    requires: Optional[str]
    setup: List[Step]
    steps: List[Step]
    teardown: List[Step]
    case_dir: str


# ─── 顶层/step 允许字段 ───────────────────────────────────────────────────────

_TOP_FIELDS = {'case', 'module', 'timeout', 'requires', 'setup', 'steps', 'teardown'}
_STEP_FIELDS = {'name', 'requests', 'request', 'run', 'poll', 'wait', 'oracle',
                'sse', 'save', 'check', 'files', 'timeout'}
_ACTION_KEYS = ('requests', 'request', 'run', 'poll', 'wait', 'oracle', 'files')


def load_case(case_dir: str) -> Case:
    """
    加载并校验 case.yaml，返回 Case 对象。
    校验失败 raise CaseLoadError（case 标 not_run(load_error)）。
    """
    yaml_path = os.path.join(case_dir, 'case.yaml')
    if not os.path.isfile(yaml_path):
        raise CaseLoadError(f'case.yaml not found: {yaml_path}')

    with open(yaml_path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise CaseLoadError('case.yaml must be a mapping')

    # 未知顶层字段
    unknown = set(data.keys()) - _TOP_FIELDS
    if unknown:
        raise CaseLoadError(f'unknown top-level fields: {sorted(unknown)}')

    # 必填
    case_id = _require_str(data, 'case')
    module = _require_str(data, 'module')

    # case_id 与目录名一致
    dir_name = os.path.basename(case_dir.rstrip('/'))
    if case_id != dir_name:
        raise CaseLoadError(
            f"case id '{case_id}' must match directory name '{dir_name}'"
        )

    # module 与父目录名一致
    parent = os.path.basename(os.path.dirname(case_dir.rstrip('/')))
    if module != parent:
        raise CaseLoadError(
            f"module '{module}' must match parent directory name '{parent}'"
        )

    # timeout
    timeout = int(data.get('timeout', 60))
    if not (1 <= timeout <= 300):
        raise CaseLoadError(f'timeout must be in [1, 300], got {timeout}')

    # requires
    requires = data.get('requires')
    if requires is not None and requires != 'live':
        raise CaseLoadError(f"requires must be 'live' or omitted, got {requires!r}")

    # 收集全局 save 变量（用于插值变量检查）
    # 两遍：第一遍收集所有 save key，第二遍校验插值引用
    all_phases = [
        ('setup', data.get('setup', []) or []),
        ('steps', data.get('steps', [])),
        ('teardown', data.get('teardown', []) or []),
    ]
    if not all_phases[1][1]:
        raise CaseLoadError("'steps' is required and must have at least 1 step")

    # 收集 save 变量 + sse.sub as_name（用于 wait 引用校验）
    saved_vars: set = set()
    stream_names: set = set()  # case 级唯一集合（design_case_schema §4：case 内唯一）

    # 两遍解析：先收集，再校验
    parsed_phases = {}
    for phase_name, phase_steps in all_phases:
        parsed = []
        for i, raw_step in enumerate(phase_steps):
            if not isinstance(raw_step, dict):
                raise CaseLoadError(f'{phase_name}[{i}] must be a mapping')
            # save 收集
            for var in (raw_step.get('save') or {}).keys():
                saved_vars.add(var)
            # stream as_name 收集（case 级去重，跨 step 也拒载）
            for sub in ((raw_step.get('sse') or {}).get('sub', [])):
                as_n = sub.get('as') or f"stream_{sub.get('topic', '')}_{len(stream_names)}"
                if as_n in stream_names:
                    raise CaseLoadError(
                        f'{phase_name}[{i}]: duplicate stream name {as_n!r} '
                        f'(case-level unique, design_case_schema §4)'
                    )
                stream_names.add(as_n)
            parsed.append(raw_step)
        parsed_phases[phase_name] = parsed

    # 第二遍：逐步深度校验
    for phase_name, raw_steps in parsed_phases.items():
        for i, raw_step in enumerate(raw_steps):
            _validate_step(raw_step, phase_name, i, saved_vars, stream_names)

    def make_steps(raw_list):
        return [Step(name=s['name'], raw=s) for s in raw_list]

    return Case(
        case=case_id, module=module, timeout=timeout, requires=requires,
        setup=make_steps(parsed_phases['setup']),
        steps=make_steps(parsed_phases['steps']),
        teardown=make_steps(parsed_phases['teardown']),
        case_dir=case_dir,
    )


# ─── step 校验 ────────────────────────────────────────────────────────────────

def _validate_step(step: dict, phase: str, idx: int, saved_vars: set, stream_names: set) -> None:
    loc = f'{phase}[{idx}]'

    # name 必填
    if not isinstance(step.get('name'), str) or not step['name']:
        raise CaseLoadError(f'{loc}: name is required and must be non-empty')

    # 未知 step 字段
    unknown = set(step.keys()) - _STEP_FIELDS
    if unknown:
        raise CaseLoadError(f'{loc}: unknown step fields: {sorted(unknown)}')

    # 多动作类
    actions = [k for k in _ACTION_KEYS if k in step]
    if len(actions) > 1:
        raise CaseLoadError(
            f"{loc}: multiple action classes: {actions} "
            f"(step '{step['name']}' has multiple action classes)"
        )

    # 各动作类校验
    if 'poll' in step:
        _validate_poll(step['poll'], loc)
    if 'wait' in step:
        _validate_wait(step['wait'], loc, stream_names)
    if 'oracle' in step:
        _validate_oracle(step['oracle'], loc)
    if 'files' in step:
        _validate_files(step['files'], loc)
    if 'timeout' in step:
        _validate_requests_timeout(step, loc)

    # sse.sub 字段校验（case 级重名已在 load_case 第一遍拒载）
    for sub in ((step.get('sse') or {}).get('sub', [])):
        _require_str(sub, 'topic', loc)
        _require_str(sub, 'group', loc)

    # check 原子性
    for expr in (step.get('check') or []):
        from check_engine import parse_atomic
        parse_atomic(str(expr))  # 非原子 → CaseLoadError

    # 插值变量（静态检查）
    _check_interp_refs(step, saved_vars, loc)


def _validate_poll(cfg: dict, loc: str) -> None:
    if not isinstance(cfg, dict):
        raise CaseLoadError(f'{loc}: poll must be a mapping')
    t = cfg.get('timeout')
    if t is None:
        raise CaseLoadError(f'{loc}: poll.timeout is required')
    if float(t) > 180:
        raise CaseLoadError(f'{loc}: poll.timeout must be <=180, got {t}')
    if not cfg.get('request'):
        raise CaseLoadError(f'{loc}: poll.request is required')
    if not cfg.get('until'):
        raise CaseLoadError(f'{loc}: poll.until is required')


def _validate_wait(cfg: dict, loc: str, stream_names: set) -> None:
    if not isinstance(cfg, dict):
        raise CaseLoadError(f'{loc}: wait must be a mapping')
    t = cfg.get('timeout')
    if t is None:
        raise CaseLoadError(f'{loc}: wait.timeout is required')
    if float(t) > 60:
        raise CaseLoadError(f'{loc}: wait.timeout must be <=60, got {t}')
    stream = cfg.get('stream')
    if not stream:
        raise CaseLoadError(f'{loc}: wait.stream is required')


def _validate_oracle(cfg: dict, loc: str) -> None:
    if not isinstance(cfg, dict):
        raise CaseLoadError(f'{loc}: oracle must be a mapping')
    lf = cfg.get('langfuse', {})
    t = lf.get('timeout')
    if t is None:
        raise CaseLoadError(f'{loc}: oracle.langfuse.timeout is required')
    if float(t) > 60:
        raise CaseLoadError(f'{loc}: oracle.langfuse.timeout must be <=60, got {t}')


def _validate_files(cfg: list, loc: str) -> None:
    """files 原语校验：惰性导入避免循环依赖"""
    from files_validator import validate_files
    validate_files(cfg, loc)


def _validate_requests_timeout(step: dict, loc: str) -> None:
    """
    requests 步骤可选 timeout 字段（v0.0.151 起，AT 框架增强）：单次 HTTP 请求超时秒数，
    区别于顶层 case 级 `timeout`（整体 case 超时，[1,300]）——这是 step 级、
    只影响该 step 内 requests/request 动作的 urlopen 超时。
    缺省不写时 interp.http_request 用旧值 30（现状不变）；真 LLM 长同步调用
    （如 test-only 整理端点）超过默认 30s 时才需显式声明更长值，上限 240
    （留出运行开销余量，小于 case 级 300 上限）。
    仅 requests/request 动作类适用——poll/wait/oracle 各自已有独立超时字段
    （poll.timeout/wait.timeout/oracle.langfuse.timeout），此处不重复承载，
    出现在其他动作类的 step 上直接拒载（防止误用被静默忽略）。
    """
    if not ({'requests', 'request'} & step.keys()):
        raise CaseLoadError(
            f"{loc}: 'timeout' only applies to requests/request steps "
            f"(poll/wait/oracle have their own nested timeout field)"
        )
    t = step['timeout']
    if isinstance(t, bool) or not isinstance(t, int):
        raise CaseLoadError(f'{loc}: timeout must be an int, got {t!r}')
    if not (1 <= t <= 240):
        raise CaseLoadError(f'{loc}: timeout must be in [1, 240], got {t}')


def _check_interp_refs(step: dict, saved_vars: set, loc: str) -> None:
    """
    静态检查 {var} 插值引用是否已通过 save 定义（design_case_schema §6）。
    saved_vars 已跨 phase 全量收集，nowhere-saved 的 var 在 load 期拒载。
    检查 path/body/group 三处插值位置（即所有字符串值）。
    """
    # 变量名语法须与 interp.py 的 _VAR_RE 保持一致（大小写字母/数字/下划线）——
    # 曾只认小写，大写变量名（如 {sidA}）绕过本检查，运行期又静默不插值，双重隐蔽 bug。
    all_text = _extract_strings(step)
    for s in all_text:
        for m in re.finditer(r'\{([a-zA-Z0-9_]+)\}', s):
            var = m.group(1)
            if var not in saved_vars:
                raise CaseLoadError(
                    f"{loc}: undefined interpolation variable '{{{var}}}' "
                    f"('{var}' not found in any save definition)"
                )


def _extract_strings(obj: Any) -> list:
    """递归提取 dict/list 中的所有字符串值"""
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        result = []
        for v in obj.values():
            result.extend(_extract_strings(v))
        return result
    if isinstance(obj, list):
        result = []
        for item in obj:
            result.extend(_extract_strings(item))
        return result
    return []


def _require_str(d: dict, key: str, loc: str = '') -> str:
    val = d.get(key)
    if not isinstance(val, str) or not val:
        prefix = f'{loc}: ' if loc else ''
        raise CaseLoadError(f"{prefix}'{key}' is required and must be a non-empty string")
    return val
