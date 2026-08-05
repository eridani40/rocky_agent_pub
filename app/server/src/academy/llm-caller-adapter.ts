/**
 * llm-caller-adapter — 把生产 LlmClient 链包成 AcademyLlmPort（窄端口）
 * 参考: specs/tech/academy/[P0]training_engine.md §2（TrainingEngineDeps.llmPort 偏离决策）
 *       specs/tech/academy/[P0]evaluation.md §4（sample/grade 直调 LLM）
 *
 * 背景（coder 决策，对齐偏离项）：
 *   spec §2 写 `deps.llmCaller: LlmCaller`；LlmCaller.invoke 签名耦合 InvokeContext
 *   （observability/controller/errorState/providers/clientFactory 等生产路径字段）。
 *   academy 引擎的 sample/grade 是"纯文本输入/输出"快速调用，不依赖 agent loop ctx；
 *   强绑定会让 UT 必须造大量 mock。实现走窄端口 `deps.llmPort: AcademyLlmPort`，
 *   本文件提供生产 adapter 完成 LlmCaller 链 → AcademyLlmPort 适配。
 *
 * 实现：
 *   - 每次 invoke 按 (providerId, modelId) 走 buildLlmClient 现装 LlmClient
 *     （复用 app_config providers 解析 + pluginManager impl 路由 + mock fetch hook）
 *   - LlmClient.call 发单次非流式请求（不用 LlmCaller.invoke 全套 retry/降级——
 *     academy fan-out 由 pLimit 自身管控，引擎只关心"该 case 成败"）
 *   - 429/529/503 错误归一为 { ok: false, errorKind: 'rate_limited' }（引擎兜底标 score=-1）
 *   - 其他错误归一为 { ok: false, errorKind: 'other' }（引擎抛出 runTurn 失败）
 */
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import { buildLlmClient } from '../llm-client-factory';
import type { CanonicalRequest } from '../llm/protocol';
import type { AcademyLlmPort, AcademyLlmInvokeInput, AcademyLlmInvokeResult } from './training-engine/llm-port';

/** 从错误对象取 HTTP status（LlmHttpError 携带 numeric status；兜底 undefined） */
function extractHttpStatus(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/**
 * 生产 AcademyLlmPort 工厂（bootstrap 注入 TrainingEngine）。
 *
 * @param appConfig     app_config 服务（providers 组查找）
 * @param pluginManager plugin manager（provider/protocol impl 路由）
 */
export function createAcademyLlmPort(deps: {
  appConfig: AppConfigService;
  pluginManager: PluginManager;
}): AcademyLlmPort {
  return {
    async invoke(input: AcademyLlmInvokeInput): Promise<AcademyLlmInvokeResult> {
      // providerId 缺省时 buildLlmClient 会抛 ProviderNotFoundError（数据完整性问题，
      // 由 sample.ts 前置校验 modelId；providerId 兜底在调用方决定）
      if (!input.providerId) {
        return {
          ok: false,
          errorKind: 'other',
          errorMessage: 'academy llm-port: providerId is required (version.json.model.providerId missing)',
        };
      }
      try {
        const client = buildLlmClient(input.providerId, input.modelId, deps.appConfig, deps.pluginManager);
        const req: CanonicalRequest = {
          modelId: input.modelId,
          messages: [
            { role: 'system', content: [{ type: 'text', text: input.systemPrompt }] },
            { role: 'user', content: [{ type: 'text', text: input.userMessage }] },
          ],
          params: {},
        };
        const resp = await client.call(req);
        // ContentBlock 判别联合需 type predicate 才能 narrow 到 text 形
        const textBlock = resp.message.content.find(
          (b): b is { type: 'text'; text: string } => b.type === 'text',
        );
        const text = textBlock?.text ?? '';
        return { ok: true, text };
      } catch (e) {
        const status = extractHttpStatus(e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (status === 429 || status === 529 || status === 503) {
          return { ok: false, errorKind: 'rate_limited', errorMessage };
        }
        return { ok: false, errorKind: 'other', errorMessage };
      }
    },
  };
}
