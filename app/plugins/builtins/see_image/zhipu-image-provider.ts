/**
 * ZhipuSeeImageProvider —— 智谱 GLM 视觉 REST 直调，单图约束
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §5.2
 *       app/plugins/builtins/zhipu_web_search/zhipu-api-provider.ts（REST 直调骨架蓝本）
 *
 * EP: see_image_provider（list）。implId=zhipu_image。
 * 单图约束：understand 首行校验 imagePaths.length!==1 → throw（不静默截取/降级）。
 * 出站走 proxyFetch（统一代理层）。
 *
 * req 事实澄清：不走 zai-mcp（packaged 零风险取舍，见调研 §4.4），
 * 与现有 zhipu_web_search（web_search_provider）同骨架，REST 直调 GLM 视觉 API。
 */
import type {
  SeeImageCfg,
  SeeImageProvider,
  SeeImageResult,
} from '../../../server/src/tools/see-image/types';
import { proxyFetch } from '../../../server/src/tools/web-fetch/proxy';
import { inferMediaType, readImageAsBase64 } from './image-utils';

/** 智谱 GLM 视觉 REST 端点（写死，见 see_image_tool §5.2） */
const ZHIPU_VISION_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
/** 写死模型（若真 key 拒绝可换 GLM 视觉系模型名，用户自测） */
const ZHIPU_VISION_MODEL = 'glm-4.5v';
/** 请求超时 ms（对齐 tool defaultTimeoutMs=90000） */
const REQUEST_TIMEOUT_MS = 90_000;

/** 从入参 cfg 解析 apiKey（唯一源，构造器 cfg 不用于凭证） */
function resolveApiKey(cfg: SeeImageCfg): string | undefined {
  const v = cfg.apiKey;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** OpenAI 兼容 choices[].message 的最小化形状 */
interface ZhipuChatChoice {
  message?: { content?: unknown };
}

/** GLM chat/completions 响应的最小化形状 */
interface ZhipuChatResponse {
  choices?: ZhipuChatChoice[];
}

/**
 * 智谱 GLM 视觉 see_image provider（实现 SeeImageProvider 契约）。
 * 构造器签名 (implId, cfg)——PluginManager.instantiate 按 (implId, cfg) new；
 * 构造器 cfg 仅保留签名兼容，凭证从运行时入参 cfg 读（isAvailable/understand）。
 */
export default class ZhipuSeeImageProvider implements SeeImageProvider {
  /** implId（registry 登记，自识别） */
  readonly id: string;

  constructor(implId: string, _cfg: Record<string, unknown> = {}) {
    this.id = implId;
  }

  /** 展示名（配置 UI / 错误提示用） */
  get label(): string {
    return '智谱 · GLM 视觉（单图）';
  }

  /** 是否可用：只查入参 cfg.apiKey 非空（禁止 I/O） */
  isAvailable(cfg: SeeImageCfg = {}): boolean {
    return resolveApiKey(cfg) !== undefined;
  }

  /**
   * 执行视觉理解：单图约束（首行校验）→ 读图 base64 data URL →
   * POST GLM 视觉 REST（OpenAI 兼容多模态）→ 取 choices[0].message.content。
   */
  async understand(
    text: string,
    imagePaths: string[],
    cfg: SeeImageCfg = {},
    signal?: AbortSignal,
  ): Promise<SeeImageResult> {
    // 单图约束：首行校验，不静默截取/降级
    if (imagePaths.length !== 1) {
      throw new Error(`智谱视觉 vender 仅支持 1 张图片，当前传入 ${imagePaths.length} 张`);
    }

    const apiKey = resolveApiKey(cfg);
    if (apiKey === undefined) {
      // 双保险：Tool 层应先 isAvailable 校验，这里防御性抛错
      throw new Error('智谱 see_image provider 未配置 apiKey');
    }

    const startedAt = Date.now();
    const [imagePath] = imagePaths;
    const mediaType = inferMediaType(imagePath);
    const data = await readImageAsBase64(imagePath);
    const dataUrl = `data:${mediaType};base64,${data}`;

    // 组合超时 signal（provider 90s）+ 透传 ctx.signal（任一触发即取消）
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    let res: Response;
    try {
      res = await proxyFetch(ZHIPU_VISION_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: ZHIPU_VISION_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: combinedSignal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        noFollowRedirect: true,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`智谱 see_image HTTP ${res.status}: ${await safeReadText(res)}`);
    }

    const json = (await res.json()) as ZhipuChatResponse;
    const content = json.choices?.[0]?.message?.content;
    const understoodText = typeof content === 'string' ? content : '';

    return {
      provider: this.id,
      text: understoodText,
      count: 1,
      tookMs: Date.now() - startedAt,
    };
  }
}

/** 安全读响应文本（失败返空串，避免错误信息丢失） */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
