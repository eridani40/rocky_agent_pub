"""
运行产物写入：per-step 落盘 + result.json
参考：design_storage_runall.md §2；change_plan B 组 artifacts.py
"""
import json
import os
from typing import Any


def _mkdir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _write_json(path: str, obj: Any) -> None:
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def _write_jsonl(path: str, lines: list) -> None:
    with open(path, 'w', encoding='utf-8') as f:
        for line in lines:
            f.write(json.dumps(line, ensure_ascii=False) + '\n')


def write_step(
    case_dir: str,
    n: int,
    phase: str,
    name: str,
    action: str,
    responses: list,
    events_snapshot: list,
    checks: list,
    extra: dict = None,
) -> None:
    """
    落 steps/NN/{responses.json, events.jsonl, checks.json}。
    n = 全局连续步骤编号（setup/steps/teardown 共用）。
    """
    step_dir = os.path.join(case_dir, 'last_run', 'steps', f'{n:02d}')
    _mkdir(step_dir)

    resp_obj = {
        'phase': phase,
        'name': name,
        'action': action,
        'requests': responses,
    }
    if extra:
        resp_obj.update(extra)
    _write_json(os.path.join(step_dir, 'responses.json'), resp_obj)
    _write_jsonl(os.path.join(step_dir, 'events.jsonl'), events_snapshot)
    _write_json(os.path.join(step_dir, 'checks.json'), checks)


def write_result(case_dir: str, case_result: dict) -> None:
    """
    落 last_run/result.json（5 分类：pass/fail/timeout/not_run/skipped）。
    v0.0.190 起去 record/replay，result 字段简化为 case/module/result/phases/steps/elapsed_ms
    [+ reason/detail 若 skipped / + not_run_reason 若 not_run]。
    """
    out_dir = os.path.join(case_dir, 'last_run')
    _mkdir(out_dir)
    _write_json(os.path.join(out_dir, 'result.json'), case_result)
