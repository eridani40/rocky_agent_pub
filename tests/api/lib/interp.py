"""
插值与 HTTP 原语
参考：design_case_schema.md §3.1/§6；change_plan B 组 interp.py
save 提取逻辑实际在 step_exec._apply_save（承接 change_plan 开放点）

multipart 支持：http_request 接受 multipart 参数，用标准库手工编码
multipart/form-data。文件字段值为 dict {filename, content, content_type,
encoding?}；文本字段值为字符串。有 multipart 时忽略 body 参数。
"""
import re
import json
import uuid
import urllib.request
import urllib.error
import os
from typing import Any


def get_base_url() -> str:
    """BASE_URL 单一展开权威：环境变量 BASE_URL 或按 SERVER_PORT 拼。"""
    url = os.environ.get('BASE_URL', '')
    if url:
        return url.rstrip('/')
    port = os.environ.get('SERVER_PORT', '3000')
    return f'http://127.0.0.1:{port}'


#: 变量名语法（大小写字母/数字/下划线）。case_loader.py 的 load 期静态校验
#: （_check_interp_refs）须与此保持同一语法，否则大写变量名会绕过 load 期未定义检查
#: 且运行期静默不插值（历史 bug：曾只认小写，{sidA} 这类变量名不匹配、原样保留字面量，
#: selector/url 变字面量导致隐蔽假 fail）。
_VAR_RE = re.compile(r'\{([a-zA-Z0-9_]+)\}')


class InterpolationError(Exception):
    """
    插值后仍残留未定义变量占位符（dom selector / http url 等『残留必错』场景专用）。
    这类位置一旦插值失败必须 fail-loud，绝不能静默把 "{var}" 当字面量继续走
    （会制造隐蔽假 fail：selector 找不到元素 / url 404，报错信息与真实原因（变量未定义）脱节）。
    """
    pass


def interpolate(val: Any, ctx: dict) -> Any:
    """
    递归将 {var} 占位符替换为 ctx 中的值。
    支持字符串值与嵌套对象/列表。
    未定义变量在 load 期已拒载；运行期未找到则保留原样（宽松场景，如 JSON body 模板
    允许保留字面量 {…}）。dom selector / http url 等『残留必错』场景请用 interpolate_strict。
    """
    if isinstance(val, str):
        def replace(m: re.Match) -> str:
            key = m.group(1)
            v = ctx.get(key)
            return str(v) if v is not None else m.group(0)
        return _VAR_RE.sub(replace, val)
    if isinstance(val, dict):
        return {k: interpolate(v, ctx) for k, v in val.items()}
    if isinstance(val, list):
        return [interpolate(item, ctx) for item in val]
    return val


def interpolate_strict(val: Any, ctx: dict, label: str) -> Any:
    """
    『残留必错』插值：适用于 http url / dom selector / SSE 订阅 topic-group 等
    路由类定位信息——插值后若仍残留未在 ctx 中定义的 {var} 占位符，
    fail-loud 抛 InterpolationError，而非静默保留字面量继续执行。
    不适用于 JSON body 等允许字面量 {…} 的模板场景（用普通 interpolate）。
    """
    result = interpolate(val, ctx)
    _assert_no_residual(result, ctx, label)
    return result


def _assert_no_residual(val: Any, ctx: dict, label: str) -> None:
    if isinstance(val, str):
        for m in _VAR_RE.finditer(val):
            if m.group(1) not in ctx:
                raise InterpolationError(
                    f"{label}: 插值后仍残留未定义变量 '{{{m.group(1)}}}' (value={val!r}); "
                    f"已知变量: {sorted(ctx.keys())}"
                )
    elif isinstance(val, dict):
        for v in val.values():
            _assert_no_residual(v, ctx, label)
    elif isinstance(val, list):
        for item in val:
            _assert_no_residual(item, ctx, label)


def http_request(method: str, path: str, body: Any, ctx: dict,
                 multipart: Any = None, timeout: int = 30) -> dict:
    """
    HTTP 原语：拼 BASE_URL + 插值 + 返回 {status, body}。
    BASE_URL 从环境变量 BASE_URL 或 SERVER_PORT 获取。

    multipart 参数（dict）：编码为 multipart/form-data，忽略 body 参数。
    字段值为字符串时作为文本字段；
    为 dict {filename, content, content_type, encoding?} 时作为文件字段。
    encoding="base64" 时 content 先 base64 解码再发送，否则 UTF-8 编码。

    timeout 参数（秒，默认 30，同旧硬编码值）：单次 urlopen 超时。
    v0.0.151 起可由 requests 步骤的可选 `timeout` 字段透传（step_exec._do_requests），
    真 LLM 长同步调用（如 test-only 整理端点）可能 >30s 需显式声明更长值。
    """
    base = get_base_url()

    # http url『残留必错』：插值后仍留 {var} 占位符会拼出错误 URL（多半 404/routing 到别的
    # case），而错误信息只会是"status 404"看不出插值失败，fail-loud 直接暴露根因
    path = interpolate_strict(path, ctx, 'http url path')
    url = base + path

    if multipart is not None:
        multipart_interp = interpolate(multipart, ctx)
        data, content_type_header = _encode_multipart(multipart_interp)
        headers = {'Content-Type': content_type_header}
    else:
        data = None
        headers = {'Content-Type': 'application/json'}
        if body is not None:
            body_interp = interpolate(body, ctx)
            data = json.dumps(body_interp).encode('utf-8')

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            raw = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()

    try:
        resp_body = json.loads(raw) if raw else None
    except Exception:
        resp_body = raw.decode('utf-8', errors='replace') if raw else None

    return {'status': status, 'body': resp_body}


def _encode_multipart(fields: dict) -> tuple:
    """
    将 fields dict 编码为 multipart/form-data 字节串。
    返回 (body_bytes, content_type_header_value)。
    boundary 使用 UUID4 保证唯一性。
    """
    import base64 as _b64
    boundary = uuid.uuid4().hex
    parts = []

    for field_name, field_val in fields.items():
        if isinstance(field_val, dict):
            # 文件字段
            filename = field_val.get('filename', field_name)
            content_type = field_val.get('content_type', 'application/octet-stream')
            raw_content = field_val.get('content', '')
            encoding = field_val.get('encoding', '')

            if encoding == 'base64':
                file_bytes = _b64.b64decode(raw_content)
            else:
                file_bytes = raw_content.encode('utf-8') if isinstance(raw_content, str) else raw_content

            header = (
                f'--{boundary}\r\n'
                f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
                f'Content-Type: {content_type}\r\n'
                f'\r\n'
            ).encode('utf-8')
            parts.append(header + file_bytes + b'\r\n')
        else:
            # 文本字段
            text = str(field_val)
            header = (
                f'--{boundary}\r\n'
                f'Content-Disposition: form-data; name="{field_name}"\r\n'
                f'\r\n'
            ).encode('utf-8')
            parts.append(header + text.encode('utf-8') + b'\r\n')

    terminator = f'--{boundary}--\r\n'.encode('utf-8')
    body = b''.join(parts) + terminator
    content_type_header = f'multipart/form-data; boundary={boundary}'
    return body, content_type_header
