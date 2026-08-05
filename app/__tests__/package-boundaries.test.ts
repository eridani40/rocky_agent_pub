/**
 * workspace 依赖边界单测
 * 参考: specs/tech/app/package/[P0]package_structure.md §2.2/§3.3/§3.4
 * 强制编译期依赖边界：
 *   - server 不依赖 electron
 *   - protocols 不依赖任何 @app/*
 *   - web 不依赖 electron
 *   - 依赖方向单向：web→protocols、electron→server+protocols、server→protocols
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 读取 workspace 包的 package.json 并解析
 * @param relPath 相对 app/ 目录的路径；'..' 表示仓库根（app/__tests__ → app → root）
 */
function readPkg(relPath: string): Record<string, unknown> {
  const abs = resolve(__dirname, '..', relPath, 'package.json');
  if (!existsSync(abs)) {
    throw new Error(`package.json not found: ${abs}`);
  }
  return JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
}

/** 读仓库根 package.json（app/__tests__ 往上两层） */
function readRootPkg(): Record<string, unknown> {
  const abs = resolve(__dirname, '..', '..', 'package.json');
  return JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
}

describe('workspace package.json 边界', () => {
  it('根 package.json 声明 6 个 workspaces', () => {
    const root = readRootPkg();
    expect(root.name).toBe('rocky-agent');
    expect(root.private).toBe(true);
    expect(root.workspaces).toEqual([
      'app/electron',
      'app/web',
      'app/server',
      'app/protocols',
      'app/shared',
      'app/computer-native',
    ]);
  });

  it('根 package.json scripts 含 test/typecheck', () => {
    const root = readRootPkg();
    expect(root.scripts).toMatchObject({
      // test 脚本须以 vitest run 收尾；前缀允许加 bun runtime 强制标志
      // （v0.0.2 起改 "bun --bun x vitest run" 让 bun:sqlite 内置模块可用）。
      test: expect.stringMatching(/vitest run$/),
      typecheck: expect.stringContaining('tsc'),
    });
  });

  it('@app/server 不依赖 electron', () => {
    const pkg = readPkg('server');
    const all = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
    expect(all).not.toHaveProperty('electron');
  });

  it('@app/protocols 不依赖任何 @app/*', () => {
    const pkg = readPkg('protocols');
    const all = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
    for (const key of Object.keys(all)) {
      expect(key).not.toMatch(/^@app\//);
    }
  });

  it('@app/shared 不依赖任何 @app/*', () => {
    const pkg = readPkg('shared');
    const all = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
    for (const key of Object.keys(all)) {
      expect(key).not.toMatch(/^@app\//);
    }
  });

  it('@app/web 不依赖 electron', () => {
    const pkg = readPkg('web');
    const all = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
    expect(all).not.toHaveProperty('electron');
  });

  it('@app/server 依赖 @app/protocols', () => {
    const pkg = readPkg('server');
    expect(pkg.dependencies).toMatchObject({ '@app/protocols': 'workspace:*' });
  });

  it('@app/web 依赖 @app/protocols', () => {
    const pkg = readPkg('web');
    expect(pkg.dependencies).toMatchObject({ '@app/protocols': 'workspace:*' });
  });

  it('@app/electron 依赖 @app/server + @app/protocols + electron（electron 在 devDeps）', () => {
    const pkg = readPkg('electron');
    // 业务 workspace deps 在 dependencies（package_structure §4.2）
    expect(pkg.dependencies).toMatchObject({
      '@app/server': 'workspace:*',
      '@app/protocols': 'workspace:*',
    });
    // electron 包放 devDependencies：运行时由 Electron.app 提供，不需打入 asar；
    // electron-builder v26 强制要求 electron 不在 dependencies（否则报错退出）
    expect(pkg.devDependencies).toMatchObject({
      electron: expect.stringContaining('42'),
    });
  });

  it('所有 workspace 包 private:true 且 version 0.0.0', () => {
    for (const name of ['electron', 'web', 'server', 'protocols', 'shared', 'computer-native']) {
      const pkg = readPkg(name);
      expect(pkg.private).toBe(true);
      expect(pkg.version).toBe('0.0.0');
      expect(pkg.name).toBe(`@app/${name}`);
    }
  });
});
