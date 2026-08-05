#!/usr/bin/env bun
/**
 * build-plugins.ts — R1 build：把 app/plugins/builtins 的 .ts impl 编译成自包含 .cjs bundle
 *
 * 用途：packaged dmg（Electron 主进程 = Node CJS）跑不了 .ts 源码，故 build 期把每个
 *   manifest.extImpls[].impl 用 bun build 成自包含 `.cjs`——把 server import 外置成
 *   `@app/server/dist/X`（运行时 require 到 asar 内同一份 server 实例，保模块级单例不断裂），
 *   plugin 内部依赖 inline。产物 + 资源（plugin.json/scopes/groups.json/skills）落
 *   app/plugins/dist，由 electron-builder 打进 asar node_modules/@app/plugins。
 *
 * 参考: specs/tech/plugin_system/[P0]packaged_plugin_loading.md §3.2/§3.3/§4.1
 *       package.json scripts.build:worker（bun build --target=node --format=cjs 先例）
 *
 * 由 bun 执行（bun run scripts/build-plugins.ts）；产物缺失 / build 失败 → 非 0 退出。
 * 不改原 app/plugins/builtins 源码（用 stage 临时副本改写，dev 仍用原源码）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 仓库根（scripts/ 的父目录）——不依赖 cwd
const REPO_ROOT = path.resolve(import.meta.dir, '..');
const PLUGINS_SRC = path.join(REPO_ROOT, 'app/plugins');
const BUILTINS_SRC = path.join(PLUGINS_SRC, 'builtins');
const DIST = path.join(PLUGINS_SRC, 'dist');
const DIST_BUILTINS = path.join(DIST, 'builtins');

// server import 外置目标（运行时 require 到 asar node_modules/@app/server，与 server 同实例）
// + 随 server deps 已在 asar 的 npm 包。包名 external 可靠命中含深子路径（§3.3）。
const EXTERNALS = ['@app/server', '@larksuiteoapi/node-sdk', 'undici', 'playwright'];
// server 源码 import 改写：(../)+server/src/X → @app/server/dist/X（深度无关，§3.3）
const SERVER_IMPORT_RE = /(\.\.\/)+server\/src\//g;

/** 收集所有内置 plugin 的 impl 入口（映射到 stage 内绝对路径）+ plugin id 清单 */
function collectEntrypoints(stageBuiltins: string): {
  entrypoints: string[];
  pluginIds: string[];
} {
  const entrypoints: string[] = [];
  const pluginIds: string[] = [];
  for (const entry of fs.readdirSync(BUILTINS_SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(BUILTINS_SRC, entry.name, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue; // 无 plugin.json 的目录（如 skills）跳过
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      id: string;
      extImpls: Array<{ impl: string }>;
    };
    pluginIds.push(manifest.id);
    for (const ext of manifest.extImpls) {
      // impl 相对 plugin 目录（如 ./ingest/query_truncate.ts）→ stage 内绝对路径
      entrypoints.push(path.resolve(stageBuiltins, entry.name, ext.impl));
    }
  }
  return { entrypoints, pluginIds };
}

/** 递归改写 stage 内所有 .ts（排除 .test.ts）的 server import → @app/server/dist */
function rewriteServerImports(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteServerImports(full);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      const src = fs.readFileSync(full, 'utf8');
      const out = src.replace(SERVER_IMPORT_RE, '@app/server/dist/');
      if (out !== src) fs.writeFileSync(full, out);
    }
  }
}

