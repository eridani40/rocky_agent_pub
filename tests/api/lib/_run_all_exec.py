"""
run_all 执行引擎：逐 case 串行跑 run_case.py + five-class 聚合
由 run_all.sh 调用，不直接使用。

v0.0.190 起 AT 改真实调 API：
  - 删 _double_gate（无 record→replay 双关）
  - 删 drift 分类（无 drift 概念）
  - 加 skipped 分类（429/529/503 → skipped/reason=429，不算 fail 不阻塞 overall）
  - 5 分类：pass / fail / timeout / not_run / skipped
  - overall = pass iff fail==0 && timeout==0（skipped/not_run 不翻 overall）

参数（通过 sys.argv）：
  argv[1] = out_dir     聚合产物目录
  argv[2] = map_raw     case 列表（每行 cid\tcdir\tmod）
  argv[3] = run_case_py run_case.py 绝对路径
"""
import json
import os
import signal
import sys
import subprocess
import time
from datetime import datetime, timezone

try:
    import yaml as _yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _parse_budget(v: str):
    try:
        f = float(v.strip()) if v.strip() else None
        return f if (f is not None and f > 0) else None
    except ValueError:
        return None


def _read_case_timeout(case_dir: str, default: int = 60) -> int:
    """从 case.yaml 读顶层 timeout 字段（默认 60s，与 case_loader 一致）。"""
    yaml_path = os.path.join(case_dir, "case.yaml")
    if not os.path.isfile(yaml_path):
        return default
    try:
        if _HAS_YAML:
            with open(yaml_path) as f:
                data = _yaml.safe_load(f) or {}
        else:
            # yaml 未安装：手动解析顶层 "timeout: N" 一行（满足 case.yaml 简单格式）
            data = {}
            with open(yaml_path) as f:
                for line in f:
                    stripped = line.strip()
                    if stripped.startswith("timeout:"):
                        val = stripped.split(":", 1)[1].strip()
                        try:
                            data["timeout"] = int(val)
                        except ValueError:
                            pass
                        break
        t = int(data.get("timeout", default))
        return t if 1 <= t <= 300 else default
    except Exception:
        return default


def _run_once(case_dir: str, run_case_py: str) -> dict:
    """
    调 run_case.py 跑一次（真实调 API），返回 result dict。
    per-case 超时兜底：读 case.yaml.timeout（默认 60s），用进程树杀防孤儿。
    """
    env = dict(os.environ)
    lib_dir = os.path.dirname(run_case_py)
    env["PYTHONPATH"] = lib_dir + (":" + env["PYTHONPATH"] if "PYTHONPATH" in env else "")

    case_timeout = _read_case_timeout(case_dir)
    # buffer：给 run_case.py 自身兜底留 5s（teardown 等），超出定性 run_all 超时
    timeout_with_buffer = case_timeout + 5

    t0 = time.monotonic()
    wall_t0 = time.time()  # getmtime 是 wall-clock（epoch），须用同一时钟比对新鲜度

    # start_new_session=True：子进程进独立进程组，os.killpg 树杀覆盖 SSE 线程/curl 子进程
    proc = subprocess.Popen(
        [sys.executable, run_case_py, case_dir],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=env, start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout_with_buffer)
    except subprocess.TimeoutExpired:
        # 树杀：killpg 覆盖全进程组（含 curl/SSE 线程等孤儿）
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return {
            "result": "timeout",
            "case": os.path.basename(case_dir),
            "module": os.path.basename(os.path.dirname(case_dir)),
            "elapsed_ms": elapsed_ms,
            "_error": f"case timed out after {timeout_with_buffer}s (case.yaml timeout={case_timeout}s)",
        }

    # 优先读 last_run/result.json（本轮子进程刚写的才算新鲜，防读上一轮旧文件）
    result_path = os.path.join(case_dir, "last_run", "result.json")
    fresh = os.path.isfile(result_path) and os.path.getmtime(result_path) >= wall_t0 - 1
    if fresh:
        try:
            return json.load(open(result_path))
        except Exception:
            pass
    # fallback：解析 stdout 最后一行 JSON
    for line in reversed(stdout.splitlines()):
        try:
            d = json.loads(line)
            if "result" in d:
                return d
        except Exception:
            pass
    elapsed = int((time.monotonic() - t0) * 1000)
    return {
        "result": "fail",
        "case": os.path.basename(case_dir),
        "module": os.path.basename(os.path.dirname(case_dir)),
        "elapsed_ms": elapsed,
        "_error": f"run_case.py exit rc={proc.returncode}: {(stderr or stdout)[-300:]}",
    }


