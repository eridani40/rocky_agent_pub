/**
 * session-workspace-save-image handler UT — POST /session/:id/workspace/save-image（v0.0.177）
 * 参考: specs/api/overall/04-agent-session.md §2.6.6（save-image 端点契约）
 *       specs/prd/version_logs/v0.0.177.md（产品逻辑）
 *       specs/tech/version_logs/v0.0.177/change_plan.md（method 级合同）
 *
 * 覆盖 test-plan UT 必覆盖清单：
 *   - base64 → Buffer 解码正确落盘
 *   - mediaType → ext：png/jpeg/jpg/gif/webp（未知 image mediaType → 400）
 *   - images/ 不存在 → mkdir recursive 创建
 *   - 落盘路径 = <workspaceDir>/images/image-<ulid>.<ext>
 *   - 路径白名单安全（absPath startsWith realRoot；filename 由 server 自生成）
 *   - relPath 是 POSIX 相对 workspaceDir（images/<filename>）
 *   - ulid 确定性（非纯 Date.now，长度 26，Crockford Base32）
 *   - session 不存在 → 404 / 非 POST → 405 / body 非法 → 400
 *   - workspaceDir 缺失 → 500 / realpath 失败 → 500 / writeFile 失败 → 500
 *
 * 文件系统隔离：tmpdir + mkdtemp + afterEach rm。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { ulid } from '../../config/ulid';
import { handleWorkspaceSaveImage } from '../session-workspace-save-image';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-saveimg-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造空 SessionHandlerDeps（save-image 不依赖其他 deps） */
function makeDeps(): SessionHandlerDeps {
  const fake = {
    abort: async () => ({ accepted: false }),
    clearReplay: () => undefined,
  };
  return {
    store,
    agentManager: fake as unknown as AgentManagerImpl,
    appConfig: {} as never,
    pluginManager: {} as never,
    contextEngine: {} as never,
    dataDir: tmpRoot,
  };
}

/** 创建 session 并手动指定 workspaceDir */
async function newSessionWithWorkspace(workspaceDir: string): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid, title: 'test', workspaceDir });
  return sid;
}

/** body 解析 helper */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 1x1 PNG 透明图的纯 base64（不带 data: 前缀） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
/** 1x1 JPEG 最小合法数据（base64） */
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwA/9k=';

