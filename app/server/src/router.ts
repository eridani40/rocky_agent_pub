/**
 * HTTP router — 主分发入口（v0.0.156 拆分后变薄）
 * 参考: specs/api/overall/01-counter.md §2.2 / §2.4（/counter 保留）
 *       specs/api/version_logs/v0.0.8/change_log.md §2-§4（session/message/sse 端点）
 *       specs/api/overall/02-llm-chat.md §5-§6（/config /provider 保留）
 *
 * v0.0.156 结构性拆分：路由组分发下沉到 routes/{session,squad,config,misc}-routes.ts，
 *   helper 抽到 routes/router-helpers.ts。主文件保留：handleRequest（api hook 包装）+
 *   dispatchRequestInternal（stub 包装）+ _dispatchRequestCore（依次 null-chain 4 个 dispatch 函数）。
 *
 * 职责：把 (method, path) 映射到 handler，构造标准 Response。
 *   - 4 个路由组分发：session / squad / config / misc（顺序对路径互斥的路由无影响）
 *   - test-only 端点（/test/*, /api/workspace/*, /session/:id/run）在路由组内 NODE_ENV!=='test' 返 404
 *   - 未匹配 → 404；已知路径方法错 → 405 + Allow
 *
 * INV-R-1：(method, path)→handler 映射等价（拆分前后行为一致）
 * INV-R-2：test-only 端点保留非测试 404 gate
 * INV-R-3：bootstrapCache 行为（同 dataDir 复用 Promise）等价
 *
 * packaged 护栏（INV-PKG-1/2）：本文件不读 process.env（仅 routes 内 test gate 读 NODE_ENV）；
 *   不拼接相对路径；dataDir 由 caller 展开绝对路径传入。
 */
import type { LogWriter } from './dev-logs/log-writer';
import {
  getBootstrap, json, isExcludedApiPath,
} from './routes/router-helpers';
import { dispatchSessionRoutes } from './routes/session-routes';
import { dispatchSquadRoutes } from './routes/squad-routes';
import { dispatchConfigRoutes } from './routes/config-routes';
import { dispatchMiscRoutes } from './routes/misc-routes';
// [v0.0.210] academy 路由组（在 squad 之后）
import { registerAcademyRoutes } from './routes/academy-routes';

/**
 * 处理单个 HTTP 请求。纯函数（除 store IO），便于单测直接调。
 * [v0.0.30] api hook（spec dev-logs §3.3）：记 http原文（raw text，不再 parse JSON）。dispatch 前
 *   clone 读请求体 raw、dispatch 后 clone 读响应体 raw，按开关写一条 logs/api.log。排除 /sse、/sse/*、
 *   /health。开关 false → 不 clone 不读 body（零开销）。整体 fail-silent：日志异常绝不影响响应；
 *   dispatch 无条件执行（不在日志 try 内）。
 * @param req 入站 Request
 * @param dataDir ${DATA_DIR} 绝对路径
 */
export async function handleRequest(req: Request, dataDir: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // [v0.0.30] api hook（spec dev-logs §3.3）：记 http原文（raw text），不再 parse JSON。
  // 关键：请求体必须在 dispatch 之前 clone 读取——dispatch 会消费 req body，之后 clone 为空（bug 修复）。
  // fail-silent：日志任何异常绝不影响响应；dispatch 无条件执行（不在日志 try 内）。
  let wantLog = false;
  let logWriter: LogWriter | undefined;
  let rawReqBody: string | undefined;
  try {
    const bs = await getBootstrap(dataDir);
    // [v0.0.89] logs.enableAppApiLog 自 dev_config 迁入 app_config（group/key 名零变更）。
    wantLog = bs.appConfig.get('logs', 'enableAppApiLog') === true && !isExcludedApiPath(path);
    if (wantLog) {
      logWriter = bs.logWriter;
      // dispatch 前 clone 读请求体 raw text（原 req 透传下游不受影响；body 一次性故须提前 clone）
      if (method !== 'GET' && method !== 'HEAD') {
        try { rawReqBody = await req.clone().text(); } catch { rawReqBody = undefined; }
      }
    }
  } catch {
    // 读开关/请求体失败 → 不记日志，不影响主流程
  }

  // 请求处理起点（dispatch 全程 RT，含 handler 执行）
  const start = Date.now();
  const response = await dispatchRequestInternal(req, dataDir);

  if (wantLog && logWriter) {
    try {
      // 响应体 raw text（clone 后读，原 response 透传调用方不受影响）
      let rawRespBody: string | undefined;
      try { rawRespBody = await response.clone().text(); } catch { rawRespBody = undefined; }
      logWriter.write('api', {
        method,
        path,
        status: response.status,
        durationMs: Date.now() - start,
        ...(rawReqBody !== undefined && rawReqBody !== '' ? { requestBody: rawReqBody } : {}),
        ...(rawRespBody !== undefined ? { responseBody: rawRespBody } : {}),
      });
    } catch {
      // 日志失败绝不影响响应主流程
    }
  }
  return response;
}

/**
 * 纯分发（不含 dev log）：dev log 在外层 handleRequest 统一收口
 * （return response 前写日志，避免每个 return 点重复）。
 *
 * 主体下沉到 _dispatchRequestCore（4 路由组 null-chain 分发）。
 */
async function dispatchRequestInternal(req: Request, dataDir: string): Promise<Response> {
  return await _dispatchRequestCore(req, dataDir);
}

/**
 * 主分发：依次调 4 个路由组 dispatch 函数（null 时继续下个组），全部未命中返 404。
 *
 * 路由组互斥：每个 (method, path) 至多匹配一个组（路径前缀不重叠）。
 * 顺序：misc → session → config → squad（与历史代码顺序保持一致；对互斥路径无影响）。
 *
 * INV-R-1：(method, path)→handler 映射等价（拆分前后行为一致）。
 */
async function _dispatchRequestCore(req: Request, dataDir: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  const bs = await getBootstrap(dataDir);

  // 路由组 null-chain：第一个命中即返回；全 null 落到 404
  const miscResp = await dispatchMiscRoutes(req, url, method, path, bs, dataDir);
  if (miscResp !== null) return miscResp;

  const sessionResp = await dispatchSessionRoutes(req, url, method, path, bs, dataDir);
  if (sessionResp !== null) return sessionResp;

  const configResp = await dispatchConfigRoutes(req, url, method, path, bs, dataDir);
  if (configResp !== null) return configResp;

  const squadResp = await dispatchSquadRoutes(req, method, path, bs, dataDir);
  if (squadResp !== null) return squadResp;

  // [v0.0.210] academy 路由组（在 squad 之后；bs.academyStore/trainingEngine 由 coder-A bootstrap 装配）
  // 装配未就绪（UT fixture / 旧 DATA_DIR 首启）→ 跳过，主分发继续 404
  if (bs.academyStore && bs.trainingEngine) {
    const academyResp = await registerAcademyRoutes(req, method, path, {
      academyStore: bs.academyStore,
      trainingEngine: bs.trainingEngine,
      agentManager: bs.agentManager,
      sessionStore: bs.store,
      appConfig: bs.appConfig,
      dataDir,
    });
    if (academyResp !== null) return academyResp;
  }

  return json(404, { error: 'Not Found' });
}
