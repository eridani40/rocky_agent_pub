/**
 * feishu-slash.ts 单测
 * 参考: reqs/[done] v0.0.103.channel/design-feishu.md §3
 *       reqs/[done] v0.0.103.channel/design-usecases.md UC-C1~C6
 *
 * 覆盖 6 指令派发 + 错误提示 + unknown 指令 fallback。
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchSlash, isSlashCommand, type SlashDeps } from '../feishu-slash';
import type { Session } from '../../../../server/src/agent/session-store-types';

function makeSession(id: string, title?: string): Session {
  return {
    id,
    title,
  } as Session;
}

function makeDeps(overrides: Partial<SlashDeps> = {}): SlashDeps {
  return {
    listPlaygroundSessions: async () => [],
    listStudioLeaders: async () => [],
    bind: async () => {},
    unbind: async () => {},
    getBindedSession: async () => null,
    ...overrides,
  };
}

describe('isSlashCommand', () => {
  it('/ 开头 true', () => {
    expect(isSlashCommand('/listp')).toBe(true);
    expect(isSlashCommand('  /listp')).toBe(true);
  });
  it('非 / 开头 false', () => {
    expect(isSlashCommand('hello')).toBe(false);
    expect(isSlashCommand('')).toBe(false);
  });
});

describe('dispatchSlash /listp', () => {
  it('返回 playground 列表（1-based 编号）', async () => {
    const deps = makeDeps({
      listPlaygroundSessions: async () => [
        makeSession('sess_a', 'Play 1'),
        makeSession('sess_b', 'Play 2'),
      ],
    });
    const r = await dispatchSlash('/listp', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('Playground');
    expect(r.replyText).toContain('1.');
    expect(r.replyText).toContain('Play 1');
    expect(r.replyText).toContain('2.');
    expect(r.replyText).toContain('Play 2');
  });

  it('空列表提示', async () => {
    const r = await dispatchSlash('/listp', makeDeps(), 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('没有可用');
  });
});

describe('dispatchSlash /lists', () => {
  it('返回 studio leader 列表', async () => {
    const deps = makeDeps({
      listStudioLeaders: async () => [makeSession('sess_leader', 'Studio A')],
    });
    const r = await dispatchSlash('/lists', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('Studio Leader');
    expect(r.replyText).toContain('Studio A');
  });
});

describe('dispatchSlash /bindp N', () => {
  it('缺参数提示用法', async () => {
    const r = await dispatchSlash('/bindp', makeDeps(), 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('用法');
  });

  it('非数字参数提示用法', async () => {
    const r = await dispatchSlash('/bindp abc', makeDeps(), 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('用法');
  });

  it('绑定成功 → 调 bind（by=slash）', async () => {
    const bind = vi.fn(async () => {});
    const deps = makeDeps({
      listPlaygroundSessions: async () => [makeSession('sess_p1', 'P1')],
      bind,
    });
    const r = await dispatchSlash('/bindp 1', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('已绑定');
    expect(bind).toHaveBeenCalledWith('oc_conv', 'sess_p1', 'slash');
  });

  it('编号超出范围提示', async () => {
    const deps = makeDeps({
      listPlaygroundSessions: async () => [makeSession('s1')],
    });
    const r = await dispatchSlash('/bindp 5', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('超出范围');
  });

  it('N=0 拒绝', async () => {
    const deps = makeDeps({
      listPlaygroundSessions: async () => [makeSession('s1')],
    });
    const r = await dispatchSlash('/bindp 0', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('≥ 1');
  });

  it('SESSION_ALREADY_BOUND 错误友好提示', async () => {
    const deps = makeDeps({
      listPlaygroundSessions: async () => [makeSession('s1')],
      bind: async () => {
        const e = new Error('session s1 已被 instance=xx conversation=yy 绑定 (SESSION_ALREADY_BOUND)');
        (e as Error & { code?: string }).code = 'SESSION_ALREADY_BOUND';
        throw e;
      },
    });
    const r = await dispatchSlash('/bindp 1', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('已被其他渠道会话占用');
  });
});

describe('dispatchSlash /binds N', () => {
  it('绑定 studio leader session', async () => {
    const bind = vi.fn(async () => {});
    const deps = makeDeps({
      listStudioLeaders: async () => [makeSession('sess_l1', 'Leader 1')],
      bind,
    });
    const r = await dispatchSlash('/binds 1', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('已绑定');
    expect(r.replyText).toContain('studio leader');
    expect(bind).toHaveBeenCalledWith('oc_conv', 'sess_l1', 'slash');
  });
});

describe('dispatchSlash /unbind', () => {
  it('已绑定 → 解绑成功', async () => {
    const unbind = vi.fn(async () => {});
    const deps = makeDeps({
      getBindedSession: async () => 'sess_old',
      unbind,
    });
    const r = await dispatchSlash('/unbind', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('已解绑');
    expect(unbind).toHaveBeenCalledWith('oc_conv');
  });

  it('未绑定提示', async () => {
    const r = await dispatchSlash('/unbind', makeDeps(), 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('未绑定');
  });
});

describe('dispatchSlash /status', () => {
  it('已绑定 → 显示 sessionId', async () => {
    const deps = makeDeps({
      getBindedSession: async () => 'sess_currentXYZ',
    });
    const r = await dispatchSlash('/status', deps, 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('sess_currentXYZ');
  });

  it('未绑定提示', async () => {
    const r = await dispatchSlash('/status', makeDeps(), 'oc_conv');
    expect(r.recognized).toBe(true);
    expect(r.replyText).toContain('未绑定');
  });
});

describe('dispatchSlash 未知指令', () => {
  it('返回可用指令清单', async () => {
    const r = await dispatchSlash('/foobar', makeDeps(), 'oc_conv');
    expect(r.recognized).toBe(false);
    expect(r.replyText).toContain('未知指令');
    expect(r.replyText).toContain('/listp');
    expect(r.replyText).toContain('/lists');
    expect(r.replyText).toContain('/bindp');
    expect(r.replyText).toContain('/binds');
    expect(r.replyText).toContain('/unbind');
    expect(r.replyText).toContain('/status');
  });
});

describe('dispatchSlash 非斜杠文本', () => {
  it('非斜杠 → recognized=false + 空 replyText', async () => {
    const r = await dispatchSlash('hello world', makeDeps(), 'oc_conv');
    expect(r.recognized).toBe(false);
    expect(r.replyText).toBe('');
  });
});
