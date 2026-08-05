/**
 * see_image 工具单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §4/§4.2/§4.3
 *       specs/prd/version_logs/v0.0.141.see_img/change_log.md SI-2/SI-3
 *
 * 覆盖（acceptance）：
 *   - SI-3：未配置三分支（app_config.see_image 缺失/data.type 未配置 → 分支1；type 对应 impl
 *     未激活 → 分支2；isAvailable=false → 分支3）
 *   - 路径校验（tool 层，仅 stat + 扩展名判断）：imagePaths 空/非数组、路径不存在、非图片格式、
 *     相对路径经 ctx.workdir resolve 成绝对路径后透传给 provider.understand
 *   - 多图有序：imagePaths 顺序原样透传给 understand（绝对路径数组）
 *   - understand 抛错（含 SI-2 zhipu 单图约束这类 provider 侧异常）→ isError 含 provider label
 *   - 硬约束：出参（ToolRunResult）不含 base64/图片二进制——全部 content block 为 text 类型，
 *     序列化文本不含裸 base64 特征串
 *
 * mock PluginManager + AppConfigService + provider（白盒，不调真实 HTTP / 真实 plugin manager）。
 * 文件系统隔离：临时目录用 os.tmpdir()+mkdtempSync，afterEach 清理，不碰真实 DATA_DIR。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionPoint } from '../../../plugin/extension-point';
import { seeImageTool, serializeResult } from '../tool';
import type { SeeImageCfg, SeeImageProvider, SeeImageResult } from '../types';
import type { ToolCtx, ToolInput } from '../../types';

// ---- mock PluginManager（getExtensionImpls 返回注入的 provider 列表） ----
interface MockPluginManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getExtensionImpls(point: ExtensionPoint): any[];
}

/** AppConfigService 鸭子类型 mock */
interface MockAppConfig {
  get(group: string, key: string): unknown;
}

/** app_config.see_image.default 数据形状 */
interface SiConfigData {
  type?: string;
  credentials?: Record<string, Record<string, unknown>>;
}

/** 构造 mock ctx，注入 pluginManager + appConfig + workdir */
function makeCtx(
  pm: MockPluginManager | undefined,
  appConfig: MockAppConfig | undefined,
  workdir: string,
): ToolCtx {
  return {
    config: {
      tools: [seeImageTool],
      pluginManager: pm,
      appConfig,
    },
    workdir,
  };
}

/** 构造 mock AppConfigService.get */
function makeAppConfig(data: SiConfigData | undefined): MockAppConfig {
  return {
    get: (group: string, key: string) =>
      group === 'see_image' && key === 'default' ? data : undefined,
  };
}

/** 构造 mock provider */
function makeProvider(over: Partial<SeeImageProvider> = {}): SeeImageProvider {
  return {
    id: 'mock',
    label: 'Mock Provider',
    isAvailable: () => true,
    understand: vi.fn(async (text: string, imagePaths: string[]) => ({
      provider: 'mock',
      text: `understood: ${text} (${imagePaths.length} images)`,
      count: imagePaths.length,
      tookMs: 1,
    })),
    ...over,
  };
}

// ---- 临时目录 + 图片 fixture（文件系统隔离：os.tmpdir()，afterEach 清理） ----
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'see-image-ut-'));
  tmpDirs.push(dir);
  return dir;
}

