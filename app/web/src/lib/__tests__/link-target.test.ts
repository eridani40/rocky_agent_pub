// @vitest-environment jsdom
/**
 * link-target 单测 — markdown 链接点击分发（v0.0.253）
 * 参考: app/web/src/lib/link-target.ts
 *       specs/prd/version_logs/v0.0.253.md §3.2（分发逻辑表）
 *
 * 覆盖：
 *   - isDangerousScheme：javascript:/vbscript:/data: 三协议 + 大小写 + 前导空白
 *   - classifyLinkTarget：web / local / dangerous 三态
 *   - toChatLinkTarget：source（absolute/workspace）+ fileName
 *   - isBuiltinEditable（file-format.ts 权威复用）：12 格式 + .env basename + 非 12 格式
 *   - openLinkTarget：各分支调对应 mock（window.rockyShell.openExternal/openPath + onLocalViewer 回调）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isBuiltinEditable } from '../file-format';
import {
  isDangerousScheme,
  isDangerousImageScheme,
  classifyLinkTarget,
  toChatLinkTarget,
  openLinkTarget,
} from '../link-target';

/** 造 window.rockyShell mock */
function mockRockyShell() {
  const api = {
    openExternal: vi.fn(async () => ({ ok: true })),
    openPath: vi.fn(async () => ({ ok: true })),
    readFileText: vi.fn(async () => ({ ok: true, content: '' })),
    // [v0.0.339] 文本分流 stat：小文件(100B) → 内置 editor（openLocalPath ④ 分支异步 getSize）
    stat: vi.fn(async () => ({ ok: true, size: 100 })),
  };
  // jsdom window
  (window as unknown as { rockyShell: unknown }).rockyShell = api;
  return api;
}

beforeEach(() => mockRockyShell());
afterEach(() => {
  delete (window as unknown as { rockyShell?: unknown }).rockyShell;
});

/** 冲刷微任务（[v0.0.339] openLocalPath 文本分支异步 getSize → onEditor 在微任务后触发） */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('isDangerousScheme', () => {
  it('javascript: 拦截', () => {
    expect(isDangerousScheme('javascript:alert(1)')).toBe(true);
  });
  it('vbscript: 拦截', () => {
    expect(isDangerousScheme('vbscript:foo')).toBe(true);
  });
  it('data: 拦截', () => {
    expect(isDangerousScheme('data:text/html,<script>')).toBe(true);
  });
  it('大小写不敏感', () => {
    expect(isDangerousScheme('JAVASCRIPT:alert(1)')).toBe(true);
    expect(isDangerousScheme('Data:x')).toBe(true);
  });
  it('前导空白容忍', () => {
    expect(isDangerousScheme('  javascript:alert(1)')).toBe(true);
    expect(isDangerousScheme('\tdata:x')).toBe(true);
  });
  it('合法 http/https/file/mailto 不拦', () => {
    expect(isDangerousScheme('http://x.com')).toBe(false);
    expect(isDangerousScheme('https://x.com')).toBe(false);
    expect(isDangerousScheme('file:///abs/path')).toBe(false);
    expect(isDangerousScheme('mailto:a@b.com')).toBe(false);
  });
});

