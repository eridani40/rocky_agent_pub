"""
API Test Runner — 读取 checkpoint.json，顺序执行所有 step，评估 checks，并写回结果。

通用化版本：不绑定任何特定项目。所有项目相关参数通过环境变量注入。

依赖的 env 变量:
  BASE_URL    —— API 根地址（默认 http://localhost:${SERVER_PORT:-3701}）
  DATA_ROOT   —— 数据根目录，用于 {{DATA_ROOT}} 替换（默认 ~/.${APP_NAME:-app}_${TEST_ENV:-test}）

支持的能力:
  - method: GET / POST / PUT / PATCH / DELETE / UPLOAD_ZIP / UPLOAD_RAW / UPLOAD_FILE / CHECK_FILE
  - 变量替换: {{BASE}} / {{DATA_ROOT}} / {stepN.path.to.field}（跨 step 引用前序响应字段）
  - checks ops: eq / ne / contains / regex / exists / gt / gte / lt / lte / in
  - 产物: response-stepN.json（每步响应原文）+ checkpoint.json 回写 result/desc + last_run.json

用法:
  export BASE_URL=http://localhost:3701
  python3 runner.py path/to/case/checkpoint.json
"""
import json, sys, os, re, subprocess, shutil
from pathlib import Path

APP_NAME = os.environ.get("APP_NAME", "app")
TEST_ENV = os.environ.get("TEST_ENV", "test")
DEFAULT_PORT = os.environ.get("SERVER_PORT", "3701")
BASE_URL = os.environ.get("BASE_URL", f"http://localhost:{DEFAULT_PORT}")
DATA_ROOT = os.environ.get("DATA_ROOT", os.path.expanduser(f"~/.{APP_NAME}_{TEST_ENV}"))


def resolve(template: str, ctx: dict) -> str:
    """替换 {{BASE}} / {{DATA_ROOT}} / {{env:VAR}} / {stepN.path.to.field} 变量

    - {{BASE}} / {{DATA_ROOT}}: 全局常量
    - {{env:VAR_NAME}}: 从 os.environ 读取，缺失时填空串并向 stderr 警告（不中断，便于发现漏配）
    - {stepN.path.to.field}: 跨 step 引用前序响应字段
    """
    s = template.replace("{{BASE}}", BASE_URL).replace("{{DATA_ROOT}}", DATA_ROOT)
    # {{env:VAR_NAME}} → os.environ，缺失则空串并 stderr 警告（避免泄露占位到请求里）
    def _replace_env(m):
        var = m.group(1)
        val = os.environ.get(var)
        if val is None:
            print(f"[runner] WARN: env var '{var}' 未设置，替换为空串", file=sys.stderr)
            return ""
        return val
    s = re.sub(r'\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}', _replace_env, s)
    # 支持 {stepN.path.to.field} 嵌套路径
    def _replace_var(m):
        key = m.group(1)
        parts = key.split(".")
        val = ctx
        for p in parts:
            if isinstance(val, dict):
                val = val.get(p)
            else:
                return m.group(0)  # 无法解析，保持原样
        return str(val) if val is not None else m.group(0)
    s = re.sub(r'\{([a-zA-Z_][a-zA-Z0-9_.]*)\}', _replace_var, s)
    return s


def resolve_value(value, ctx: dict):
    """对 check.value 做 resolve（BUG-002）。

    - 字符串：过 resolve()，含 {stepN...} 时替换为前序响应的真实值；
      特殊处理：若解析后整串恰为某个 stepN 路径的值，则返回该值的**原类型**
      （避免 "123" 字符串与数字 123 比较失败）
    - 非字符串（dict/list/number/bool/None）：原样返回
    """
    if not isinstance(value, str):
        return value
    # 不含任何占位 → 原样
    if "{{" not in value and "{step" not in value:
        return value
    resolved = resolve(value, ctx)
    # 若整个 value 就是一个 {stepN.path} 占位，尝试取原类型
    m = re.fullmatch(r"\{(step\w+(?:\.[a-zA-Z0-9_]+)+)\}", value.strip())
    if m:
        key = m.group(1)
        cur = ctx
        for p in key.split("."):
            if isinstance(cur, dict):
                cur = cur.get(p)
            else:
                cur = None
                break
        if cur is not None:
            return cur
    return resolved


def resolve_body(body, ctx: dict):
    """递归 resolve body 中所有字符串值（BUG-002）。

    - dict / list → 递归
    - str → 过 resolve()
    - 其他 → 原样
    返回新的结构（不修改入参）。
    """
    if isinstance(body, dict):
        return {k: resolve_body(v, ctx) for k, v in body.items()}
    if isinstance(body, list):
        return [resolve_body(v, ctx) for v in body]
    if isinstance(body, str):
        return resolve(body, ctx)
    return body


