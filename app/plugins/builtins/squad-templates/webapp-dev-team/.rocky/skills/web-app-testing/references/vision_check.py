"""
视觉判定脚本 — 调用视觉模型（默认 MiniMax-M3）对截图执行结构化检查 / 多图对比。

作为 ET executor 的按需工具：executor 自由心证时若需视觉辅助判定（功能截图检查
或与设计稿比对），按 CLI 接口调用本脚本，结果 JSON 供 executor 决策。

参考: specs/tech/testing/et-framework.md
      .claude/skills/playwright-cli/references/executor-workflow.md

两种模式：
  1) 单图检查（功能验收，黑盒判定单张截图的功能点）:
       python3 vision_check.py <screenshot_path> '<checks_json>'
       checks_json: [{"id":1,"check":"页面有登录按钮"}]
  2) 多图对比（高保真视觉还原验收，比对「实现」与「设计稿」是否基本一致）:
       python3 vision_check.py compare <impl_path> <design_path> '<checks_json>'
       checks_json: [{"id":1,"dimension":"font","check":"字体族与字号是否基本一致"}]
       dimension 建议取值: font / size / layout / border / color / spacing（自由扩展）
       判定口径：不要求像素级一致，但「整体风格基本一致」=PASS，「明显偏差」=FAIL。

配置优先级（env > 项目根 env.provider 文件 > 内置默认）:
  VISION_BASE_URL    —— API 根地址（默认 https://api.minimaxi.com/anthropic）
  VISION_AUTH_TOKEN  —— 鉴权 token（必填）
  VISION_MODEL       —— 模型名（默认 MiniMax-M3）
fallback env.provider 读取的 key（保留兼容）:
  ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_MODEL

输出: JSON 数组 [{"id":1,"pass":true,"note":"..."}, ...]
"""
import json, sys, os, base64, urllib.request, urllib.error, re

# 内置默认值
DEFAULTS = {
    'base_url': 'https://api.minimaxi.com/anthropic',
    'auth_token': '',
    'model': 'MiniMax-M3',
}


def load_provider_config():
    """加载视觉 API 配置：env 优先，缺失项 fallback 到项目根 env.provider 文件。"""
    config = dict(DEFAULTS)

    # 1) fallback：向上查找项目根目录的 env.provider
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root = script_dir
    for _ in range(5):
        if os.path.exists(os.path.join(root, 'package.json')):
            break
        root = os.path.dirname(root)

    env_file = os.path.join(root, 'env.provider')
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if '=' in line and not line.startswith('#'):
                    key, _, val = line.partition('=')
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key == 'ANTHROPIC_BASE_URL':
                        config['base_url'] = val
                    elif key == 'ANTHROPIC_AUTH_TOKEN':
                        config['auth_token'] = val
                    elif key == 'ANTHROPIC_DEFAULT_MODEL':
                        config['model'] = val

    # 2) env 覆盖（最高优先级）
    if os.environ.get('VISION_BASE_URL'):
        config['base_url'] = os.environ['VISION_BASE_URL']
    if os.environ.get('VISION_AUTH_TOKEN'):
        config['auth_token'] = os.environ['VISION_AUTH_TOKEN']
    if os.environ.get('VISION_MODEL'):
        config['model'] = os.environ['VISION_MODEL']

    return config


def image_to_base64(image_path):
    """读取图片文件并转为 base64，返回 (media_type, b64)。"""
    with open(image_path, 'rb') as f:
        data = f.read()
    ext = os.path.splitext(image_path)[1].lower()
    media_map = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}
    media_type = media_map.get(ext, 'image/png')
    return media_type, base64.b64encode(data).decode('utf-8')


def _image_block(image_path):
    """构造单个 image content block。"""
    media_type, b64 = image_to_base64(image_path)
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': media_type, 'data': b64}}