describe('isDangerousImageScheme（v0.0.286 图片专用白名单）', () => {
  it('javascript: 拦截', () => {
    expect(isDangerousImageScheme('javascript:alert(1)')).toBe(true);
  });
  it('vbscript: 拦截', () => {
    expect(isDangerousImageScheme('vbscript:foo')).toBe(true);
  });
  it('data:image/ 放行（base64 内联图片白名单）', () => {
    expect(isDangerousImageScheme('data:image/png;base64,iVBOR...')).toBe(false);
    expect(isDangerousImageScheme('data:image/svg+xml,<svg/>')).toBe(false);
    expect(isDangerousImageScheme('data:image/jpeg;base64,/9j/')).toBe(false);
  });
  it('data: 非 image 拦截（text/html / text/plain 等）', () => {
    expect(isDangerousImageScheme('data:text/html,<script>')).toBe(true);
    expect(isDangerousImageScheme('data:text/plain,hello')).toBe(true);
  });
  it('大小写不敏感', () => {
    expect(isDangerousImageScheme('JAVASCRIPT:x')).toBe(true);
    expect(isDangerousImageScheme('Data:text/html,x')).toBe(true);
    expect(isDangerousImageScheme('DATA:IMAGE/PNG;base64,x')).toBe(false);
  });
  it('前导空白容忍', () => {
    expect(isDangerousImageScheme('  javascript:alert(1)')).toBe(true);
    expect(isDangerousImageScheme('\tdata:text/html,x')).toBe(true);
    expect(isDangerousImageScheme('  data:image/png;base64,x')).toBe(false);
  });
  it('合法 http/https/绝对路径不拦', () => {
    expect(isDangerousImageScheme('http://x.com/a.png')).toBe(false);
    expect(isDangerousImageScheme('https://x.com/b.jpg')).toBe(false);
    expect(isDangerousImageScheme('/abs/path/c.gif')).toBe(false);
    expect(isDangerousImageScheme('~/img/d.png')).toBe(false);
  });
});

describe('classifyLinkTarget', () => {
  it('http/https/mailto/ftp → web', () => {
    expect(classifyLinkTarget('http://x.com')).toBe('web');
    expect(classifyLinkTarget('https://x.com')).toBe('web');
    expect(classifyLinkTarget('mailto:a@b.com')).toBe('web');
    expect(classifyLinkTarget('ftp://host/x')).toBe('web');
  });
  it('javascript/vbscript/data → dangerous（顺序优先于 web scheme）', () => {
    expect(classifyLinkTarget('javascript:alert(1)')).toBe('dangerous');
    expect(classifyLinkTarget('data:text/html,x')).toBe('dangerous');
  });
  it('file:// / 绝对路径 / ~ / 相对路径 → local', () => {
    expect(classifyLinkTarget('file:///abs/file.md')).toBe('local');
    expect(classifyLinkTarget('/var/log/app.log')).toBe('local');
    expect(classifyLinkTarget('~/logs/x.log')).toBe('local');
    expect(classifyLinkTarget('config.yaml')).toBe('local');
    expect(classifyLinkTarget('./notes.md')).toBe('local');
  });
});

describe('toChatLinkTarget', () => {
  it('file:// → source=absolute', () => {
    const t = toChatLinkTarget('file:///var/log/app.log');
    expect(t.source).toBe('absolute');
    expect(t.fileName).toBe('app.log');
    expect(t.path).toBe('file:///var/log/app.log');
  });
  it('/abs → source=absolute', () => {
    const t = toChatLinkTarget('/abs/path/notes.md');
    expect(t.source).toBe('absolute');
    expect(t.fileName).toBe('notes.md');
  });
  it('~ → source=absolute', () => {
    const t = toChatLinkTarget('~/dir/file.md');
    expect(t.source).toBe('absolute');
    expect(t.fileName).toBe('file.md');
  });
  it('workspace 相对 → source=workspace', () => {
    const t = toChatLinkTarget('config.yaml');
    expect(t.source).toBe('workspace');
    expect(t.fileName).toBe('config.yaml');
  });
  it('./relative → source=workspace', () => {
    const t = toChatLinkTarget('./subdir/x.json');
    expect(t.source).toBe('workspace');
    expect(t.fileName).toBe('x.json');
  });
  it('win 盘符 → source=absolute', () => {
    const t = toChatLinkTarget('C:\\Users\\u\\x.txt');
    expect(t.source).toBe('absolute');
    expect(t.fileName).toBe('x.txt');
  });
});

