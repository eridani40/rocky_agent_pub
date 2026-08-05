/**
 * OpenAI 错误分类 adapter（仅占位）
 * 参考: specs/tech/agent/llm_caller/[P0]error_normalization.md §5
 *
 * 不实现 OpenAI error.code / error.type 完整映射列（仅 anthropic adapter 实现）。
 * 临时：HTTP status 兜底（401→AUTH_INVALID, 429→RATE_LIMITED, 5xx→SERVER_ERROR, 其他→BAD_REQUEST_OTHER）。
 *
 * 后续填映射列时主逻辑（classify / computeHints）不动（hermes 模式核心收益）。
 */
import { LlmErrorCategory, type ProviderErrorClassifier, type ProviderClassifyResult } from '../error_types';
import { asWireResponse, errMsg } from '../error_shape';
import { fallbackByHttpStatus } from '../error_classify';

/** OpenAI 占位分类器：仅 HTTP status 兜底，后续补 error.code 映射列 */
export class OpenAIErrorClassifier implements ProviderErrorClassifier {
  classifyProviderError(rawError: unknown): ProviderClassifyResult {
    const wire = asWireResponse(rawError);
    if (wire) return fallbackByHttpStatus(wire.status, wire.body);
    // TODO: OpenAI 流内 / 错误码专属映射
    return { category: LlmErrorCategory.NETWORK, message: errMsg(rawError) };
  }
}