def get_json_path(data, path: str):
    """dot-notation JSON path，支持任意位置的数组下标（BUG-003）。

    示例:
      $.data.id            → data["data"]["id"]
      .data.items[0].name  → data["data"]["items"][0]["name"]
      [0].name             → data[0]["name"]              （根是数组）
      $[0].name            → data[0]["name"]
      data.list[1].x[2]    → data["data"]["list"][1]["x"][2]
    """
    # 切成 tokens：name / [N] / name[N]
    # 先去掉 $ 前缀
    p = path.lstrip("$")
    # 用正则同时匹配 name 段和 [N] 段
    cur = data
    # 逐字符扫描，遇 . 分隔，遇 [ 开始下标直到 ]
    i = 0
    # 把 path 拆成 list of ("key", name_or_None) 和 ("idx", n)
    tokens = []
    seg = ""
    while i < len(p):
        c = p[i]
        if c == ".":
            if seg:
                tokens.append(("key", seg))
                seg = ""
            i += 1
        elif c == "[":
            if seg:
                tokens.append(("key", seg))
                seg = ""
            j = p.index("]", i)
            tokens.append(("idx", int(p[i + 1:j])))
            i = j + 1
        else:
            seg += c
            i += 1
    if seg:
        tokens.append(("key", seg))

    for typ, val in tokens:
        if typ == "key":
            if not isinstance(cur, dict):
                raise KeyError(f"cannot key '{val}' on non-dict {type(cur).__name__}")
            cur = cur[val]
        else:  # idx
            if not isinstance(cur, list):
                raise KeyError(f"cannot index [{val}] on non-list {type(cur).__name__}")
            cur = cur[val]
    return cur


def check_value(actual, op: str, value) -> tuple:
    """执行单个 check，返回 (pass: bool, note: str)"""
    if op == "eq":
        return actual == value, f"expected {value!r} got {actual!r}"
    if op == "ne":
        return actual != value, f"should not equal {value!r}"
    if op == "contains":
        ok = value in str(actual)
        return ok, (f"found '{value}'" if ok else f"'{value}' not in '{actual}'")
    if op == "regex":
        # search 语义（非 match）：在 actual 任意位置查找 pattern
        # contains op 负责字面量子串，regex op 负责「搜索」— 如 SSE _raw 中
        # messageId 字段在事件流中间，re.match（仅串首）会假阴性
        ok = bool(re.search(value, str(actual)))
        return ok, (f"matched /{value}/" if ok else f"'{actual}' !~ /{value}/")
    if op == "exists":
        return actual is not None, f"path not found"
    if op in ("gt", "gte", "lt", "lte"):
        try:
            a, v = float(actual), float(value)
            if op == "gt": return a > v, f"{a} not > {v}"
            if op == "gte": return a >= v, f"{a} not >= {v}"
            if op == "lt": return a < v, f"{a} not < {v}"
            if op == "lte": return a <= v, f"{a} not <= {v}"
        except (ValueError, TypeError):
            return False, f"cannot compare {actual!r} {op} {value!r}"
    if op == "in":
        return actual in value, f"{actual!r} not in {value!r}"
    return False, f"unknown op {op}"