function writeImage(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // 假 png 字节头，仅测扩展名/存在性
  return p;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ============================================================
// SI-3：未配置三分支
// ============================================================
describe('SI-3: 未配置三分支（均 isError，不静默回退）', () => {
  it('app_config.see_image 缺失 → isError「未配置 vender type」', async () => {
    const workdir = makeTmpDir();
    const pm: MockPluginManager = { getExtensionImpls: () => [makeProvider({ id: 'minimax_m3' })] };
    const res = await seeImageTool.run(
      { text: 'q', imagePaths: [writeImage(workdir, 'a.png')] } as ToolInput,
      makeCtx(pm, undefined, workdir),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('未配置 vender type');
  });

  it('data.type 未配置（appConfig.get 返 undefined type）→ isError「未配置 vender type」', async () => {
    const workdir = makeTmpDir();
    const pm: MockPluginManager = { getExtensionImpls: () => [makeProvider({ id: 'minimax_m3' })] };
    const appConfig = makeAppConfig({ credentials: {} });
    const res = await seeImageTool.run(
      { text: 'q', imagePaths: [writeImage(workdir, 'a.png')] } as ToolInput,
      makeCtx(pm, appConfig, workdir),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('未配置 vender type');
  });

  it('type 对应 impl 未激活（list EP 中找不到匹配 id）→ isError 同分支1文案', async () => {
    const workdir = makeTmpDir();
    const pm: MockPluginManager = { getExtensionImpls: () => [makeProvider({ id: 'minimax_m3' })] };
    const appConfig = makeAppConfig({ type: 'not_installed', credentials: {} });
    const res = await seeImageTool.run(
      { text: 'q', imagePaths: [writeImage(workdir, 'a.png')] } as ToolInput,
      makeCtx(pm, appConfig, workdir),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('未配置 vender type');
  });

  it('isAvailable(cfg)===false（key 空）→ isError「不可用（凭证未配置?）」', async () => {
    const workdir = makeTmpDir();
    const minimax = makeProvider({
      id: 'minimax_m3',
      label: 'MiniMax · M3（多图视觉理解）',
      isAvailable: (cfg: SeeImageCfg) => typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0,
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [minimax] };
    const appConfig = makeAppConfig({ type: 'minimax_m3', credentials: { minimax_m3: {} } });
    const res = await seeImageTool.run(
      { text: 'q', imagePaths: [writeImage(workdir, 'a.png')] } as ToolInput,
      makeCtx(pm, appConfig, workdir),
    );
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('MiniMax · M3');
    expect(text).toContain('不可用');
    expect(text).toContain('凭证未配置');
    expect(minimax.understand).not.toHaveBeenCalled();
  });
});

// ============================================================
// 路径校验（tool 层，仅 stat + 扩展名判断，不读文件内容）
// ============================================================
describe('路径校验（resolveImagePaths）', () => {
  function activeCtx(workdir: string): { ctx: ToolCtx; provider: SeeImageProvider } {
    const provider = makeProvider({ id: 'minimax_m3', label: 'MiniMax · M3' });
    const pm: MockPluginManager = { getExtensionImpls: () => [provider] };
    const appConfig = makeAppConfig({ type: 'minimax_m3', credentials: { minimax_m3: { apiKey: 'k' } } });
    return { ctx: makeCtx(pm, appConfig, workdir), provider };
  }

  it('imagePaths 非数组 → isError「imagePaths is required」', async () => {
    const workdir = makeTmpDir();
    const { ctx } = activeCtx(workdir);
    const res = await seeImageTool.run({ text: 'q', imagePaths: 'not-array' } as unknown as ToolInput, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('imagePaths is required');
  });

  it('imagePaths 空数组 → isError「imagePaths is required」', async () => {
    const workdir = makeTmpDir();
    const { ctx } = activeCtx(workdir);
    const res = await seeImageTool.run({ text: 'q', imagePaths: [] } as ToolInput, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('imagePaths is required');
  });

  it('路径不存在 → isError「图片路径不存在或不可读」含路径', async () => {
    const workdir = makeTmpDir();
    const { ctx, provider } = activeCtx(workdir);
    const missing = path.join(workdir, 'no-such-file.png');
    const res = await seeImageTool.run({ text: 'q', imagePaths: [missing] } as ToolInput, ctx);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('图片路径不存在或不可读');
    expect(text).toContain(missing);
    expect(provider.understand).not.toHaveBeenCalled();
  });

  it('非图片格式（.txt）→ isError「不支持的图片格式」', async () => {
    const workdir = makeTmpDir();
    const { ctx, provider } = activeCtx(workdir);
    const txtPath = path.join(workdir, 'notes.txt');
    fs.writeFileSync(txtPath, 'hello');
    const res = await seeImageTool.run({ text: 'q', imagePaths: [txtPath] } as ToolInput, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('不支持的图片格式');
    expect(provider.understand).not.toHaveBeenCalled();
  });

  it('相对路径经 ctx.workdir resolve 成绝对路径 → understand 收到绝对路径', async () => {
    const workdir = makeTmpDir();
    writeImage(workdir, 'rel.png');
    const { ctx, provider } = activeCtx(workdir);
    const res = await seeImageTool.run({ text: 'q', imagePaths: ['rel.png'] } as ToolInput, ctx);
    expect(res.isError).toBe(false);
    const args = (provider.understand as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const absPaths = args[1] as string[];
    expect(absPaths).toEqual([path.join(workdir, 'rel.png')]);
    expect(path.isAbsolute(absPaths[0]!)).toBe(true);
  });
});

// ============================================================
// 多图有序 + cfg 透传
// ============================================================
describe('多图有序 + provider 调用', () => {
  it('多图 imagePaths 顺序原样透传给 understand（绝对路径数组）', async () => {
    const workdir = makeTmpDir();
    const p1 = writeImage(workdir, 'b.jpg');
    const p2 = writeImage(workdir, 'a.png');
    const p3 = writeImage(workdir, 'c.webp');
    const provider = makeProvider({ id: 'minimax_m3', label: 'MiniMax · M3' });
    const pm: MockPluginManager = { getExtensionImpls: () => [provider] };
    const appConfig = makeAppConfig({ type: 'minimax_m3', credentials: { minimax_m3: { apiKey: 'k' } } });
    const res = await seeImageTool.run(
      { text: 'what are these?', imagePaths: [p1, p2, p3] } as ToolInput,
      makeCtx(pm, appConfig, workdir),
    );
    expect(res.isError).toBe(false);
    const args = (provider.understand as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[0]).toBe('what are these?');
    expect(args[1]).toEqual([p1, p2, p3]); // 顺序保留，不重排
  });

  it('cfg 从 credentials[type] 透传给 isAvailable + understand', async () => {
    const workdir = makeTmpDir();
    const img = writeImage(workdir, 'a.png');
    const provider = makeProvider({
      id: 'zhipu_image',
      label: '智谱 · GLM 视觉（单图）',
      isAvailable: vi.fn((cfg: SeeImageCfg) => typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [provider] };
    const appConfig = makeAppConfig({ type: 'zhipu_image', credentials: { zhipu_image: { apiKey: 'zk' } } });
    const res = await seeImageTool.run(
      { text: 'q', imagePaths: [img] } as ToolInput,
      makeCtx(pm, appConfig, workdir),
    );
    expect(res.isError).toBe(false);
    const availArgs = (provider.isAvailable as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((availArgs[0] as SeeImageCfg).apiKey).toBe('zk');
    const understandArgs = (provider.understand as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((understandArgs[2] as SeeImageCfg).apiKey).toBe('zk');
  });
});

// ============================================================
// 错误分支：understand 抛错（含 SI-2 zhipu 单图约束这类 provider 侧异常）
// ============================================================
describe('错误分支：understand 抛错', () => {
  it('understand 抛错 → isError 含 provider label + 错误信息', async () => {
    const workdir = makeTmpDir();
    const img = writeImage(workdir, 'a.png');
    const provider = makeProvider({
      id: 'minimax_m3',
      label: 'MiniMax · M3（多图视觉理解）',
      understand: vi.fn(async () => {
        throw new Error('upstream 500');
      }),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [provider] };
    const appConfig = makeAppConfig({ type: 'minimax_m3', credentials: { minimax_m3: { apiKey: 'k' } } });
    const res = await seeImageTool.run(
      { text: 'q', imagePaths: [img] } as ToolInput,
      makeCtx(pm, appConfig, workdir),
    );
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('MiniMax · M3');
    expect(text).toContain('upstream 500');
  });

  it('SI-2 类：understand 抛「仅支持 1 张图片」错误 → isError 透传该文案', async () => {
    const workdir = makeTmpDir();
    const p1 = writeImage(workdir, 'a.png');
    const p2 = writeImage(workdir, 'b.png');
    const provider = makeProvider({
      id: 'zhipu_image',
      label: '智谱 · GLM 视觉（单图）',
      understand: vi.fn(async (_text: string, imagePaths: string[]) => {
        if (imagePaths.length !== 1) {
          throw new Error(`智谱视觉 vender 仅支持 1 张图片，当前传入 ${imagePaths.length} 张`);
        }
        return { provider: 'zhipu_image', text: 'ok', count: 1, tookMs: 1 };
      }),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [provider] };
    const appConfig = makeAppConfig({ type: 'zhipu_image', credentials: { zhipu_image: { apiKey: 'k' } } });
    const res = await seeImageTool.run(
      { text: 'q', imagePaths: [p1, p2] } as ToolInput,
      makeCtx(pm, appConfig, workdir),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('仅支持 1 张图片，当前传入 2 张');
  });
});

// ============================================================
// 硬约束：出参不含 base64/图片二进制
// ============================================================
describe('硬约束：出参不含 base64', () => {
  it('ToolRunResult 全部 content block 为 text 类型，序列化文本不含裸 base64 特征串', async () => {
    const workdir = makeTmpDir();
    const img = writeImage(workdir, 'a.png');
    const provider = makeProvider({ id: 'minimax_m3', label: 'MiniMax · M3' });
    const pm: MockPluginManager = { getExtensionImpls: () => [provider] };
    const appConfig = makeAppConfig({ type: 'minimax_m3', credentials: { minimax_m3: { apiKey: 'k' } } });
    const res = await seeImageTool.run(
      { text: 'q', imagePaths: [img] } as ToolInput,
      makeCtx(pm, appConfig, workdir),
    );
    expect(res.isError).toBe(false);
    expect(res.content.every((b) => b.type === 'text')).toBe(true);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('base64');
    // 粗粒度守卫：不含超长 base64 字符特征串（>=100 连续 base64 字符）
    expect(/[A-Za-z0-9+/]{100,}={0,2}/.test(serialized)).toBe(false);
  });
});

// ============================================================
// serializeResult
// ============================================================
describe('serializeResult', () => {
  it('markdown 形态含 provider/count/took + text 正文', () => {
    const md = serializeResult({
      provider: 'minimax_m3',
      text: '图中是一只猫',
      count: 1,
      tookMs: 500,
    } as SeeImageResult);
    expect(md).toContain('## Understanding');
    expect(md).toContain('minimax_m3');
    expect(md).toContain('图中是一只猫');
  });

  it('无理解结果（text 空串）→ 「（无理解结果）」', () => {
    const md = serializeResult({ provider: 'p', text: '', count: 0, tookMs: 1 } as SeeImageResult);
    expect(md).toContain('（无理解结果）');
  });
});
