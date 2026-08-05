/**
 * BuiltinLoader 单测（白盒）—— 扫描 app/plugins/builtins/&#42;/plugin.json + 校验目录名==id
 * 参考: specs/tech/plugin_system/builtin_plugins_directory（P0）§2/§3
 *       specs/tech/plugin_system/plugin_manager_interface（P0）§3.4（静态注册）
 *       states/v0.0.3/verify/test-plan.md §1（UT builtin-loader 目录名==id 一致性）
 *
 * 测试策略：在 tmp 目录构造 builtin 目录树 + 真实 .ts impl 模块文件，
 * 用 dynamic import 验证 loader 解析 manifest 后能取到 impl 类并登记入 registry。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Registry } from '../registry';
import { BuiltinLoader } from '../builtin-loader';
import { LlmProviderPoint, LlmProtocolPoint } from '../extension-point';

let tmpBuiltins: string;
let loader: BuiltinLoader;

beforeEach(() => {
  tmpBuiltins = fs.mkdtempSync(path.join(os.tmpdir(), 'builtins-'));
  loader = new BuiltinLoader(tmpBuiltins);
});

afterEach(() => {
  fs.rmSync(tmpBuiltins, { recursive: true, force: true });
});

/**
 * 在 tmp builtins 目录下构造一个 builtin plugin 目录 + manifest + impl 模块。
 * @param pluginId 目录名（必须 == manifest.id 才合法）
 * @param manifestId 写入 manifest 的 id
 * @param implFiles impl 模块文件名→内容（导出类）
 */
