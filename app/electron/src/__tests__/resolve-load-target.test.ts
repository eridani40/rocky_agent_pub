/**
 * resolveLoadTarget 单测 — Electron 主进程加载目标决策
 * 参考: specs/tech/app/package/[P0]package_structure.md §4.3
 *       本 task 指令（dev: VITE_DEV_SERVER_URL；packaged: loadFile index.html）
 *
 * 校验点：
 *   - dev：VITE_DEV_SERVER_URL 存在 → 返回 { kind: 'url', url }
 *   - packaged：缺该 env → 返回 { kind: 'file', path: <webDist>/index.html }
 *   - webDist 由参数显式传入（依赖注入，便于测试）
 */
import { describe, it, expect } from 'vitest';
import { resolveLoadTarget } from '../resolve-load-target';

describe('resolveLoadTarget', () => {
  it('dev 模式：VITE_DEV_SERVER_URL 存在 → 返回 url 目标', () => {
    const t = resolveLoadTarget(
      { VITE_DEV_SERVER_URL: 'http://127.0.0.1:8788' },
      '/abs/web-dist',
    );
    expect(t).toEqual({ kind: 'url', url: 'http://127.0.0.1:8788' });
  });

  it('packaged 模式：缺 VITE_DEV_SERVER_URL → 返回 file 目标指向 index.html', () => {
    const t = resolveLoadTarget({}, '/abs/web-dist');
    expect(t).toEqual({ kind: 'file', path: '/abs/web-dist/index.html' });
  });

  it('packaged 模式：空字符串 VITE_DEV_SERVER_URL 视为缺省 → file 目标', () => {
    const t = resolveLoadTarget({ VITE_DEV_SERVER_URL: '' }, '/abs/web-dist');
    expect(t.kind).toBe('file');
  });

  it('packaged 模式：webDist 拼接 index.html，保留原绝对路径', () => {
    const t = resolveLoadTarget({}, '/path/to/web-dist');
    if (t.kind !== 'file') throw new Error('expect file');
    expect(t.path.endsWith('/path/to/web-dist/index.html')).toBe(true);
  });
});
