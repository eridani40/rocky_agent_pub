/**
 * see_image 工具（本地图片路径 + 文字提问 → 视觉理解文字结果）
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §4
 *       specs/api/overall/08a-see-image-tool.md §2.2（ToolDefinition + isError 分支表）
 *       specs/tech/config/[P0]app_config.md（see_image group 照 web_search 类比）
 *
 * 与 web-search/tool.ts 完全同构（范式蓝本）：
 * resolveProvider 读 ctx.config.appConfig.get("see_image","default") →
 * 按 data.type 在 list EP 中精确匹配 impl（不取首个、不静默回退）→
 * 构造 cfg = credentials[type] ?? {} 透传给 isAvailable / understand。
 *
 * 硬约束：base64/图片二进制绝不进 tool 入参或出参。tool 层只做 ctx.workdir 路径 resolve +
 * stat/扩展名校验（resolveImagePaths），**不读文件内容**——读文件→base64 只发生在
 * provider.understand() 内部（vender 出站传输环节）。
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ExtensionPoint } from '../../plugin/extension-point';
import { SeeImageProviderPoint } from '../../plugin/extension-point';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult, textResult } from '../types';
import { truncate, wrapExternalContent, WEB_TOOLS_MAX_CHARS } from '../web-tools-utils';
import type { SeeImageCfg, SeeImageProvider, SeeImageResult } from './types';

/** 支持的图片扩展名（小写，须与 provider media_type 推断一致） */
const SUPPORTED_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/** see_image 输入形状 */
interface SeeImageInput {
  text?: unknown;
  imagePaths?: unknown;
}

/** app_config.see_image.default 的最小形状（resolveProvider 用） */
interface SeeImageConfigData {
  type?: string;
  credentials?: Record<string, Record<string, unknown>>;
}

/** AppConfigService 鸭子类型（仅需 get(group, key)） */
interface AppConfigLike {
  get(group: string, key: string): unknown;
}

/** PluginManager 鸭子类型（仅需 getExtensionImpls） */
interface PluginManagerLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getExtensionImpls<T = any>(point: ExtensionPoint): T[];
}

/**
 * see_image 工具（单例导出，registry defaultTools 引用）。
 * 从 ctx.config.appConfig 读 see_image.default → 按 type 在
 * ctx.config.pluginManager.getExtensionImpls(SeeImageProviderPoint) 中精确路由。
 */
export const seeImageTool: Tool = {
  definition: {
    name: 'see_image',
    description:
      'Understand local image(s). Input a question + local image paths (relative to workspace or absolute); returns a text understanding. Multiple images are ordered. Never pass base64 — pass file paths.',
    intro: 'Understand local image(s) from file paths.',
    inputSchema: {
      type: 'object',
      required: ['text', 'imagePaths'],
      properties: {
        text: { type: 'string', description: 'question / instruction about the image(s)' },
        imagePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'local image file paths (ordered; relative to workspace or absolute). Never base64.',
        },
      },
    },
  },
  // 视觉理解较慢（多图 base64 出站 + 模型推理），高于普通 web 工具 30s
  defaultTimeoutMs: 90000,

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    // 1. 解析 provider + cfg（按 app_config.type 精确路由；不取首个、不静默回退）
    const { provider, cfg } = resolveProvider(ctx);
    if (!provider) {
      return errorResult('see_image 未配置 vender type（app_config.see_image 缺失或 type 未配置）');
    }
    // 2. isAvailable 校验（凭证是否配置；禁 I/O，精确报错不静默换 vender）
    if (!provider.isAvailable(cfg)) {
      return errorResult(`vender ${provider.label} 不可用（凭证未配置?）`);
    }

    // 3. 解析输入 + 校验 imagePaths（非空字符串数组）
    const typed = input as SeeImageInput;
    const text = typeof typed.text === 'string' ? typed.text : '';
    const rawPaths = typed.imagePaths;
    if (
      !Array.isArray(rawPaths) ||
      rawPaths.length === 0 ||
      !rawPaths.every((p) => typeof p === 'string' && p.length > 0)
    ) {
      return errorResult('see_image: imagePaths is required（非空本地路径数组）');
    }
    const imagePaths = rawPaths as string[];

    // 4. 路径 resolve + 校验（tool 层，不读文件内容→base64）
    const resolved = await resolveImagePaths(imagePaths, ctx.workdir);
    if ('error' in resolved) {
      return errorResult(resolved.error);
    }

    // 5. 执行视觉理解（透传 cfg + ctx.signal；base64 只在 provider 内部产生）
    let result: SeeImageResult;
    try {
      result = await provider.understand(text, resolved.absPaths, cfg, ctx.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`see_image provider "${provider.label}" 调用失败: ${msg}`);
    }

    // 6. 序列化 markdown + wrapExternalContent（untrusted）+ 截断
    const body = serializeResult(result);
    const wrapped = wrapExternalContent(body);
    return textResult(truncate(wrapped, WEB_TOOLS_MAX_CHARS));
  },
};