def call_vision_api(content_blocks):
    """调用视觉 API。content_blocks 为 messages[0].content 列表（可含多图 + 文本）。"""
    config = load_provider_config()
    if not config['auth_token']:
        raise RuntimeError('未配置 VISION_AUTH_TOKEN，且项目根 env.provider 中未找到 ANTHROPIC_AUTH_TOKEN')

    endpoint = f"{config['base_url'].rstrip('/')}/v1/messages"
    body = {
        'model': config['model'],
        'max_tokens': 2048,
        'messages': [{'role': 'user', 'content': content_blocks}],
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f"Bearer {config['auth_token']}",
            'anthropic-version': '2023-06-01',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(f"API 错误 ({e.code}): {error_body}")

    text_parts = [b['text'] for b in result.get('content', []) if b.get('type') == 'text' and b.get('text')]
    return '\n'.join(text_parts)


def _extract_results_regex(response, checks):
    """容错兜底：从 JSON 文本按出现顺序提取 {"id","pass","note"} 三元组。

    处理 note 内含未转义引号导致整体 JSON 解析失败的情况——只取首个 "pass": 值，
    note 取 "pass" 后到下一个 ,"id" 或 } 之间的片段（best effort）。
    """
    results = []
    # 找到所有 "id":N 和 "pass":BOOL 对（按位置）
    id_matches = list(re.finditer(r'"id"\s*:\s*(\d+)', response))
    pass_matches = list(re.finditer(r'"pass"\s*:\s*(true|false)', response, re.IGNORECASE))
    if not pass_matches:
        return []
    # 按 "pass" 出现位置为主轴，每个 pass 配对最近的「前面的 id」
    ids_used = 0
    for pm in pass_matches:
        # 找该 pass 之前最近的 id
        preceding_ids = [im for im in id_matches if im.start() < pm.start()]
        rid = int(preceding_ids[-1].group(1)) if preceding_ids else (len(results) + 1)
        passed = pm.group(1).lower() == 'true'
        # note：取 pass 值之后到下一个 ,"id" 或 下一个 } 之间
        after = response[pm.end():]
        # 截到下一个对象开始（,"id"）或闭合 }
        nxt = re.search(r'\}\s*,|\}$|\}\s*,\s*\{', after)
        note_seg = after[:nxt.start()] if nxt else after
        # 去掉前导逗号 + "note":"..." 提取
        nm = re.search(r'"note"\s*:\s*"?(.*?)"?\s*(?:,\s*"|$)', note_seg, re.DOTALL)
        note = nm.group(1).strip().strip('"') if nm else note_seg.lstrip(' ,').strip().strip('"')
        results.append({"id": rid, "pass": passed, "note": note[:300]})
    return results


def _parse_results(response, checks):
    """从模型回复中解析 JSON 数组，容错处理 markdown / 截断 / note 内未转义引号。"""
    response = response.strip()
    if response.startswith('```'):
        response = '\n'.join(response.split('\n')[1:-1])
    try:
        results = json.loads(response)
    except json.JSONDecodeError:
        match = re.search(r'\[.*\]', response, re.DOTALL)
        results = None
        if match:
            try:
                results = json.loads(match.group())
            except json.JSONDecodeError:
                results = []
                for m in re.finditer(r'\{[^{}]*\}', response[response.index('['):]):
                    try:
                        results.append(json.loads(m.group()))
                    except Exception:
                        pass
        if not results:
            # 终极兜底：regex 提取 id/pass/note（容 note 内未转义引号）
            results = _extract_results_regex(response, checks)
        if not results:
            return [{"id": c.get("id", i + 1), "pass": False,
                     "note": f"vision JSON parse failed: {response[:120]}"} for i, c in enumerate(checks)]
    for i, r in enumerate(results):
        if 'id' not in r:
            r['id'] = i + 1
    return results


def run_checks(image_path, checks):
    """单图功能检查：对一张截图执行一组检查。"""
    items_text = '\n'.join(f'  {i+1}. {c.get("check", c.get("id", "?"))}' for i, c in enumerate(checks))
    prompt = (
        "Check these items on the screenshot, respond ONLY with a JSON array. No other text.\n"
        f"Items:\n{items_text}\n\n"
        'Format: [{"id":1,"pass":true,"note":"..."},{"id":2,"pass":false,"note":"..."}]'
    )
    response = call_vision_api([{'type': 'text', 'text': prompt}, _image_block(image_path)])
    return _parse_results(response, checks)


def run_compare(impl_path, design_path, checks):
    """多图对比：判定「实现截图」与「设计稿截图」在各维度是否基本一致。

    第一张图 = 设计稿(DESIGN/目标)；第二张图 = 实现(IMPL/实际)。
    """
    items_text = '\n'.join(
        f'  {i+1}. [{c.get("dimension","general")}] {c.get("check","?")}'
        for i, c in enumerate(checks)
    )
    prompt = (
        "你是 UI 视觉还原审查员。下面有两张【同尺寸·同比例】渲染的截图：\n"
        "  图A = 设计稿（DESIGN，目标，权威源）\n"
        "  图B = 实现（IMPL，实际产品）\n"
        "对每个检查项你必须：\n"
        "  1) 分别从图A、图B【提取该属性的具体值】——结构（几栏/元素位置）、像素尺寸（宽高/padding/圆角）、"
        "色值（hex）、字号字重，尽量给具体数字；\n"
        "  2) 比对二者：pass=true 仅当该属性基本相同；pass=false 当有明显差。\n"
        "  3) note 必须写明【设计稿值】vs【实现值】的具体差异（如「圆角 设计8px / 实现4px」「选中边框 设计#d97757 / 实现灰色」），"
        "**禁止用「整体风格」「质感」「看上去」等模糊词**，只报可量化、可定位的具体属性。\n"
        "前提：两图已同比例同尺寸渲染，因此尺寸/间距的差就是真实差，不是缩放伪影。\n"
        f"检查项（dimension 标注关注维度）:\n{items_text}\n\n"
        "仅输出 JSON 数组，不要其他文字。\n"
        'Format: [{"id":1,"pass":false,"note":"圆角 设计8px / 实现4px"},{"id":2,"pass":true,"note":"主色 设计#d97757 / 实现#d97757 一致"}]'
    )
    content = [
        {'type': 'text', 'text': '【图A — 设计稿 DESIGN（目标）】'},
        _image_block(design_path),
        {'type': 'text', 'text': '【图B — 实现 IMPL（实际）】'},
        _image_block(impl_path),
        {'type': 'text', 'text': prompt},
    ]
    response = call_vision_api(content)
    return _parse_results(response, checks)


def _usage():
    print('用法:')
    print('  单图检查: python vision_check.py <screenshot_path> [checks_json]')
    print('  多图对比: python vision_check.py compare <impl_path> <design_path> <checks_json>')
    print('env: VISION_BASE_URL / VISION_AUTH_TOKEN(必填) / VISION_MODEL')


def main():
    if len(sys.argv) < 2:
        _usage()
        sys.exit(1)

    # —— 多图对比模式 ——
    if sys.argv[1] == 'compare':
        if len(sys.argv) < 5:
            _usage()
            sys.exit(1)
        impl_path, design_path, checks_json = sys.argv[2], sys.argv[3], sys.argv[4]
        checks = json.loads(checks_json)
        try:
            results = run_compare(impl_path, design_path, checks)
        except Exception as e:
            results = [{"id": c.get("id", i + 1), "pass": False, "note": f"vision_compare error: {e}"}
                       for i, c in enumerate(checks)]
        print(json.dumps(results, ensure_ascii=False, indent=2))
        sys.exit(0 if all(r.get('pass', False) for r in results) else 1)

    # —— 单图模式 ——
    image_path = sys.argv[1]
    if len(sys.argv) >= 3:
        checks = json.loads(sys.argv[2])
        try:
            results = run_checks(image_path, checks)
        except Exception as e:
            results = [{"id": c.get("id", i + 1), "pass": False, "note": f"vision_check error: {e}"}
                       for i, c in enumerate(checks)]
        print(json.dumps(results, ensure_ascii=False, indent=2))
        sys.exit(0 if all(r.get('pass', False) for r in results) else 1)
    else:
        try:
            desc = call_vision_api([
                {'type': 'text', 'text': '描述这张截图的内容，包括布局、文字、按钮等元素。'},
                _image_block(image_path),
            ])
            print(desc)
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()