describe('POST /session/:id/workspace/save-image', () => {
  it('base64 正确解码落盘（PNG）+ 返 relPath=images/<filename>', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-png-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.path).toMatch(/^images\/image-[0-9A-HJKMNP-TV-Z]{26}\.png$/);
      // 文件实际落盘
      const abs = join(ws, b.path);
      expect(existsSync(abs)).toBe(true);
      const written = readFileSync(abs);
      const expected = Buffer.from(PNG_BASE64, 'base64');
      expect(written.equals(expected)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('mediaType=image/jpeg → ext=.jpg', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-jpg-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/jpeg', base64: JPEG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.path).toMatch(/^images\/image-[0-9A-HJKMNP-TV-Z]{26}\.jpg$/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('mediaType=image/gif → ext=.gif / image/webp → ext=.webp', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-gif-webp-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      for (const mt of ['image/gif', 'image/webp'] as const) {
        const expectedExt = mt === 'image/gif' ? '.gif' : '.webp';
        const res = await handleWorkspaceSaveImage(
          new Request(`http://x/session/${sid}/workspace/save-image`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mediaType: mt, base64: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }),
          }),
          'POST',
          sid,
          makeDeps(),
        );
        expect(res.status).toBe(200);
        const b = await body(res);
        expect(b.path.endsWith(expectedExt)).toBe(true);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('未识别的 image mediaType（如 image/bmp）→ 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-bmp-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/bmp', base64: 'Qk==' }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('images/ 目录不存在 → mkdir recursive 自动创建', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-mkdir-'));
    try {
      // ws 下没 images 子目录
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(existsSync(join(ws, b.path))).toBe(true);
      expect(statSync(join(ws, 'images')).isDirectory()).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('images/ 目录已存在 → 不报错，仍正确落盘', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-existent-'));
    try {
      mkdirSync(join(ws, 'images'), { recursive: true });
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(existsSync(join(ws, b.path))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('落盘路径必须在 realRoot 内（白名单二次守卫，filename 由 server 自生成不穿越）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-whitelist-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      // 文件必须在 realRoot/images/ 下
      const realRoot = realpathSync(ws);
      const abs = join(ws, b.path);
      const realAbs = realpathSync(abs);
      const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
      expect(realAbs.startsWith(rootWithSep)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('relPath 是 POSIX 相对 workspaceDir（images/<filename>，正斜杠分隔）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-posix-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.path).toMatch(/^images\/image-[0-9A-HJKMNP-TV-Z]{26}\.png$/);
      // 反斜杠绝不应出现（POSIX）
      expect(b.path).not.toContain('\\');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('ulid 命名确定性（26 字符 Crockford Base32，非纯 Date.now）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-ulid-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      const b = await body(res);
      // image-<26 字符 ulid>.png
      const match = (b.path as string).match(/^images\/image-([0-9A-HJKMNP-TV-Z]{26})\.png$/);
      expect(match).toBeTruthy();
      // 同毫秒内连发两张应得到不同 filename（随机段保证唯一，不用 Date.now 当 id）
      const res2 = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      const b2 = await body(res2);
      expect(b2.path).not.toBe(b.path);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // ============================================================
  // 错误分支
  // ============================================================

  it('404 session 不存在', async () => {
    const res = await handleWorkspaceSaveImage(
      new Request('http://x/session/nope/workspace/save-image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
      }),
      'POST',
      'nope',
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });

  it('405 非 POST（带 Allow: POST 头）', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceSaveImage(
      new Request(`http://x/session/${sid}/workspace/save-image`, { method: 'GET' }),
      'GET',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('400 mediaType 非 image/*（text/plain）', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceSaveImage(
      new Request(`http://x/session/${sid}/workspace/save-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaType: 'text/plain', base64: 'aGVsbG8=' }),
      }),
      'POST',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  it('400 base64 空', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceSaveImage(
      new Request(`http://x/session/${sid}/workspace/save-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaType: 'image/png', base64: '' }),
      }),
      'POST',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  it('400 body 非 JSON', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceSaveImage(
      new Request(`http://x/session/${sid}/workspace/save-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
      'POST',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  it('500 session 无 workspaceDir', async () => {
    // 创建一个无 workspaceDir 的 session
    const sid = ulid();
    await store.createSession({ id: sid, title: 'no-ws' });
    const res = await handleWorkspaceSaveImage(
      new Request(`http://x/session/${sid}/workspace/save-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
      }),
      'POST',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(500);
  });

  it('500 workspaceDir realpath 失败（目录被外部删除）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-realpath-fail-'));
    const sid = await newSessionWithWorkspace(ws);
    // 删 ws 使 realpathSync 失败
    rmSync(ws, { recursive: true, force: true });
    const res = await handleWorkspaceSaveImage(
      new Request(`http://x/session/${sid}/workspace/save-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
      }),
      'POST',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(500);
  });

  it('500 writeFile 失败（images 已存在但作为文件而非目录，mkdir 静默通过但 writeFile 到目录失败）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-saveimg-writefile-fail-'));
    try {
      // 在 ws 下放一个名叫 "images" 的文件（阻塞 mkdir 创建 images/ 目录）
      writeFileSync(join(ws, 'images'), 'i am a file not a dir');
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceSaveImage(
        new Request(`http://x/session/${sid}/workspace/save-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mediaType: 'image/png', base64: PNG_BASE64 }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      // mkdir recursive 会失败（EEXIST + 不是目录）或 writeFile 失败 → 500
      expect(res.status).toBe(500);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('error message 不回显 base64 / 绝对路径', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceSaveImage(
      new Request(`http://x/session/${sid}/workspace/save-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaType: 'image/bmp', base64: 'SECRET_DATA' }),
      }),
      'POST',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(JSON.stringify(b)).not.toContain('SECRET_DATA');
    expect(JSON.stringify(b)).not.toContain(tmpRoot);
  });
});
