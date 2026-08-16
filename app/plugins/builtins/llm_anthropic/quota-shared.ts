/**
 * quota-shared — 四渠道 coding plan 额度查询共享 helper（v0.0.350 决策③⑨）
 * 参考: specs/tech/version_logs/v0.0.350/change_plan.md 决策③（查询域推导）/决策⑨（防御解析）
 *       specs/research/v0.0.350-live-verify.md（四渠道实测背书）
 *       specs/research/v0.0.350-coding-plans-balance-query.md（cc-switch 对照移植）
 *
 * 纯函数（deriveQuotaBaseUrl/parseNum/parseResetTime/classifyQuotaError）+ 统一 fetch（fetchQuotaRaw）。
 * 解析器与 HTTP 分离：各 provider-*.ts 的 parse* 可独立单测。
 */
import type { ProviderName, QuotaError } from '../../../server/src/llm/provider-types';

/** 查询超时（决策⑦：15s AbortSignal.timeout） */
const QUOTA_TIMEOUT_MS = 15_000;

/**
 * 查询域 baseUrl 推导（决策③，照抄 cc-switch detect_provider 子串匹配）。
 * 用户改 baseUrl 后查询域随推导（PRD UC-2）：
 * - kimi：baseUrl 原样（保留 /coding 前缀语义，去尾斜杠后拼 /v1/usages）
 * - glm：含 bigmodel.cn → https://open.bigmodel.cn；否则 https://api.z.ai（国际站）
 * - minimax：含 minimax.io → https://api.minimax.io（国际站）；否则 https://api.minimaxi.com
 * - deepseek：取 baseUrl origin（自定义代理只换 host 不换 path 语义）
 * - 其他（anthropic_compatible 等无额度能力）：原样返回（caller 不会走到）
 */
export function deriveQuotaBaseUrl(implId: ProviderName | string, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  switch (implId) {
    case 'kimi_coding_plan':
      return trimmed;
    case 'glm_coding_plan':
      return baseUrl.includes('bigmodel.cn') ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
    case 'minimax_coding_plan':
      return baseUrl.includes('minimax.io') ? 'https://api.minimax.io' : 'https://api.minimaxi.com';
    case 'deepseek_api':
      try {
        return new URL(baseUrl).origin;
      } catch {
        return trimmed;
      }
    default:
      return trimmed;
  }
}

/** 数值字段兼容解析（kimi/deepseek 实测全字符串；number 直通；非法/缺失 → undefined） */
export function parseNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 重置时间归一 → ISO 字符串（cc-switch extract_reset_time 同款秒/毫秒判定）：
 * - ISO 字符串 → 原样返回（有效性校验：Date.parse 可解析）
 * - number/数字字符串 → <1e12 判秒、否则毫秒 → ISO
 * - 缺失/非法 → undefined（前端显示「--」）
 */
export function parseResetTime(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : v;
  }
  const n = parseNum(v);
  if (n === undefined || n <= 0) return undefined;
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

/** 业务层错误（glm success=false / minimax base_resp.status_code!=0 / 响应缺关键段） */
export class QuotaBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaBusinessError';
  }
}

/** HTTP 状态语义错误（fetchQuotaRaw 内部用；401/403 → auth） */
class QuotaHttpError extends Error {
  readonly kind: 'auth' | 'business';
  constructor(kind: 'auth' | 'business', message: string) {
    super(message);
    this.name = 'QuotaHttpError';
    this.kind = kind;
  }
}

/** 任意异常 → QuotaError 归一（impl catch 后作 snapshot.error；聚合端点兜底复用） */
export function classifyQuotaError(e: unknown): QuotaError {
  if (e instanceof QuotaHttpError) return { kind: e.kind, message: e.message };
  if (e instanceof QuotaBusinessError) return { kind: 'business', message: e.message };
  if (e instanceof Error) {
    // AbortSignal.timeout → DOMException name 'TimeoutError'
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { kind: 'timeout', message: '查询超时（15s）' };
    }
    // fetch 网络层失败（DNS/连接拒绝等）抛 TypeError
    if (e instanceof TypeError) {
      return { kind: 'network', message: `网络错误: ${e.message}` };
    }
    return { kind: 'business', message: e.message };
  }
  return { kind: 'business', message: String(e) };
}

/**
 * 统一额度端点 fetch（GET + JSON）。
 * @param url    完整查询 URL（deriveQuotaBaseUrl + 各渠道 path）
 * @param apiKey 凭证 key（缺失由 caller 前置校验）
 * @param auth   'bearer'（kimi/minimax/deepseek）| 'raw'（glm 裸 api_key，实测特殊无 Bearer 前缀）
 * @throws QuotaHttpError（401/403→auth「凭证已失效」；其他非 2xx→business）/ timeout / network
 */
export async function fetchQuotaRaw(
  url: string,
  apiKey: string,
  auth: 'bearer' | 'raw',
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: auth === 'bearer' ? `Bearer ${apiKey}` : apiKey,
  };
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS) });
  if (resp.status === 401 || resp.status === 403) {
    throw new QuotaHttpError('auth', '凭证已失效（401/403），请检查 API Key');
  }
  if (!resp.ok) {
    throw new QuotaHttpError('business', `HTTP ${resp.status}: ${await safeText(resp)}`);
  }
  try {
    return await resp.json();
  } catch {
    throw new QuotaBusinessError('额度端点响应非 JSON');
  }
}

/** 读响应文本（截断防超大错误页） */
async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return '';
  }
}
