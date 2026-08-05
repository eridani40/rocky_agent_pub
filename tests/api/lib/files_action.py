"""
files 原语执行：写入 DATA_DIR/<path>，case 结束由 run_case.py 清理
参考：AT DSL files 原语设计；安全约束见 case_loader._validate_files
二进制扩展（[v0.0.141] D2）：item 显式 encoding: base64 时按解码后的原始字节写盘
（比照 interp.py multipart 文件字段既有 encoding: base64 约定），用于图片等二进制 fixture；
默认（无 encoding）保持原行为——content 为 dict，JSON 序列化文本写入，向后兼容零影响。
"""
import base64 as _base64
import json as _json
import os

from interp import interpolate


class FilesActionError(Exception):
    """files 动作执行失败"""
    pass


def do_files(step: dict, ctx: dict) -> tuple:
    """
    files 原语：把 content 写入 DATA_DIR/<path>。
    - 默认（无 encoding）：content 须为 dict，JSON 序列化为文本写入（原行为，向后兼容）。
    - encoding: base64：content 须为 base64 字符串，解码为原始字节后二进制写入（支持任意二进制
      fixture，如 PNG 图片；load 期 files_validator 已校验形状）。
    写入路径追加到 ctx['_written_files']，供 run_case.py case 结束后清理。
    安全约束（load 期已校验）：
      - path 必须是相对路径，且规范化后不含 ../ 逃逸
      - 实际写入前再次验证解析后路径在 DATA_DIR 内（双重防护）
    返回 (main_output, extra)，与其他动作签名一致。
    """
    data_dir = os.environ.get('DATA_DIR', '')
    if not data_dir:
        raise FilesActionError('files action requires DATA_DIR environment variable')

    items = step.get('files', [])
    written = []
    for item in items:
        rel_path = interpolate(item['path'], ctx)
        encoding = item.get('encoding')

        # 安全：解析后路径必须在 DATA_DIR 内（运行时二次防护）
        abs_path = os.path.realpath(os.path.join(data_dir, rel_path))
        abs_data_dir = os.path.realpath(data_dir)
        if not abs_path.startswith(abs_data_dir + os.sep) and abs_path != abs_data_dir:
            raise FilesActionError(
                f"files: path {rel_path!r} resolves outside DATA_DIR (security violation)"
            )

        os.makedirs(os.path.dirname(abs_path) or '.', exist_ok=True)

        if encoding == 'base64':
            b64_str = interpolate(item['content'], ctx)
            raw_bytes = _base64.b64decode(b64_str)
            with open(abs_path, 'wb') as f:
                f.write(raw_bytes)
        else:
            content = interpolate(item['content'], ctx)
            text = _json.dumps(content, ensure_ascii=False, indent=2)
            with open(abs_path, 'w', encoding='utf-8') as f:
                f.write(text)
        written.append(abs_path)

    # 追加到 ctx 以供 case 结束清理（run_case.py _cleanup_written_files）
    if '_written_files' not in ctx:
        ctx['_written_files'] = []
    ctx['_written_files'].extend(written)

    return {'written': written}, {'written_count': len(written), 'paths': written}


def cleanup_written_files(ctx: dict) -> list:
    """
    清理 files 原语写入的文件（case 自管环境）。
    从 ctx['_written_files'] 读取路径列表，逐一删除。
    清理在 teardown 完成后执行（含 fail 路径），保证 case 自管。
    返回已删除文件列表（供 result 记录）。
    """
    written = ctx.get('_written_files', [])
    deleted = []
    for path in written:
        try:
            if os.path.isfile(path):
                os.remove(path)
                deleted.append(path)
        except OSError:
            pass  # 已删除或权限问题，忽略
    return deleted
