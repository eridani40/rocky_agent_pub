/**
 * MinimaxSeeImageProvider —— MiniMax-M3 anthropic 兼容端点，多图有序视觉理解
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §5.1
 *       tests/e2e/vision_check.py（endpoint/headers/body 形 · MiniMax-M3 anthropic 端点实测蓝本）
 *
 * EP: see_image_provider（list）。implId=minimax_m3。
 * 端点/模型/温度/max_tokens 全写死在本文件内，不做配置项、不挂平台 LlmClient/provider/
 * encodeAnthropicMessages（req 裁决——仅借「base64 image block 结构」知识，轻量自拼 body）。
 * 出站走 proxyFetch（统一代理层，同 zhipu_web_search/zhipu-api-provider.ts 骨架）。
 */
import type {
  SeeImageCfg,
  SeeImageProvider,
  SeeImageResult,
} from '../../../server/src/tools/see-image/types';
import { proxyFetch } from '../../../server/src/tools/web-fetch/proxy';
import { inferMediaType, readImageAsBase64 } from './image-utils';

/** MiniMax anthropic 兼容端点（写死，见 see_image_tool §5.1） */
const MINIMAX_ENDPOINT = 'https://api.minimaxi.com/anthropic/v1/messages';
/** 写死模型（仅 M3 支持 vision） */
const MINIMAX_MODEL = 'MiniMax-M3';
/** 写死温度 */
const MINIMAX_TEMPERATURE = 1.0;
/** 写死 max_tokens（可调） */
const MINIMAX_MAX_TOKENS = 2048;
/** 请求超时 ms（视觉理解较慢，对齐 tool defaultTimeoutMs=90000） */
const REQUEST_TIMEOUT_MS = 90_000;

/** 从入参 cfg 解析 apiKey（唯一源，构造器 cfg 不用于凭证） */
function resolveApiKey(cfg: SeeImageCfg): string | undefined {
  const v = cfg.apiKey;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** anthropic content block 的最小化形状（响应解析用） */
interface AnthropicContentBlock {
  type?: unknown;
  text?: unknown;
}

/** anthropic messages 响应的最小化形状 */
interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
}

/**
 * MiniMax-M3 see_image provider（实现 SeeImageProvider 契约）。
 * 构造器签名 (implId, cfg)——PluginManager.instantiate 按 (implId, cfg) new；
 * 构造器 cfg 仅保留签名兼容，凭证从运行时入参 cfg 读（isAvailable/understand）。
 */
export default class MinimaxSeeImageProvider implements SeeImageProvider {
  /** implId（registry 登记，自识别） */
  readonly id: string;

  constructor(implId: string, _cfg: Record<string, unknown> = {}) {
    this.id = implId;
  }

  /** 展示名（配置 UI / 错误提示用） */
  get label(): string {
    return 'MiniMax · M3（多图视觉理解）';
  }

  /** 是否可用：只查入参 cfg.apiKey 非空（禁止 I/O） */
  isAvailable(cfg: SeeImageCfg = {}): boolean {
    return resolveApiKey(cfg) !== undefined;
  }

  /**
   * 执行视觉理解：按 imagePaths 顺序拼多个 base64 image block + text block →
   * POST anthropic 端点 → 取 content[] 中 type='text' 的文本拼接。
   */
  async understand(
    text: string,
    imagePaths: string[],
    cfg: SeeImageCfg = {},
    signal?: AbortSignal,
  ): Promise<SeeImageResult> {
    const apiKey = resolveApiKey(cfg);
    if (apiKey === undefined) {
      // 双保险：Tool 层应先 isAvailable 校验，这里防御性抛错
      throw new Error('MiniMax see_image provider 未配置 apiKey');
    }

    const startedAt = Date.now();
    // 按 imagePaths 顺序读图 → base64 image block（顺序即模型理解顺序）
    const imageBlocks: Array<{
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }> = [];
    for (const absPath of imagePaths) {
      const data = await readImageAsBase64(absPath);
      imageBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: inferMediaType(absPath), data },
      });
    }

    // 组合超时 signal（provider 90s）+ 透传 ctx.signal（任一触发即取消）
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    let res: Response;
    try {
      res = await proxyFetch(MINIMAX_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: MINIMAX_MAX_TOKENS,
          temperature: MINIMAX_TEMPERATURE,
          messages: [
            {
              role: 'user',
              // 多图有序：imageBlocks 按 imagePaths 顺序排在前，text block 收尾
              content: [...imageBlocks, { type: 'text', text }],
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
      throw new Error(`MiniMax see_image HTTP ${res.status}: ${await safeReadText(res)}`);
    }

    const json = (await res.json()) as AnthropicMessagesResponse;
    const understoodText = (json.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');

    return {
      provider: this.id,
      text: understoodText,
      count: imagePaths.length,
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
