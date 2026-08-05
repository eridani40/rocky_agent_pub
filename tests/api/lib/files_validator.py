"""
files 原语 schema 校验：case_loader 加载期校验 files 字段的安全性约束。
参考：design_case_schema.md files 原语；从 case_loader.py 提取（v0.0.125 机械拆分）
硬约束：
  - files 必须是 list
  - 每项含 path（非空相对字符串）+ content
  - content 默认须为 dict（序列化为 JSON 文本写入）；
    item 显式 encoding: base64 时 content 须为非空 base64 字符串（解码为原始二进制字节写入，
    比照 multipart file 字段既有 `encoding: base64` 约定 [v0.0.141 D2 扩展，供二进制 fixture
    如图片写盘用]）
  - 拒绝绝对路径、拒绝 ../ 逃逸
不变量：安全约束（绝对路径/../ 逃逸）与原 case_loader.py 完全一致；content 校验按 encoding 分支。
"""
import os

from case_loader import CaseLoadError


def validate_files(cfg, loc: str) -> None:
    """
    校验 files 原语：
    - 必须是列表
    - 每项含 path（非空字符串）
    - path 必须是相对路径且不含 ../ 逃逸（安全约束）
    - content 校验按 encoding 分支：
      - 未设 encoding（默认）：content 必须是 dict（序列化为 JSON 写入）
      - encoding: base64：content 必须是非空 base64 字符串（解码为原始字节写入，支持二进制 fixture）
      - encoding 出现但值非 "base64"：拒载（当前唯一支持值）
    """
    if not isinstance(cfg, list):
        raise CaseLoadError(f'{loc}: files must be a list')
    for idx, item in enumerate(cfg):
        if not isinstance(item, dict):
            raise CaseLoadError(f'{loc}: files[{idx}] must be a mapping')
        path = item.get('path')
        if not isinstance(path, str) or not path:
            raise CaseLoadError(f'{loc}: files[{idx}].path is required and must be non-empty string')
        # 安全约束：拒绝绝对路径
        if os.path.isabs(path):
            raise CaseLoadError(
                f'{loc}: files[{idx}].path must be relative (got absolute path: {path!r})'
            )
        # 安全约束：拒绝 ../ 逃逸（规范化后解析出 DATA_DIR 外）
        normalized = os.path.normpath(path)
        if normalized.startswith('..'):
            raise CaseLoadError(
                f'{loc}: files[{idx}].path escapes DATA_DIR via ../: {path!r}'
            )
        encoding = item.get('encoding')
        content = item.get('content')
        if encoding is None:
            if not isinstance(content, dict):
                raise CaseLoadError(
                    f'{loc}: files[{idx}].content must be a dict (JSON object)'
                )
        elif encoding == 'base64':
            if not isinstance(content, str) or not content:
                raise CaseLoadError(
                    f'{loc}: files[{idx}].content must be a non-empty base64 string when encoding=base64'
                )
        else:
            raise CaseLoadError(
                f'{loc}: files[{idx}].encoding must be "base64" if present (got {encoding!r})'
            )