/** bun build 每个 entry → 自包含 .cjs（保相对目录结构 [dir]/[name].cjs） */
async function buildBundles(entrypoints: string[], root: string): Promise<void> {
  const result = await Bun.build({
    entrypoints,
    outdir: DIST_BUILTINS,
    root,
    target: 'node',
    format: 'cjs',
    naming: '[dir]/[name].cjs',
    external: EXTERNALS,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Bun.build 失败（${entrypoints.length} entries）`);
  }
}

/** 拷贝资源（从原 app/plugins，无需改写）：plugin.json / scopes / groups.json / skills */
function copyResources(pluginIds: string[]): void {
  // 各 plugin.json → dist/builtins/<id>/
  for (const id of pluginIds) {
    const to = path.join(DIST_BUILTINS, id, 'plugin.json');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(BUILTINS_SRC, id, 'plugin.json'), to);
  }
  // scopes/*.yaml → dist/scopes/
  const scopesSrc = path.join(PLUGINS_SRC, 'scopes');
  const scopesDst = path.join(DIST, 'scopes');
  fs.mkdirSync(scopesDst, { recursive: true });
  for (const f of fs.readdirSync(scopesSrc)) {
    if (f.endsWith('.yaml')) {
      fs.copyFileSync(path.join(scopesSrc, f), path.join(scopesDst, f));
    }
  }
  // session-types/*.yaml → dist/session-types/（profile yaml 单源；packaged 护栏：
  // dev 测不到的打包防线——loader 走 dist/session-types/，缺失则 packaged 启动硬失败）
  const sessionTypesSrc = path.join(PLUGINS_SRC, 'session-types');
  const sessionTypesDst = path.join(DIST, 'session-types');
  fs.mkdirSync(sessionTypesDst, { recursive: true });
  for (const f of fs.readdirSync(sessionTypesSrc)) {
    if (f.endsWith('.yaml')) {
      fs.copyFileSync(path.join(sessionTypesSrc, f), path.join(sessionTypesDst, f));
    }
  }
  // groups.json → dist/groups.json
  fs.copyFileSync(path.join(PLUGINS_SRC, 'groups.json'), path.join(DIST, 'groups.json'));
  // skills/** → dist/builtins/skills/（递归；skills 是资源目录，非 plugin）
  // academy-*-skill 落 builtins/skills/（builtin 扫描根，dev/打包一致可见，
  // 修 messages.log 实证的 dev 不可见根因）。由本 BUILTINS_SRC/skills 统一覆盖
  // academy-* 子目录（持续可打包护栏 BUG-003）。
  const skillsSrc = path.join(BUILTINS_SRC, 'skills');
  if (fs.existsSync(skillsSrc)) {
    fs.cpSync(skillsSrc, path.join(DIST_BUILTINS, 'skills'), { recursive: true });
  }
}

/** 产物校验：每 plugin 目录存在 + 至少 1 个 .cjs + scopes/groups.json 齐全，缺则抛错 */
function verifyProducts(pluginIds: string[]): number {
  let cjsCount = 0;
  const countCjs = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) countCjs(path.join(d, e.name));
      else if (e.name.endsWith('.cjs')) cjsCount++;
    }
  };
  for (const id of pluginIds) {
    const idDir = path.join(DIST_BUILTINS, id);
    if (!fs.existsSync(idDir)) throw new Error(`产物缺失：${idDir}`);
    countCjs(idDir);
  }
  // scopes/session-types 基座（default/summary/consolidate）——packaged 护栏
  for (const f of [
    'scopes/default.yaml', 'scopes/summary.yaml', 'scopes/consolidate.yaml', 'groups.json',
    'session-types/default.yaml', 'session-types/summary.yaml', 'session-types/consolidate.yaml',
  ]) {
    if (!fs.existsSync(path.join(DIST, f))) throw new Error(`资源缺失：dist/${f}`);
  }
  if (cjsCount === 0) throw new Error('未产出任何 .cjs bundle');
  return cjsCount;
}

async function main(): Promise<void> {
  // 1. 清理并重建 dist（每次 build 全量重出，避免陈旧产物）
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST_BUILTINS, { recursive: true });

  // 2. stage：拷贝 builtins 源码到临时目录（不动原源码，dev 仍用原源码）
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-plugins-'));
  const stageBuiltins = path.join(stage, 'builtins');
  fs.cpSync(BUILTINS_SRC, stageBuiltins, { recursive: true });

  try {
    // 3. 改写 stage 内 server import → @app/server/dist
    rewriteServerImports(stageBuiltins);
    // 4. 收集 impl 入口
    const { entrypoints, pluginIds } = collectEntrypoints(stageBuiltins);
    console.log(
      `[build-plugins] ${pluginIds.length} plugins, ${entrypoints.length} impl entries`,
    );
    // 5. bun build → 自包含 .cjs
    await buildBundles(entrypoints, stageBuiltins);
    // 6. 拷贝资源
    copyResources(pluginIds);
    // 7. 校验产物
    const cjsCount = verifyProducts(pluginIds);
    console.log(
      `[build-plugins] DONE: ${cjsCount} .cjs bundles → ${path.relative(REPO_ROOT, DIST_BUILTINS)}`,
    );
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('[build-plugins] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
