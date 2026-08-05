/**
 * a11y snapshot ref 解析 单元测试（白盒）
 * 覆盖：
 *   - buildSnapshotResult 解析 ariaSnapshot 文本 → refs 表
 *   - buildRefId slug 规则
 *   - lookupRef 找不到 → 抛错
 *   - PlaywrightSession.snapshot（mock playwright page，验 ariaSnapshot 调用 + refs 构造）
 */
import { describe, it, expect } from 'vitest';
import { buildSnapshotResult, buildRefId, lookupRef } from '../snapshot-ref';
import { PlaywrightSession } from '../playwright-session';

describe('buildSnapshotResult：解析 ariaSnapshot 文本', () => {
  const sample = `- button "Sign in"
- textbox "Email"
- link "Forgot password"
- button "Sign in"`;

  it('为每个命名节点建 ref', () => {
    const r = buildSnapshotResult(sample, 'aria');
    expect(r.snapshot).toBe(sample);
    // 同 role+name 的第 0、第 1 个分别拿到不同 nth
    expect(Object.keys(r.refs).length).toBe(4);
    expect(r.refs['button-sign-in-0']).toEqual({ role: 'button', name: 'Sign in', nth: 0 });
    expect(r.refs['button-sign-in-1']).toEqual({ role: 'button', name: 'Sign in', nth: 1 });
    expect(r.refs['textbox-email-0']).toEqual({ role: 'textbox', name: 'Email', nth: 0 });
  });

  it('format=ai → 直接保留 snapshot 文本', () => {
    const r = buildSnapshotResult(sample, 'ai');
    expect(r.snapshot).toBe(sample);
  });

  it('跳过无 name 的结构性节点', () => {
    const t = `- main:
  - button "OK"`;
    const r = buildSnapshotResult(t, 'aria');
    expect(Object.keys(r.refs)).toEqual(['button-ok-0']);
  });
});

describe('buildRefId slug', () => {
  it('特殊字符归一为 -', () => {
    expect(buildRefId('button', 'Sign In!', 0)).toBe('button-sign-in-0');
  });
  it('空 name 兜底 elem', () => {
    expect(buildRefId('button', '', 0)).toBe('button-elem-0');
  });
  it('超长 name 截断到 20 字符', () => {
    const id = buildRefId('link', 'a'.repeat(50), 0);
    expect(id.length).toBe('link-'.length + 20 + '-0'.length);
  });
});

describe('lookupRef', () => {
  it('找到 → 返回 RefInfo', () => {
    const refs = { 'b-x-0': { role: 'button', name: 'x', nth: 0 } };
    expect(lookupRef(refs, 'b-x-0')).toEqual({ role: 'button', name: 'x', nth: 0 });
  });
  it('找不到 → 抛错', () => {
    expect(() => lookupRef({}, 'nope')).toThrow(/未找到/);
  });
});

describe('PlaywrightSession.snapshot（mock page）', () => {
  it('snapshot 调用 page.locator(body).ariaSnapshot + 构造 refs', async () => {
    let called = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePage: any = {
      locator: () => ({
        ariaSnapshot: async (opts?: { mode?: string }) => {
          called = true;
          expect(opts?.mode).toBe('default');
          return `- button "Go"`;
        },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeBrowser: any = {
      contexts: () => [{ pages: () => [fakePage] }],
      close: async () => {},
    };
    const session = new PlaywrightSession(fakeBrowser, async () => {});
    const r = await session.snapshot({ format: 'aria' });
    expect(called).toBe(true);
    expect(r.refs['button-go-0']).toBeDefined();
    // listPages / navigate 走同 page
    const pages = await session.listPages();
    expect(pages.length).toBe(1);
  });

  it('format=ai → mode=ai', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePage: any = {
      locator: () => ({
        ariaSnapshot: async (opts?: { mode?: string }) => {
          expect(opts?.mode).toBe('ai');
          return `- link "Docs"`;
        },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeBrowser: any = {
      contexts: () => [{ pages: () => [fakePage] }],
      close: async () => {},
    };
    const session = new PlaywrightSession(fakeBrowser, async () => {});
    const r = await session.snapshot({ format: 'ai' });
    expect(r.refs['link-docs-0']).toBeDefined();
  });
});

describe('PlaywrightSession.click/type（mock locator）', () => {
  it('click 按 ref → getByRole+nth.click', async () => {
    let clicked = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePage: any = {
      locator: () => ({
        ariaSnapshot: async () => `- button "Submit"`,
      }),
      getByRole: (role: string, _opts: unknown) => ({
        nth: (_n: number) => ({
          click: async () => {
            clicked = true;
          },
          fill: async () => {},
        }),
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeBrowser: any = {
      contexts: () => [{ pages: () => [fakePage] }],
      close: async () => {},
    };
    const session = new PlaywrightSession(fakeBrowser, async () => {});
    await session.snapshot();
    await session.click('button-submit-0');
    expect(clicked).toBe(true);
  });
});