def _make_entry(cid: str, mod: str, res_dict: dict) -> dict:
    """构造 cases 数组单项（result + skip_reason + elapsed_ms + error）。"""
    rd = res_dict or {}
    status = rd.get("result", "fail")
    entry: dict = {
        "case": cid, "module": mod, "result": status,
        "elapsed_ms": rd.get("elapsed_ms", 0),
    }
    # skipped 带 reason（429）+ detail（限流响应片段）
    if status == "skipped":
        entry["skip_reason"] = rd.get("reason", "unknown")
        if rd.get("detail"):
            entry["detail"] = rd["detail"]
    if rd.get("_error"):
        entry["error"] = rd["_error"]
    return entry


def main():
    out_dir, map_raw, run_case_py = sys.argv[1], sys.argv[2], sys.argv[3]
    cases = [line.split('\t') for line in map_raw.strip().splitlines() if line.strip()]
    version = os.environ.get("VERSION", "")

    budget = _parse_budget(os.environ.get("RUN_BUDGET_SECONDS", "900"))
    progress_path = os.path.join(out_dir, "progress.jsonl")

    with open(progress_path, "w") as f:
        f.write(json.dumps({"event": "start", "kind": "api-realcall",
                            "total": len(cases), "ts": _ts()}) + "\n")

    wall_t0 = time.monotonic()
    results = []
    budget_hit = False

    def _budget_ok():
        return budget is None or (time.monotonic() - wall_t0) < budget

    for cid, cdir, mod in cases:
        if budget_hit or not _budget_ok():
            budget_hit = True
            entry = {"case": cid, "module": mod, "result": "not_run",
                     "elapsed_ms": 0, "not_run_reason": "budget_exhausted"}
            results.append(entry)
            with open(progress_path, "a") as f:
                f.write(json.dumps({"event": "case", "case_id": cid, "module": mod,
                                    "result": "not_run", "ts": _ts()}) + "\n")
            print(f"[run_all] {cid}: not_run (budget_exhausted)")
            continue

        print(f"[run_all] {cid}: starting")
        with open(progress_path, "a") as f:
            f.write(json.dumps({"event": "case_start", "case_id": cid,
                                "module": mod, "ts": _ts()}) + "\n")
        t0 = time.monotonic()
        res = _run_once(cdir, run_case_py)
        entry = _make_entry(cid, mod, res)

        elapsed_s = round(time.monotonic() - t0, 1)
        entry.setdefault("elapsed_ms", int(elapsed_s * 1000))
        results.append(entry)

        with open(progress_path, "a") as f:
            f.write(json.dumps({"event": "case", "case_id": cid, "module": mod,
                                "result": entry["result"], "elapsed_s": elapsed_s,
                                "ts": _ts()}) + "\n")
        print(f"[run_all] {cid}: {entry['result']} ({elapsed_s}s)")

    # 5 分类聚合：pass/fail/timeout/not_run/skipped
    # overall 只看 fail/timeout（skipped/not_run 不翻 overall）
    counts = {"pass": 0, "fail": 0, "timeout": 0, "not_run": 0, "skipped": 0}
    for e in results:
        s = e["result"]
        counts[s] = counts.get(s, 0) + 1

    overall = "pass" if (counts.get("fail", 0) == 0 and counts.get("timeout", 0) == 0) else "fail"
    wall_s = round(time.monotonic() - wall_t0, 1)

    out_data = {
        "version": version, "overall": overall,
        "total_count": len(results),
        "pass_count": counts.get("pass", 0),
        "fail_count": counts.get("fail", 0),
        "timeout_count": counts.get("timeout", 0),
        "not_run_count": counts.get("not_run", 0),
        "skipped_count": counts.get("skipped", 0),
        "wall_time_seconds": wall_s, "budget_hit": budget_hit, "cases": results,
    }
    result_path = os.path.join(out_dir, "run_all_result.json")
    json.dump(out_data, open(result_path, "w"), ensure_ascii=False, indent=2)

    # done 事件（轮询者见到此行才安全读结果）
    with open(progress_path, "a") as f:
        f.write(json.dumps({"event": "done", "overall": overall, "ts": _ts()}) + "\n")

    print(f"\n=== run_all_result: {overall}  "
          f"pass={counts.get('pass',0)} fail={counts.get('fail',0)} "
          f"timeout={counts.get('timeout',0)} not_run={counts.get('not_run',0)} "
          f"skipped={counts.get('skipped',0)}  wall={wall_s}s")
    print(f"    → {result_path}")


if __name__ == "__main__":
    main()
