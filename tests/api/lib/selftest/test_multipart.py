"""
§7 multipart/form-data 编码测试
被 run_selftest.py 导入调用，不独立运行
"""
import sys
import os
import re
import base64

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def test_multipart_encoding(ok):
    """测试 interp._encode_multipart 的编码正确性"""
    print('\n§7 multipart/form-data 编码:')
    from interp import _encode_multipart

    # ── 基础：纯文本字段 ──
    body, ct = _encode_multipart({'name': 'hello', 'version': '1.0'})
    boundary = ct.split('boundary=')[1]
    body_str = body.decode('utf-8')

    ok('content-type prefix', ct.startswith('multipart/form-data; boundary='))
    ok('boundary in body (open)', f'--{boundary}\r\n' in body_str)
    ok('boundary terminator', f'--{boundary}--\r\n' in body_str)
    ok('name field header', 'Content-Disposition: form-data; name="name"' in body_str)
    ok('name field value', 'hello' in body_str)
    ok('version field value', '1.0' in body_str)

    # ── 文件字段（文本内容，默认 encoding）──
    fields_file = {
        'file': {
            'filename': 'skill.zip',
            'content': 'fake-zip-content',
            'content_type': 'application/zip',
        },
        'name': 'my_skill',
    }
    body2, ct2 = _encode_multipart(fields_file)
    boundary2 = ct2.split('boundary=')[1]
    body2_str = body2.decode('utf-8')

    ok('file: content-type header present',
       'Content-Type: application/zip' in body2_str)
    ok('file: filename in disposition',
       'filename="skill.zip"' in body2_str)
    ok('file: content present', 'fake-zip-content' in body2_str)
    ok('file: text field also present', 'my_skill' in body2_str)

    # boundary 只含十六进制字符（UUID hex）
    ok('boundary hex chars only', re.fullmatch(r'[0-9a-f]{32}', boundary2) is not None)

    # ── base64 encoding：文件内容先解码 ──
    raw_bytes = b'\x00\x01\x02\x03\xff'
    b64_str = base64.b64encode(raw_bytes).decode('ascii')
    fields_b64 = {
        'file': {
            'filename': 'data.bin',
            'content': b64_str,
            'content_type': 'application/octet-stream',
            'encoding': 'base64',
        }
    }
    body3, ct3 = _encode_multipart(fields_b64)
    # 找到文件内容段：首个 \r\n\r\n 后为文件字节起点
    boundary3 = ct3.split('boundary=')[1]
    header_end = body3.index(b'\r\n\r\n') + 4
    # 文件字节段止于 \r\n-- 前
    file_end = body3.index(b'\r\n--' + boundary3.encode('ascii'))
    extracted = body3[header_end:file_end]
    ok('base64 decoded bytes match', extracted == raw_bytes)

    # ── 每个 boundary 唯一（两次调用不同）──
    _, ct_a = _encode_multipart({'x': 'a'})
    _, ct_b = _encode_multipart({'x': 'b'})
    ok('boundary unique across calls',
       ct_a.split('boundary=')[1] != ct_b.split('boundary=')[1])

    # ── 空字段 dict ──
    body_empty, ct_empty = _encode_multipart({})
    b_empty = ct_empty.split('boundary=')[1]
    ok('empty fields: only terminator',
       body_empty == f'--{b_empty}--\r\n'.encode('utf-8'))
