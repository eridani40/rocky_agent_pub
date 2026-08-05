/**
 * caller 子模块共享的 config / 事件类型
 * 参考: specs/tech/agent/llm_caller/[P0]llm_request_config.md §1.2 + §2
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md（StreamEvent）
 *
 * RetryConfig / TimeoutConfig re-export 自 LlmRequestConfig（config/llm_request_config.ts，权威源）。
 * DEFAULT_TIMEOUT_CONFIG / DEFAULT_RETRY_CONFIG 从 DEFAULT_LLM_REQUEST_CONFIG 派生，
 * watchdog.ts / retry_backoff.ts 经本文件的 re-export import（路径稳定）。
 */
export type { RetryConfig, TimeoutConfig } from '../../config/llm_request_config';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../config/llm_request_config';
import type { TimeoutConfig, RetryConfig } from '../../config/llm_request_config';

/** 默认超时配置（从 DEFAULT_LLM_REQUEST_CONFIG.timeout 派生；spec §2.1 / reqs.md §6）。 */
export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  ...DEFAULT_LLM_REQUEST_CONFIG.timeout,
};

/** 默认重试配置（从 DEFAULT_LLM_REQUEST_CONFIG.retry 派生；spec §1.3）。 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  ...DEFAULT_LLM_REQUEST_CONFIG.retry,
};

/**
 * SSE chunk 解析后的统一事件流（与 protocol.ts StreamEvent 对齐）。
 * 阶段感知 stall（§2.2）按事件类型切换 stall 阈值。
 */
export type WatchdogStreamEvent =
  | { type: 'text_delta' }
  | { type: 'thinking_delta' }
  | { type: 'tool_call_delta' }
  | { type: 'usage' }
  | { type: 'finish' }
  | { type: 'error' };