describe('isBuiltinEditable（link-target 复用 file-format 权威）', () => {
  it('12 格式命中', () => {
    for (const p of ['a.md', 'b.json', 'c.jsonl', 'd.yaml', 'e.yml', 'f.xml', 'g.toml', 'h.csv', 'i.tsv', 'j.txt', 'k.ini', 'l.log']) {
      expect(isBuiltinEditable(p)).toBe(true);
    }
  });
  it('.env / .env.local 命中（basename 整体匹配）', () => {
    expect(isBuiltinEditable('.env')).toBe(true);
    expect(isBuiltinEditable('.env.local')).toBe(true);
    expect(isBuiltinEditable('.env.production')).toBe(true);
    expect(isBuiltinEditable('subdir/.env')).toBe(true);
  });
  it('扩展名大小写不敏感', () => {
    expect(isBuiltinEditable('X.JSON')).toBe(true);
    expect(isBuiltinEditable('Y.MD')).toBe(true);
  });
  it('[v0.0.320 D11] 编程语言 → 命中（code 分类并入白名单）；图片 / pdf / 未知 → 不命中', () => {
    expect(isBuiltinEditable('a.py')).toBe(true);
    expect(isBuiltinEditable('b.js')).toBe(true);
    expect(isBuiltinEditable('c.tsx')).toBe(true);
    expect(isBuiltinEditable('d.sh')).toBe(true);
    expect(isBuiltinEditable('e.png')).toBe(false);
    expect(isBuiltinEditable('f.pdf')).toBe(false);
    expect(isBuiltinEditable('g.xlsx')).toBe(false);
    // [v0.0.328] Makefile ∈ KNOWN_TEXT_BASENAMES → 可内置编辑（txt），不再 false
    expect(isBuiltinEditable('Makefile')).toBe(true);
  });
});

describe('openLinkTarget 分发', () => {
  it('web → window.rockyShell.openExternal', () => {
    const api = mockRockyShell();
    openLinkTarget('https://example.com', {});
    expect(api.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(api.openPath).not.toHaveBeenCalled();
  });

  it('dangerous → 不调任何打开（防 XSS）', () => {
    const api = mockRockyShell();
    openLinkTarget('javascript:alert(1)', {});
    expect(api.openExternal).not.toHaveBeenCalled();
    expect(api.openPath).not.toHaveBeenCalled();
  });

  it('local + 12 格式 + 有 onLocalViewer → 调 onLocalViewer（不调 openPath）', async () => {
    const api = mockRockyShell();
    const onLocalViewer = vi.fn();
    openLinkTarget('config.yaml', { onLocalViewer });
    await flush();
    expect(onLocalViewer).toHaveBeenCalledOnce();
    const target = onLocalViewer.mock.calls[0]![0];
    expect(target.path).toBe('config.yaml');
    expect(target.source).toBe('workspace');
    expect(target.fileName).toBe('config.yaml');
    expect(api.openPath).not.toHaveBeenCalled();
  });

  it('local + 12 格式 + 无 onLocalViewer → 走 openPath（其它消费方降级）', () => {
    const api = mockRockyShell();
    openLinkTarget('/abs/file.md', {});
    expect(api.openPath).toHaveBeenCalledWith('/abs/file.md');
  });

  it('local + 非 12 格式（图片）→ openPath', () => {
    const api = mockRockyShell();
    openLinkTarget('/abs/shot.png', {});
    expect(api.openPath).toHaveBeenCalledWith('/abs/shot.png');
  });

  it('local + 非内置格式 + 无 rockyShell（非 Electron）→ noop 不抛', () => {
    delete (window as unknown as { rockyShell?: unknown }).rockyShell;
    expect(() => openLinkTarget('/abs/x.png', {})).not.toThrow();
  });

  it('web + 无 rockyShell（非 Electron）→ window.open 兜底', () => {
    delete (window as unknown as { rockyShell?: unknown }).rockyShell;
    const stub = vi.fn();
    vi.stubGlobal('open', stub);
    openLinkTarget('https://x.com', {});
    expect(stub).toHaveBeenCalledWith('https://x.com', '_blank', 'noopener');
    vi.unstubAllGlobals();
  });

  it('.env basename → onLocalViewer 触发（12 格式 env 命中）', async () => {
    const onLocalViewer = vi.fn();
    openLinkTarget('/abs/.env', { onLocalViewer });
    await flush();
    expect(onLocalViewer).toHaveBeenCalledOnce();
  });
});
