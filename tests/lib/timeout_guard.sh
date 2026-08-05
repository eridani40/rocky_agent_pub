# tests/lib/timeout_guard.sh — portable per-case timeout enforcement.
# macOS has NO `timeout`/`gtimeout` binary. Sourced by run_case.py (api + e2e), wraps the case in
# a new session, kills the WHOLE process tree on timeout (SIGTERM → 4s grace → SIGKILL).
#
# timeout_guard <seconds> <cmd...>
#   Returns the command's exit code on normal completion; 124 on timeout (mimics GNU timeout).
#   Caller should write a {result:timeout} last_run.json when it sees 124.
# Uses python3 (always present) — start_new_session=True = setsid (own pgid); killpg kills the
# whole tree (curl SSE listeners, python3 -c helpers, forked subprocesses — no orphans).
timeout_guard() {
  local to="${1:-180}"; shift
  python3 - "$to" "$@" <<'PY'
import os, signal, subprocess, sys
to = int(sys.argv[1])
try:
    p = subprocess.Popen(sys.argv[2:], start_new_session=True)
except Exception as e:
    print(f"[timeout_guard] spawn failed: {e}", file=sys.stderr); sys.exit(126)
try:
    rc = p.wait(timeout=to)
    # negative returncode = killed by signal → normalize to 128+signo
    sys.exit(rc if rc >= 0 else 128 - rc)
except subprocess.TimeoutExpired:
    print(f"[timeout_guard] {to}s exceeded — SIGTERM process group", file=sys.stderr)
    try: os.killpg(os.getpgid(p.pid), signal.SIGTERM)
    except ProcessLookupError: pass
    try:
        p.wait(timeout=4)
    except subprocess.TimeoutExpired:
        print("[timeout_guard] SIGKILL process group", file=sys.stderr)
        try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except ProcessLookupError: pass
    sys.exit(124)
PY
}
