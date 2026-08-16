/**
 * config-routes — /config/* 路由组（kv-config / app-template / plugin / connectors / channels）
 *
 * 纯 move 自 router.ts（v0.0.156 结构性拆分）。路由顺序 + 前缀匹配逻辑 100% copy-paste。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.8 + INV-R-1 + R6（前缀冲突）
 *
 * **前缀匹配顺序（INV-R-1 关键 — 不可调换）**：
 *   1. /config/app/llm_request（必须在 /config/app 之前精确匹配）
 *   2. /config/app/sub_agent_templates（必须在 /config/app 之前精确匹配）
 *   3. /config/app
 *   4. /config/plugin/scopes[/...]（必须在 /config/plugin 之前匹配 — 前缀冲突 INV-R-1）
 *      + 二级分发：/activations 子路径走 handleScopeActivation
 *   5. /config/plugin
 *   6. /config/connectors[/:id]
 *   7. /config/channels[/:id]
 *
 * 未命中返 null，主分发继续尝试下一个路由组。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径。
 */
import type { BootstrapResult } from '../bootstrap';
import { json } from './router-helpers';
import {
  handleKvConfig,
  handleKvConfigPut,
  handleKvConfigDelete,
  handlePluginConfig,
} from '../handlers/config';
import {
  handleKvConfigAppTemplateDelete,
  handleKvConfigAppTemplatePut,
} from '../handlers/app-config-template-handlers';
import {
  handlePluginScopes,
  handleScopeActivation,
} from '../handlers/plugin-scope-handlers';
import { handleConnectorRoute } from '../handlers/connector';
import { handleChannelRoute } from '../handlers/channel';
import { ChannelConfigService } from '../channel/channel-config-service';
import {
  handleLlmRequestConfigGet,
  handleLlmRequestConfigPut,
} from '../handlers/llm_request_config';
import { LlmRequestConfigService } from '../config/llm_request_config';

/**
 * /config/* 路由组分发。命中返 Response；未命中返 null（主分发继续下个 group）。
 *
 * @param req      原始 Request
 * @param url      URL（query 参数透传）
 * @param method   HTTP method（大写）
 * @param path     pathname
 * @param bs       bootstrap 实例
 * @param dataDir  绝对路径
 */
export async function dispatchConfigRoutes(
  req: Request,
  url: URL,
  method: string,
  path: string,
  bs: BootstrapResult,
  dataDir: string,
): Promise<Response | null> {
  if (!path.startsWith('/config/')) {
    return null;
  }

  // [v0.0.25] /config/app/llm_request 先匹配（单实例 group，固定 schema + 缺省回退默认）
  if (path === '/config/app/llm_request') {
    const svc = new LlmRequestConfigService(bs.appConfig);
    if (method === 'GET') return handleLlmRequestConfigGet(svc);
    if (method === 'PUT') return handleLlmRequestConfigPut(req, svc);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'GET,PUT' });
  }
  // [v0.0.89] /config/app/sub_agent_templates 必须在 /config/app 之前精确匹配
  // （防前缀覆盖；PUT/DELETE 走专属 handler：builtin 保护 + group_not_deletable 守卫）。
  // GET 仍走通用 handleKvConfig（透传到 /config/app?group=sub_agent_templates）。
  if (path === '/config/app/sub_agent_templates') {
    if (method === 'PUT') return handleKvConfigAppTemplatePut(req, bs.appConfig);
    if (method === 'DELETE') return handleKvConfigAppTemplateDelete(req, bs.appConfig);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'PUT,DELETE' });
  }
  if (path === '/config/app') {
    if (method === 'GET') return handleKvConfig(req, 'GET', url, bs.appConfig);
    if (method === 'PUT') return handleKvConfigPut(req, bs.appConfig);
    // [v0.0.347] DELETE：方案库删除（group 白名单 + 引用解除；dataDir 供 SquadStore 扫描）
    if (method === 'DELETE') return handleKvConfigDelete(url, bs.appConfig, dataDir);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'GET,PUT,DELETE' });
  }
  // [v0.0.26] scope + 激活端点（v0.0.67 D4：写端点返 405，handler 层统一处理）
  // 必须在通用 /config/plugin 之前注册——/config/plugin/scopes 是 /config/plugin 的子路径，
  // 前缀匹配会冲突；这里精确/前缀分发。POST/DELETE 写请求透传到 handler 由其返 405。
  if (path === '/config/plugin/scopes' || path.startsWith('/config/plugin/scopes/')) {
    // 二级分发：activations 子路径走 handleScopeActivation；其余走 handlePluginScopes
    if (path.endsWith('/activations')) {
      return handleScopeActivation(req, method, path, bs.pluginConfigService);
    }
    return handlePluginScopes(req, method, path, bs.pluginConfigService);
  }
  if (path === '/config/plugin') {
    return handlePluginConfig(req, method, url, bs.pluginConfigService);
  }

  // [v0.0.23] /config/connectors（list）+ /config/connectors/:id（toggle）
  if (path === '/config/connectors' || path.startsWith('/config/connectors/')) {
    return handleConnectorRoute(req, method, path, bs.connectorManager);
  }

  // /config/channels（IM 渠道配置面 CRUD；多 instance + 凭证字段，与 connector 同款但扩展）
  if (path === '/config/channels' || path.startsWith('/config/channels/')) {
    if (!bs.channelManager) {
      return json(500, { error: 'channel manager not available' });
    }
    return handleChannelRoute(req, method, path, {
      channelManager: bs.channelManager,
      // ChannelConfigService stateless（FsCrudStore 文件系统封装），按需构造复用 dataDir
      configService: new ChannelConfigService({ root: dataDir }),
      registry: bs.registry,
    });
  }

  return null;
}