function makeBuiltin(
  pluginId: string,
  manifestId: string,
  implFiles: Record<string, string>,
): void {
  const dir = path.join(tmpBuiltins, pluginId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id: manifestId,
    extImpls: [
      { implId: `${pluginId}_provider`, point: 'llm_provider', impl: './provider.ts' },
      { implId: `${pluginId}_protocol`, point: 'llm_protocol', impl: './protocol.ts' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(implFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

describe('BuiltinLoader.loadAll — 目录名 == manifest.id 校验', () => {
  it('目录名与 manifest.id 一致 → 登记成功', async () => {
    makeBuiltin('llm_anthropic', 'llm_anthropic', {
      'provider.ts': 'export default class P { id = "p"; }\n',
      'protocol.ts': 'export default class Q { id = "q"; }\n',
    });
    const reg = new Registry();
    reg.registerExtensionPoint(LlmProviderPoint);
    reg.registerExtensionPoint(LlmProtocolPoint);
    await loader.loadAll(reg);
    expect(reg.getByPoint('llm_provider')).toHaveLength(1);
    expect(reg.getByPoint('llm_protocol')).toHaveLength(1);
    expect(reg.listPlugins()).toEqual(['llm_anthropic']);
  });

  it('目录名与 manifest.id 不一致 → 抛错拒绝登记（builtin §2.1 / §4.2）', async () => {
    makeBuiltin('dir_name', 'manifest_id', {
      'provider.ts': 'export default class P {}\n',
      'protocol.ts': 'export default class Q {}\n',
    });
    const reg = new Registry();
    await expect(loader.loadAll(reg)).rejects.toThrow(/dir_name|manifest_id/);
  });

  it('空 builtins 目录 → 无登记无报错', async () => {
    const reg = new Registry();
    await loader.loadAll(reg);
    expect(reg.listPlugins()).toEqual([]);
  });
});

describe('BuiltinLoader.loadAll — 多 builtin 同时登记', () => {
  it('两个 builtin 各贡献不同 point', async () => {
    makeBuiltin('a', 'a', {
      'provider.ts': 'export default class PA {}\n',
      'protocol.ts': 'export default class QA {}\n',
    });
    makeBuiltin('b', 'b', {
      'provider.ts': 'export default class PB {}\n',
      'protocol.ts': 'export default class QB {}\n',
    });
    const reg = new Registry();
    reg.registerExtensionPoint(LlmProviderPoint);
    reg.registerExtensionPoint(LlmProtocolPoint);
    await loader.loadAll(reg);
    expect(reg.getByPoint('llm_provider')).toHaveLength(2);
    expect(reg.getByPoint('llm_protocol')).toHaveLength(2);
    expect(reg.listPlugins().sort()).toEqual(['a', 'b']);
  });
});

describe('BuiltinLoader.loadAll — manifest schema 形状校验', () => {
  it('plugin.json 缺 id → 抛错', async () => {
    const dir = path.join(tmpBuiltins, 'bad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ extImpls: [] }),
    );
    fs.writeFileSync(path.join(dir, 'provider.ts'), 'export default class P {}\n');
    fs.writeFileSync(path.join(dir, 'protocol.ts'), 'export default class Q {}\n');
    const reg = new Registry();
    await expect(loader.loadAll(reg)).rejects.toThrow(/id/);
  });

  it('plugin.json 缺 extImpls → 抛错', async () => {
    const dir = path.join(tmpBuiltins, 'bad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'bad' }));
    fs.writeFileSync(path.join(dir, 'provider.ts'), 'export default class P {}\n');
    fs.writeFileSync(path.join(dir, 'protocol.ts'), 'export default class Q {}\n');
    const reg = new Registry();
    await expect(loader.loadAll(reg)).rejects.toThrow(/extImpls/);
  });
});

describe('BuiltinLoader.loadAll — 不实例化、不跑代码（plugin_manager §3.4）', () => {
  it('登记的是类引用（implClass 是构造器，未 new）', async () => {
    makeBuiltin('p1', 'p1', {
      'provider.ts': 'export default class P1Provider { static _instanced = false; }\n',
      'protocol.ts': 'export default class P1Protocol { static _instanced = false; }\n',
    });
    const reg = new Registry();
    reg.registerExtensionPoint(LlmProviderPoint);
    reg.registerExtensionPoint(LlmProtocolPoint);
    await loader.loadAll(reg);
    const providerEntry = reg.getByPoint('llm_provider')[0]!;
    // implClass 是类构造器（function），未实例化
    expect(typeof providerEntry.implClass).toBe('function');
  });
});

describe('BuiltinLoader — packaged .cjs 后缀 fallback（packaged_plugin_loading §3.5）', () => {
  /** 构造 packaged 形态：plugin.json impl 字段仍 .ts（唯一身份源），目录里放指定的 impl 文件 */
  function makeSingleImplBuiltin(id: string, implFileName: string, implContent: string): void {
    const dir = path.join(tmpBuiltins, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        id,
        // impl 字段永远保 .ts（manifest 唯一身份源，不因打包改写）
        extImpls: [{ implId: `${id}_impl`, point: 'llm_provider', impl: './provider.ts' }],
      }),
    );
    fs.writeFileSync(path.join(dir, implFileName), implContent);
  }

  it('impl 的 .ts 不存在 → fallback 换 .cjs，用 require 加载 CJS bundle 并登记', async () => {
    // packaged：目录里只有 .cjs 产物（无 .ts 源码）→ 触发后缀 fallback + require
    makeSingleImplBuiltin(
      'llm_anthropic',
      'provider.cjs',
      'module.exports = { default: class CjsProvider { static _tag = "cjs"; } };\n',
    );
    const reg = new Registry();
    reg.registerExtensionPoint(LlmProviderPoint);
    await loader.loadAll(reg);
    const entry = reg.getByPoint('llm_provider')[0]!;
    expect(typeof entry.implClass).toBe('function');
    // 确认取到的是 .cjs 里的类（require 分支生效，非 import .ts）
    expect((entry.implClass as { _tag?: string })._tag).toBe('cjs');
  });

  it('.ts 存在时优先用 .ts（dev），不 fallback .cjs（literal 优先）', async () => {
    // dev：.ts 与 .cjs 同时存在，必须用 .ts（literal 路径先命中）
    const dir = path.join(tmpBuiltins, 'p_dev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        id: 'p_dev',
        extImpls: [{ implId: 'x', point: 'llm_provider', impl: './provider.ts' }],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'provider.ts'),
      'export default class TsProvider { static _tag = "ts"; }\n',
    );
    fs.writeFileSync(
      path.join(dir, 'provider.cjs'),
      'module.exports = { default: class CjsProvider { static _tag = "cjs"; } };\n',
    );
    const reg = new Registry();
    reg.registerExtensionPoint(LlmProviderPoint);
    await loader.loadAll(reg);
    const entry = reg.getByPoint('llm_provider')[0]!;
    expect((entry.implClass as { _tag?: string })._tag).toBe('ts');
  });

  it('.cjs 也缺（.ts 和 .cjs 都不存在）→ 抛错（import 失败）', async () => {
    // impl 字段指向 provider.ts，但目录里既无 .ts 也无 .cjs → fallback 后 require 失败抛错
    const dir = path.join(tmpBuiltins, 'p_missing');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        id: 'p_missing',
        extImpls: [{ implId: 'x', point: 'llm_provider', impl: './provider.ts' }],
      }),
    );
    const reg = new Registry();
    reg.registerExtensionPoint(LlmProviderPoint);
    await expect(loader.loadAll(reg)).rejects.toThrow();
  });
});
