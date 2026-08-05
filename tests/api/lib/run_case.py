"""
单 case 入口：load → setup/steps/teardown 编排 → 写 result.json
参考：design_storage_runall.md §2；change_plan v0.0.190 D 节 run_case.py（简化版）

v0.0.190 起 AT 改真实调 API（不录制不回放）：
  - 删 mode 参数（恒 live 真调）
  - 删 snapshot/commit/drift/frame_checks/stub audit 全部逻辑
  - 保留 phase 三段（setup/steps/teardown）+ per-step 产物 + SSE collector + cleanup
  - 429/529/503 → step_exec 抛 RateLimitedError → 捕获后 result='skipped', reason='429'
  - skipped 不算 fail 不阻塞，整体 run_all 聚合单列计数
"""
import json
import os
import sys
import time

from case_loader import load_case, CaseLoadError, Case
from step_exec import exec_step, RateLimitedError
from artifacts import write_step, write_result
from sse_collector import SseCollector
from files_action import cleanup_written_files
from interp import get_base_url


def _base_url() -> str:
    return get_base_url()


def _run_phase(
    phase_name: str,
    steps: list,
    ctx: dict,
    sse: SseCollector,
    case_dir: str,
    step_offset: int,
) -> tuple:
    """
    执行一个 phase（setup/steps/teardown）。
    返回 (phase_pass, step_offset_after, steps_summary)
    RateLimitedError 直接向上抛（让 _run_case_once 捕获转 skipped）。
    """
    phase_pass = True
    steps_summary = []

    for i, step in enumerate(steps):
        n = step_offset + i

        # 记录 step 前各流计数（用于增量 events 快照）
        prev_counts = sse.get_counts() if sse else {}

        t0 = time.monotonic()
        result = exec_step(step.raw, ctx, sse)
        elapsed_ms = int((time.monotonic() - t0) * 1000)

        # 收集本 step 期间 SSE 增量事件
        events_inc = []
        if sse:
            inc = sse.get_step_events_increment(prev_counts)
            for events in inc.values():
                events_inc.extend(events)

        # 落盘 per-step 产物
        write_step(
            case_dir=case_dir,
            n=n,
            phase=phase_name,
            name=step.name,
            action=result['action'],
            responses=result['responses'],
            events_snapshot=events_inc,
            checks=result['checks_results'],
            extra=result.get('extra') or {},
        )

        step_ok = result['pass']
        failed_checks = [c['expr'] for c in result['checks_results'] if not c['pass']]
        summary = {
            'n': f'{n:02d}', 'phase': phase_name, 'name': step.name,
            'pass': step_ok, 'elapsed_ms': elapsed_ms,
        }
        if failed_checks:
            summary['checks_failed'] = failed_checks
        else:
            summary['checks'] = len(result['checks_results'])
        steps_summary.append(summary)

        if not step_ok:
            phase_pass = False
            # steps phase fail 后继续（teardown 必跑），但同 phase 后续步骤跳过
            if phase_name != 'teardown':
                break

    return phase_pass, step_offset + len(steps), steps_summary


def _run_case_once(case: Case, case_dir: str) -> dict:
    """
    执行一次 case（真实调 API，无录制无回放）。
    返回 case 级 result dict（未写 result.json，由 main 写）。
    RateLimitedError → result='skipped', reason='429'。
    """
    ctx = {}
    sse = None
    t0 = time.monotonic()
    all_steps_summary: list = []
    phases_result: dict = {}

    try:
        # SSE collector（按需惰性初始化——首次 subscribe 时建连）
        sse = SseCollector(_base_url())

        step_offset = 0

        # setup
        setup_pass, step_offset, setup_summary = _run_phase(
            'setup', case.setup, ctx, sse, case_dir, step_offset)
        all_steps_summary.extend(setup_summary)
        phases_result['setup'] = {'pass': setup_pass}

        if not setup_pass:
            result_str = 'not_run'
            phases_result['steps'] = {'pass': False}
            phases_result['teardown'] = {'pass': True}
        else:
            steps_pass, step_offset, steps_summary = _run_phase(
                'steps', case.steps, ctx, sse, case_dir, step_offset)
            all_steps_summary.extend(steps_summary)
            failed_step_ns = [int(s['n']) for s in steps_summary if not s['pass']]
            phases_result['steps'] = {'pass': steps_pass,
                                       **(({'failed_steps': failed_step_ns}) if failed_step_ns else {})}
            result_str = 'pass' if steps_pass else 'fail'

            # teardown（无论 steps 是否 pass 必跑；teardown 自身 fail 也只标 small 不翻 case）
            td_pass, step_offset, td_summary = _run_phase(
                'teardown', case.teardown, ctx, sse, case_dir, step_offset)
            all_steps_summary.extend(td_summary)
            phases_result['teardown'] = {'pass': td_pass}

        elapsed_ms = int((time.monotonic() - t0) * 1000)

    except RateLimitedError as e:
        # 限流 → skipped（不算 fail、不阻塞 run_all）。已执行的步骤产物留在 last_run/，elapsed_ms 取已耗时段。
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return {
            'case': case.case, 'module': case.module, 'result': 'skipped',
            'reason': '429', 'detail': str(e),
            'phases': phases_result,
            'steps': all_steps_summary,
            'elapsed_ms': elapsed_ms,
        }
    finally:
        if sse is not None:
            try:
                sse.close()
            except Exception:
                pass
        # 清理 files 原语写入的文件（case 自管环境，无论 pass/fail/skipped 必清理）
        try:
            cleanup_written_files(ctx)
        except Exception:
            pass

    return {
        'case': case.case, 'module': case.module, 'result': result_str,
        'phases': phases_result,
        'steps': all_steps_summary,
        'elapsed_ms': elapsed_ms,
    }


def main(case_dir: str) -> dict:
    """
    case 入口：load → 执行 → 写 result.json。
    返回 result dict（run_all 用）。
    """
    # load 期校验
    try:
        case = load_case(case_dir)
    except CaseLoadError as e:
        result = {
            'case': os.path.basename(case_dir),
            'module': os.path.basename(os.path.dirname(case_dir)),
            'result': 'not_run',
            'not_run_reason': f'load_error: {e}',
            'elapsed_ms': 0,
        }
        write_result(case_dir, result)
        return result

    result = _run_case_once(case, case_dir)
    write_result(case_dir, result)
    return result


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: run_case.py <case_dir>', file=sys.stderr)
        sys.exit(1)
    case_dir_arg = sys.argv[1]
    res = main(case_dir_arg)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    # pass/skipped 都算成功退出（skipped 不算 fail）；其他 → 1
    sys.exit(0 if res.get('result') in ('pass', 'skipped') else 1)