def do_request(req: dict, ctx: dict) -> tuple:
    """执行 HTTP 请求，返回 (status_code, response_body_text, response_json)"""
    method = req["method"]
    url = resolve(req["url"], ctx)

    # UPLOAD_ZIP: 构造 zip 并 multipart 上传
    if method == "UPLOAD_ZIP":
        import tempfile, zipfile
        tmpd = tempfile.mkdtemp()
        zip_path = os.path.join(tmpd, "upload.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fname, fcontent in req.get("zip_files", {}).items():
                zf.writestr(fname, fcontent)
        curl_cmd = ["curl", "-sS", "-w", "\n%{http_code}", "-X", "POST", url,
                    "-F", f"file=@{zip_path}"]
        result = subprocess.run(curl_cmd, capture_output=True, text=True)
        shutil.rmtree(tmpd, ignore_errors=True)

    # UPLOAD_RAW: 非 zip 内容上传
    elif method == "UPLOAD_RAW":
        ct = req.get("content_type", "text/plain")
        raw_body = req.get("body", "")
        curl_cmd = ["curl", "-sS", "-w", "\n%{http_code}", "-X", "POST", url,
                    "-H", f"Content-Type: {ct}", "-d", raw_body]
        result = subprocess.run(curl_cmd, capture_output=True, text=True)

    # UPLOAD_FILE: 将 body 写入临时文件后 multipart 上传（适用于 .jsonl 等格式）
    elif method == "UPLOAD_FILE":
        import tempfile
        file_name = req.get("file_name", "upload.jsonl")
        raw_body = req.get("body", "")
        tmpd = tempfile.mkdtemp()
        fpath = os.path.join(tmpd, file_name)
        with open(fpath, "w") as f:
            f.write(raw_body)
        curl_cmd = ["curl", "-sS", "-w", "\n%{http_code}", "-X", "POST", url,
                    "-F", f"file=@{fpath}"]
        result = subprocess.run(curl_cmd, capture_output=True, text=True)
        shutil.rmtree(tmpd, ignore_errors=True)

    else:
        headers = req.get("headers", {})
        # BUG-002: body 内的字符串值（含 {{env:VAR}} / {stepN.path}）必须 resolve
        body = resolve_body(req.get("body"), ctx) if req.get("body") is not None else None
        body_str = json.dumps(body, ensure_ascii=False) if body else None
        curl_cmd = ["curl", "-sS", "-w", "\n%{http_code}", "-X", method, url]
        for k, v in headers.items():
            curl_cmd += ["-H", f"{k}: {v}"]
        if body_str:
            curl_cmd += ["-d", body_str]
        result = subprocess.run(curl_cmd, capture_output=True, text=True)

    output = result.stdout.strip()
    lines = output.rsplit("\n", 1)
    if len(lines) == 2:
        resp_body, status = lines
    else:
        resp_body, status = "", lines[0]

    try:
        resp_json = json.loads(resp_body) if resp_body else {}
    except json.JSONDecodeError:
        resp_json = {"_raw": resp_body}

    return int(status), resp_body, resp_json


def do_file_check(url_template: str, ctx: dict) -> tuple:
    """检查文件是否存在，返回 (0=存在, content, parsed_json)"""
    path = resolve(url_template, ctx)
    if not os.path.exists(path):
        return 1, "", {}
    with open(path) as f:
        content = f.read()
    try:
        return 0, content, json.loads(content)
    except json.JSONDecodeError:
        return 0, content, {"_content": content}


def main():
    cp_path = sys.argv[1]
    case_dir = os.path.dirname(os.path.abspath(cp_path))
    with open(cp_path) as f:
        cp = json.load(f)

    ctx = {}  # 跨 step 共享变量: step{N}.path
    all_pass = True
    step_results = []

    for step in cp["steps"]:
        sid = step["id"]
        desc = step["description"]
        req = step["request"]
        expect = step["expect"]
        method = req["method"]
        print(f"\n--- Step {sid}: {desc} ---")

        if method == "CHECK_FILE":
            status, body_text, body_json = do_file_check(req["url"], ctx)
        else:
            status, body_text, body_json = do_request(req, ctx)

        # 保存上下文变量（嵌套存储：ctx["step1"]["data"]["id"]）
        ctx[f"step{sid}"] = body_json
        ctx[f"step{sid}._body"] = body_text

        # 保存响应
        resp_file = os.path.join(case_dir, f"response-step{sid}.json")
        with open(resp_file, "w") as f:
            f.write(body_text)

        step_pass = True

        # 检查状态码/文件存在
        expected_status = expect.get("status", 200)
        if expected_status != "any":
            ok = (status == expected_status)
            tag = "PASS" if ok else "FAIL"
            print(f"  [{tag}] status {status} (expected {expected_status})")
            if not ok:
                step_pass = False
                if method == "CHECK_FILE":
                    print(f"  [INFO] file not found: {resolve(req['url'], ctx)}")

        # 执行 checks
        if step_pass or expected_status == "any":
            for c in expect.get("checks", []):
                try:
                    actual = get_json_path(body_json, c["path"])
                except (KeyError, IndexError, TypeError):
                    actual = None
                # BUG-002: check.value 内的占位也需 resolve（如 {step3.data.id}）
                expected_value = resolve_value(c["value"], ctx)
                ok, note = check_value(actual, c["op"], expected_value)
                tag = "PASS" if ok else "FAIL"
                # 显示用 expected_value（已 resolve），便于调试时看到真实比较值
                display = expected_value if expected_value != c["value"] else c["value"]
                print(f"  [{tag}] {c['path']} {c['op']} {display!r} — {note}")
                if not ok:
                    step_pass = False

        step["result"] = "pass" if step_pass else "fail"
        step["desc"] = "all checks passed" if step_pass else "some checks failed"
        if not step_pass:
            all_pass = False

    # 写回 checkpoint（含结果）
    cp["_last_result"] = "pass" if all_pass else "fail"
    with open(cp_path, "w") as f:
        json.dump(cp, f, indent=2, ensure_ascii=False)

    # 写入 last_run.json
    last_run = {
        "case_id": cp["case_id"],
        "result": "pass" if all_pass else "fail",
        "steps": [{"id": s["id"], "result": s["result"], "desc": s["desc"]} for s in cp["steps"]]
    }
    with open(os.path.join(case_dir, "last_run.json"), "w") as f:
        json.dump(last_run, f, indent=2, ensure_ascii=False)

    print(f"\n=== {cp['case_id']}: {'PASS' if all_pass else 'FAIL'} ===\n")
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
