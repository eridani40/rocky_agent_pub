/**
 * workspace-open / workspace-dialog 单元测试（v0.0.17 T3）
 * 参考: specs/api/overall/04-agent-session.md §2.6.2 / §2.6.3
 *       specs/tech/agent/session/[P0]session_workspace.md §6（白名单 caller 负责，本测试只验平台 spawn）
 *
 * 教训（学 T2 chokidar mock + v0.0.17 IDE 弹窗事故）：
 *   spawnSync 是 node 内置模块函数，vi.mock('node:child_process') 在并发 suite 下会污染
 *   其他用 spawnSync 的测试（如 bash/file-grep 工具）。**绝不真实 spawnSync('open'/'osascript')**：
 *   macOS/桌面环境会弹 Finder/编辑器/原生 dialog 到系统 GUI 层面（非 bash stderr，
 *   无法捕获，直接打到 IDE 干扰用户）。统一用 spawnFn 注入参数（openWithSystemApp /
 *   pickDirectory 均已支持）注入 mock，测三态（exit 0 成功 / 非零退出 / ENOENT）。
 *
 * 文件系统隔离：tmpdir + mkdtemp + afterEach rm，绝不读写真实路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openWithSystemApp,
  type OpenKind,
} from '../workspace-open';
import { pickDirectory } from '../workspace-dialog';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'oobt-platform-ws-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('openWithSystemApp — OpenResult 字段契约（mock spawnFn，绝不真实 spawn）', () => {
  // mock spawnFn 三态：exit 0 成功 / 非零退出失败 / ENOENT 命令缺失
  const spawnOk = (() => ({ status: 0 })) as unknown as Parameters<
    typeof openWithSystemApp
  >[2];
  const spawnFail = (() => ({ status: 1, stderr: 'no display' })) as unknown as Parameters<
    typeof openWithSystemApp
  >[2];

  it('spawn 成功（exit 0）→ OpenResult {ok:true}（kind=file）', () => {
    const filePath = join(tmp, 'a.txt');
    writeFileSync(filePath, 'hello');
    const r = openWithSystemApp('file' as OpenKind, filePath, spawnOk);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('spawn 成功（exit 0）→ OpenResult {ok:true}（kind=folder）', () => {
    const dirPath = join(tmp, 'subdir');
    mkdirSync(dirPath);
    const r = openWithSystemApp('folder' as OpenKind, dirPath, spawnOk);
    expect(r.ok).toBe(true);
  });

  it('spawn 非零退出 → OpenResult {ok:false, error}', () => {
    const filePath = join(tmp, 'a.txt');
    writeFileSync(filePath, 'hello');
    const r = openWithSystemApp('file' as OpenKind, filePath, spawnFail);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('命令不存在（spawn ENOENT）→ OpenResult.ok=false + error 含 spawn error', () => {
    const filePath = join(tmp, 'a.txt');
    writeFileSync(filePath, 'hello');
    // 注入 mock spawnFn 返 ENOENT（避开 macOS open 经 /usr/bin 绕过 process.env.PATH 的特性，
    // PATH 清空在 mac 上 spawnSync('open') 仍能解析 → ok=true，断言不可靠）
    const mockSpawn = (() => ({
      error: { code: 'ENOENT', message: 'spawn ENOENT' },
    })) as unknown as Parameters<typeof openWithSystemApp>[2];
    const r = openWithSystemApp('file' as OpenKind, filePath, mockSpawn);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('pickDirectory — PickResult 字段契约（mock spawnFn，绝不真实弹 dialog）', () => {
  it('用户选定（spawn exit 0 + stdout 非空）→ PickResult.path=string', () => {
    const spawnPicked = (() => ({
      status: 0,
      stdout: '/mock/picked-dir\n',
    })) as unknown as Parameters<typeof pickDirectory>[1];
    const r = pickDirectory(tmp, spawnPicked);
    expect(r.path).toBe('/mock/picked-dir');
    expect(r.error).toBeUndefined();
  });

  it('用户取消（spawn 非零退出）→ PickResult.path=null（取消非错误，跨平台一致）', () => {
    const spawnCancel = (() => ({
      status: 1,
      stderr: 'User canceled',
    })) as unknown as Parameters<typeof pickDirectory>[1];
    const r = pickDirectory(tmp, spawnCancel);
    expect(r.path).toBeNull();
  });

  it('dialog 命令不存在（spawn ENOENT）→ PickResult.path=null + error 非空', () => {
    const spawnENOENT = (() => ({
      error: { code: 'ENOENT', message: 'spawn ENOENT' },
    })) as unknown as Parameters<typeof pickDirectory>[1];
    const r = pickDirectory(tmp, spawnENOENT);
    expect(r.path).toBeNull();
    expect(typeof r.error).toBe('string');
  });
});
