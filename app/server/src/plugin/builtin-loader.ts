/**
 * BuiltinLoader — 扫描 app/plugins/builtins/&#42;/plugin.json 静态登记 ext impl 类
 * 参考: specs/tech/plugin_system/[P0]builtin_plugins_directory.md §2/§3
 *       specs/tech/plugin_system/[P0]plugin_manager_interface.md §3.4（静态注册）
 *
 * 流程（builtin_plugins_directory §3）：
 *   1. 扫描 builtinsRoot/&#42;/plugin.json
 *   2. 校验目录名 == manifest.id（不一致→报错拒绝登记，§4.2）
 *   3. manifest 形状校验（id / extImpls[]，复用 registry.validateManifestShape）
 *   4. 按 extImpls[] 解析各 impl 模块的**默认导出类**，登记入 registry（不实例化、不跑代码）
 *
 * impl 模块约定：**default export 一个类**（plugin_manager §3.4 持有类引用）。
 * 选 default 而非 named：框架无法预知类名，default 是最简约定。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { Registry } from './registry';
import { validateManifestShape } from './registry';
import type { PluginManifest } from './manifest';

/**
 * CommonJS require —— 用于加载 packaged 的 `.cjs` bundle（packaged_plugin_loading §3.5）。
 * packaged（server 编译为 CJS，Electron 主进程 Node loader）运行时原生 `require` 可用；
 * dev/vitest（bun 跑 ESM 源码）bun 亦提供全局 `require`。若某运行时全局 `require` 不可用，
 * 用 `createRequire(__filename)` 兜底构造（`typeof` 探测不触发 ReferenceError）。
 */
const nodeRequire: NodeRequire =
  typeof require === 'function' ? require : createRequire(__filename);

/** BuiltinLoader 构造参数 */
export interface BuiltinLoaderOptions {
  /** 内置 plugin 根目录（默认 app/plugins/builtins，可注入便于测试） */
  root: string;
}

/**
 * 内置 plugin 静态扫描器。loadAll 遍历 root/&#42;/plugin.json，登记入 registry。
 */
export class BuiltinLoader {
  private readonly root: string;

  /**
   * @param optsOrRoot { root } 选项对象 或 直接传 root 字符串（便捷构造）
   */
  constructor(optsOrRoot: BuiltinLoaderOptions | string) {
    this.root =
      typeof optsOrRoot === 'string'
        ? optsOrRoot
        : optsOrRoot.root;
  }

  /**
   * 扫描 root 下所有子目录的 plugin.json，校验并登记 ext impl 入 registry。
   * 不实例化、不跑代码（plugin_manager §3.4）；impl 模块取 default export 作类引用。
   *
   * @throws 目录名与 manifest.id 不一致 / manifest 形状不合法 / impl 模块无 default export
   */
  async loadAll(registry: Registry): Promise<void> {
    // root 不存在或为空目录 → 无登记无报错（空 builtins）
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await this.loadOne(registry, entry.name);
    }
  }

  /** 加载单个 builtin 目录 */
  private async loadOne(registry: Registry, dirName: string): Promise<void> {
    const dir = path.join(this.root, dirName);
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      // 无 plugin.json 的子目录跳过（不视为 builtin）
      return;
    }
    const raw = fs.readFileSync(manifestPath, 'utf8');
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(raw) as PluginManifest;
    } catch (e) {
      throw new Error(
        `BuiltinLoader: ${manifestPath} JSON 解析失败: ${(e as Error).message}`,
      );
    }

    // 目录名 == manifest.id 校验（builtin_plugins_directory §4.2，不一致即拒绝登记）
    if (manifest.id !== dirName) {
      throw new Error(
        `BuiltinLoader: 目录名 "${dirName}" 与 manifest.id "${manifest.id}" 不一致（拒绝登记）`,
      );
    }

    // manifest 形状校验（复用 registry 校验）
    validateManifestShape(manifest);

    // 解析各 ext impl 模块的 default export 类
    const implClasses: unknown[] = [];
    for (const ext of manifest.extImpls) {
      // dev：literal 路径（.ts 源码）存在直接用；packaged：literal 不存在则把
      // .ts/.tsx 换成 .cjs（bun build 产物，packaged_plugin_loading §3.5）。
      // manifest.impl 字段保持 .ts 不改（唯一身份源）。
      let implPath = path.resolve(dir, ext.impl);
      if (!fs.existsSync(implPath)) {
        implPath = implPath.replace(/\.tsx?$/, '.cjs');
      }
      const mod = await importFile(implPath);
      const implClass = (mod as { default?: unknown }).default;
      if (typeof implClass !== 'function') {
        throw new Error(
          `BuiltinLoader: impl 模块 ${ext.impl}（implId=${ext.implId}, plugin=${manifest.id}）` +
            `缺少 default export 类`,
        );
      }
      implClasses.push(implClass);
    }

    registry.register(manifest, ...implClasses);
  }
}

/**
 * 加载一个 impl 模块文件，按后缀双模式（packaged_plugin_loading §3.1/§3.5）：
 *   - `.cjs`/`.js`（packaged bun build 产物）→ 直接 `require` 纯路径（**非** file:// URL）
 *     取 CJS bundle。tsc `module:CommonJS` 会把 `import()` 降级成 `require(fileURL)`，
 *     对 `.cjs` 不可用，故此处显式 require 纯路径。
 *   - `.ts`（dev/bun 源码）→ `await import(file:// URL)`（bun 认 .ts，vitest 兼容）。
 * 两模式 caller 取 `mod.default` 作类引用逻辑一致。
 */
async function importFile(absPath: string): Promise<Record<string, unknown>> {
  if (absPath.endsWith('.cjs') || absPath.endsWith('.js')) {
    // packaged：CJS bundle，直接 require 纯路径（不传 file:// URL）
    return nodeRequire(absPath) as Record<string, unknown>;
  }
  // dev：.ts 源码走 dynamic import（file:// URL 确保跨平台）
  const url = pathToFileUrl(absPath);
  return (await import(url)) as Record<string, unknown>;
}

/** 把绝对路径转为 file:// URL（跨平台） */
function pathToFileUrl(p: string): string {
  // node:url 的 pathToFileURL 处理跨平台（含空格/中文/Windows 盘符）
  // 这里手写最小实现避免引入 node:url（测试环境 POSIX 路径足够）
  return 'file://' + encodeURI(p.replace(/\\/g, '/'));
}
