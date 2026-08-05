/**
 * open-external-ipc 单测 — 通用打开外部资源 IPC 纯计算函数（v0.0.253）
 * 参考: app/electron/src/open-external-ipc.ts
 *       specs/tech/version_logs/v0.0.253/change_plan.md 模块 L
 *
 * 只测纯计算函数（注入 fake 依赖，无需 Electron runtime）：
 *   - computeResolveLocalPath：file:// strip / ~ 展开（注入 fake home）/ 相对路径拒绝 / win 盘符
 *   - computeOpenExternal：成功 + shell 异常 reason
 *   - computeOpenPath：成功 + 异常 reason
 *   - computeReadFileText：成功 + ENOENT/EACCES/超大文件 reason
 * registerOpenExternalIpc 走真 electron require，不进 UT（Electron 主进程运行时才有）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  computeResolveLocalPath,
  computeOpenExternal,
  computeOpenPath,
  computeReadFileText,
  type ShellLike,
  type FsLike,
} from '../open-external-ipc';

/** 造 shell fake（openExternal / openPath 可分别抛） */
function fakeShell(over: Partial<{ openExternalErr: Error; openPathErr: Error }> = {}): ShellLike {
  return {
    openExternal: vi.fn(async () => {
      if (over.openExternalErr) throw over.openExternalErr;
    }),
    openPath: vi.fn(async () => {
      if (over.openPathErr) throw over.openPathErr;
    }),
  };
}

/** 造 fs fake（readFile 返 content 或抛；stat 可选返 size 或抛） */
function fakeFs(over: Partial<{ content: string; readErr: Error; size: number; statErr: Error }> = {}): FsLike {
  return {
    readFile: vi.fn(async () => {
      if (over.readErr) throw over.readErr;
      return over.content ?? 'fake-content';
    }),
    stat: over.size !== undefined || over.statErr !== undefined
      ? vi.fn(async () => {
          if (over.statErr) throw over.statErr;
          return { size: over.size ?? 100 };
        })
      : undefined,
  };
}

describe('computeResolveLocalPath', () => {
  it('绝对 POSIX 路径原样返回', () => {
    const r = computeResolveLocalPath('/var/log/app.log', '/Users/u');
    expect(r.ok).toBe(true);
    expect(r.absPath).toBe('/var/log/app.log');
  });

  it('file:// 前缀 strip', () => {
    const r = computeResolveLocalPath('file:///var/log/app.log', '/Users/u');
    expect(r.ok).toBe(true);
    expect(r.absPath).toBe('/var/log/app.log');
  });

  it('~ 单独 → home', () => {
    const r = computeResolveLocalPath('~', '/Users/test');
    expect(r.ok).toBe(true);
    expect(r.absPath).toBe('/Users/test');
  });

  it('~/... → home + 后续路径', () => {
    const r = computeResolveLocalPath('~/logs/app.log', '/Users/test');
    expect(r.ok).toBe(true);
    expect(r.absPath).toBe('/Users/test/logs/app.log');
  });

  it('Windows 盘符绝对路径（反斜杠）', () => {
    const r = computeResolveLocalPath('C:\\Users\\u\\logs', '/home/u');
    expect(r.ok).toBe(true);
    expect(r.absPath).toBe('C:\\Users\\u\\logs');
  });

  it('Windows 盘符绝对路径（正斜杠）', () => {
    const r = computeResolveLocalPath('D:/data/log.txt', '/home/u');
    expect(r.ok).toBe(true);
    expect(r.absPath).toBe('D:/data/log.txt');
  });

  it('相对路径（workspace 相对）拒绝：ok=false reason=relative-not-allowed', () => {
    const r = computeResolveLocalPath('config.yaml', '/Users/u');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('relative-not-allowed');
  });

  it('./ 相对路径拒绝', () => {
    const r = computeResolveLocalPath('./notes.md', '/Users/u');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('relative-not-allowed');
  });

  it('空字符串拒绝', () => {
    const r = computeResolveLocalPath('', '/Users/u');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty-path');
  });
});

describe('computeOpenExternal', () => {
  it('成功调 shell.openExternal(url) → ok=true', async () => {
    const shell = fakeShell();
    const r = await computeOpenExternal('https://example.com', shell);
    expect(r.ok).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('shell 抛异常 → ok=false + reason', async () => {
    const shell = fakeShell({ openExternalErr: new Error('no handler') });
    const r = await computeOpenExternal('https://example.com', shell);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no handler');
  });

  it('非 Error 抛出 → reason=String(e)', async () => {
    const shell: ShellLike = {
      openExternal: vi.fn(async () => {
        throw 'string error';
      }),
      openPath: vi.fn(async () => {}),
    };
    const r = await computeOpenExternal('https://x.com', shell);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('string error');
  });
});

describe('computeOpenPath', () => {
  it('成功调 shell.openPath(absPath) → ok=true', async () => {
    const shell = fakeShell();
    const r = await computeOpenPath('/var/log/app.log', shell);
    expect(r.ok).toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith('/var/log/app.log');
  });

  it('shell 抛异常 → ok=false + reason', async () => {
    const shell = fakeShell({ openPathErr: new Error('not found') });
    const r = await computeOpenPath('/no/such', shell);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not found');
  });
});

describe('computeReadFileText', () => {
  it('成功 → ok=true + content', async () => {
    const fs = fakeFs({ content: 'hello world' });
    const r = await computeReadFileText('/abs/file.md', fs);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('hello world');
  });

  it('ENOENT → ok=false reason=not-found', async () => {
    const fs = fakeFs({ readErr: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
    const r = await computeReadFileText('/abs/missing.md', fs);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-found');
  });

  it('EACCES → ok=false reason=permission-denied', async () => {
    const fs = fakeFs({ readErr: Object.assign(new Error('permission denied'), { code: 'EACCES' }) });
    const r = await computeReadFileText('/abs/secret.md', fs);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('permission-denied');
  });

  it('超大文件（stat.size > 2MB）→ ok=false reason=too-large', async () => {
    const fs = fakeFs({ size: 3 * 1024 * 1024 });
    const r = await computeReadFileText('/abs/huge.log', fs);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-large');
    // stat 预检拦截后 readFile 不应被调
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('文件大小在阈值内 → 正常读', async () => {
    const fs = fakeFs({ size: 1024, content: 'small' });
    const r = await computeReadFileText('/abs/file.txt', fs);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('small');
  });

  it('未知异常 → reason=原始 message', async () => {
    const fs = fakeFs({ readErr: new Error('unknown IO failure') });
    const r = await computeReadFileText('/abs/x.txt', fs);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown IO failure');
  });

  it('fs.stat 缺省（undefined）→ 跳过预检，直接读', async () => {
    const fs: FsLike = {
      readFile: vi.fn(async () => 'content-without-stat'),
    };
    const r = await computeReadFileText('/abs/no-stat.txt', fs);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('content-without-stat');
  });
});