/**
 * 从 ctx.config.appConfig + pluginManager 解析 see_image provider + cfg。
 * 按 app_config.see_image.default.data.type 在 list EP 中精确匹配 impl；
 * type 未配置 / impl 不存在 → 返 { cfg }（provider undefined）。
 * 不静默回退其他 impl，不取 list EP 首个。
 *
 * @returns `{ provider?, cfg }`：provider 为匹配到的 impl；cfg = credentials[type] ?? {}
 */
function resolveProvider(ctx: ToolCtx): {
  provider?: SeeImageProvider;
  cfg: SeeImageCfg;
} {
  // 1. 读 app_config.see_image.default
  const appConfig = ctx.config.appConfig as AppConfigLike | undefined;
  if (!appConfig || typeof appConfig.get !== 'function') return { cfg: {} };
  const siConfig = appConfig.get('see_image', 'default') as SeeImageConfigData | undefined;
  if (!siConfig || !siConfig.type) return { cfg: {} };

  // 2. 取 list EP 全部 impl
  const pm = ctx.config.pluginManager as PluginManagerLike | undefined;
  if (!pm || typeof pm.getExtensionImpls !== 'function') return { cfg: {} };
  const impls = pm.getExtensionImpls<SeeImageProvider>(SeeImageProviderPoint);

  // 3. 按 type 精确匹配 impl.id（不取首个、不回退）
  const provider = impls.find((p) => p.id === siConfig.type);
  if (!provider) return { cfg: {} };

  // 4. cfg = credentials[type] ?? {}（透传给 isAvailable / understand）
  return { provider, cfg: siConfig.credentials?.[siConfig.type] ?? {} };
}

/**
 * 逐路径 resolve + 校验（tool 层，仅 stat + 扩展名判断，不读文件内容）。
 * - 相对路径经 workdir resolve 成绝对路径；LLM 直接给绝对路径也兼容。
 * - 校验文件存在 + 是文件 + 扩展名 ∈ SUPPORTED_IMAGE_EXT。
 * - 任一路径校验失败即短路返回 error（不继续校验后续路径）。
 *
 * @returns `{ absPaths }` 全部通过；`{ error }` 首个失败的错误消息
 */
async function resolveImagePaths(
  imagePaths: string[],
  workdir: string,
): Promise<{ absPaths: string[] } | { error: string }> {
  const absPaths: string[] = [];
  for (const p of imagePaths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(workdir, p);
    let isFile: boolean;
    try {
      const st = await fsp.stat(abs);
      isFile = st.isFile();
    } catch {
      return { error: `see_image: 图片路径不存在或不可读: ${p}` };
    }
    if (!isFile) {
      return { error: `see_image: 图片路径不存在或不可读: ${p}` };
    }
    const ext = path.extname(abs).toLowerCase();
    if (!SUPPORTED_IMAGE_EXT.includes(ext)) {
      return { error: `see_image: 不支持的图片格式: ${p}（支持 png/jpg/jpeg/gif/webp）` };
    }
    absPaths.push(abs);
  }
  return { absPaths };
}

/**
 * 序列化 SeeImageResult 为 markdown。
 * 形态（08a-see-image-tool.md §2.2）：
 *   ## Understanding (provider, count, took)
 *   <text>
 */
export function serializeResult(res: SeeImageResult): string {
  const lines: string[] = [];
  lines.push(
    `## Understanding (provider: ${res.provider}, count: ${res.count}, took: ${res.tookMs}ms)`,
  );
  lines.push('');
  lines.push(res.text || '（无理解结果）');
  return lines.join('\n');
}
