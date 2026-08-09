#!/usr/bin/env python3
"""langfuse-fetcher Python 客户端（只读 IO 层）。

可导入做脚本化查询，也可直接命令行：
    python3 langfuse_client.py <cmd> [pos] [--param=value ...]

凭证：构造时显式传，或 LangfuseClient.from_test_env() 从 repo 根 test.env 读。
认证：HTTP Basic，user=public_key，password=secret_key。
全部 GET /api/public/*，只读。参数名用 langfuse 原名（sessionId / userId / traceId / type ...）。
"""
from __future__ import annotations
import argparse, base64, json, os, sys, urllib.error, urllib.parse, urllib.request


class LangfuseError(RuntimeError):
    """HTTP>=4xx 或网络不可达。status=0 表示网络层失败。"""

    def __init__(self, msg, status=0, body=""):
        super().__init__(msg)
        self.status = status
        self.body = body


class LangfuseClient:
    def __init__(self, base_url, public_key, secret_key, timeout=30):
        self.base_url = base_url.rstrip("/")
        self.api = self.base_url + "/api/public"
        tok = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        self._hdr = {"Authorization": "Basic " + tok}
        self.timeout = timeout

    @classmethod
    def from_test_env(cls, repo_root=None, timeout=30):
        base, pub, sec = _load_test_env(repo_root)
        return cls(base, pub, sec, timeout)

    # ── 核心 GET ──
    def _get(self, path, params=None):
        url = self.api + "/" + path.lstrip("/")
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        req = urllib.request.Request(url, headers=self._hdr, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            raise LangfuseError(f"HTTP {e.code} {url}", e.code, body)
        except urllib.error.URLError as e:
            raise LangfuseError(f"unreachable: {url} ({e.reason})", 0, "")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw  # 非 JSON（如纯文本），原样返回

    def health(self):
        try:
            return bool(self._get("health"))
        except LangfuseError:
            return False

    # ── 单资源 ──
    def get_trace(self, trace_id):       return self._get(f"traces/{trace_id}")
    def get_observation(self, obs_id):   return self._get(f"observations/{obs_id}")
    def get_score(self, score_id):       return self._get(f"scores/{score_id}")
    def get_session(self, session_id):   return self._get(f"sessions/{session_id}")
    def get_user(self, user_id):         return self._get(f"users/{user_id}")

    # ── 列表（filters 用 langfuse 原参数名） ──
    def list_traces(self, **f):       return self._get("traces", f or None)
    def list_observations(self, **f): return self._get("observations", f or None)
    def list_scores(self, **f):       return self._get("scores", f or None)
    def list_sessions(self, **f):     return self._get("sessions", f or None)
    def list_users(self, **f):        return self._get("users", f or None)

    def execute_query(self, query_id): return self._get(f"queries/{query_id}/execute")

    def raw(self, path, **params): return self._get(path, params or None)

    # ── 自动翻页（拉满一个 list endpoint） ──
    def paginate(self, list_method, key="data", page_size=100, max_pages=None, **filters):
        """逐页 yield 单条 item，直到拉满。list_method 例：client.list_traces。"""
        page = 1
        while True:
            res = list_method(limit=page_size, page=page, **filters)
            if res is None:
                return
            items = res.get(key, []) if isinstance(res, dict) else (res or [])
            for it in items:
                yield it
            meta = res.get("meta", {}) if isinstance(res, dict) else {}
            total_pages = meta.get("totalPages") or meta.get("totalPage")
            if total_pages:
                if page >= total_pages:
                    return
            elif len(items) < page_size:
                return
            page += 1
            if max_pages and page > max_pages:
                return


# ── test.env 读取 ──
def _find_repo_root(start=None):
    d = os.path.abspath(start or os.path.dirname(__file__))
    while d != "/":
        if os.path.isfile(os.path.join(d, "test.env")):
            return d
        d = os.path.dirname(d)
    return os.path.abspath(start or os.getcwd())


def _load_test_env(repo_root=None):
    root = repo_root or _find_repo_root()
    f = os.path.join(root, "test.env")
    if not os.path.isfile(f):
        raise FileNotFoundError(f"test.env 未找到: {f}")
    env = {}
    with open(f, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    missing = [k for k in ("LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY") if k not in env]
    if missing:
        raise KeyError(f"test.env 缺 langfuse 凭证: {missing}")
    return env["LANGFUSE_BASE_URL"], env["LANGFUSE_PUBLIC_KEY"], env["LANGFUSE_SECRET_KEY"]


# ── 命令行入口（精简；全功能用 lf.sh） ──
def _pp(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def _main(argv=None):
    ap = argparse.ArgumentParser(description="langfuse-fetcher python client (read-only)")
    ap.add_argument("cmd", choices=["health", "traces", "trace", "observations", "observation",
                                    "scores", "score", "sessions", "session", "users", "user",
                                    "query", "raw"])
    ap.add_argument("rest", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    c = LangfuseClient.from_test_env()
    pos = [x for x in a.rest if not x.startswith("--")]
    flt = {}
    for x in a.rest:
        if x.startswith("--") and "=" in x:
            k, v = x[2:].split("=", 1)
            flt[k] = v
    try:
        if a.cmd == "health":
            print(c.health()); return
        if a.cmd in ("trace", "observation", "score", "session", "user"):
            names = {"trace": "get_trace", "observation": "get_observation", "score": "get_score",
                     "session": "get_session", "user": "get_user"}[a.cmd]
            _pp(getattr(c, names)(pos[0])); return
        if a.cmd == "query":
            _pp(c.execute_query(pos[0])); return
        if a.cmd == "raw":
            _pp(c.raw(pos[0], **flt)); return
        names = {"traces": "list_traces", "observations": "list_observations", "scores": "list_scores",
                 "sessions": "list_sessions", "users": "list_users"}[a.cmd]
        _pp(getattr(c, names)(**flt))
    except LangfuseError as e:
        print(f"[ERR] {e} body={e.body[:300]}", file=sys.stderr); sys.exit(1)


if __name__ == "__main__":
    _main()
