/**
 * browser 工具——chrome 自动化（headless / managed-profile / attach）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §7（Tool 层）
 *       specs/api/overall/08-web-tools.md §4（schema + isError 分支）
 *       specs/tech/version_logs/v0.0.266/change_plan.md Delta（T3：操作 action 统一 execute）
 *
 * 流程（v0.0.266 T3 registry 重构）：
 *   - action='launch'  → im.launch(sessionId, {mode, profileName?, cdpUrl?})（幂等复用）
 *   - action='close'   → im.close(sessionId, {mode, profileName?})（attach = disconnect 语义，不杀 chrome）
 *   - 其他 action（三模式统一）→ im.execute(sessionId, opts, action, params, ctx)
 *       （零 mode 分叉：registry 按 mode 路由 WorkerModeImpl/AttachModeImpl；
 *        前置校验 + attach 失活自愈 + screenshot 落盘全在 impl/manager，tool 只透传）
 *
 * 设计要点：
 *   - attach 不再由 connectorManager lazy connect（v0.0.266：attach 归 InstanceManager）
 *   - screenshot 落盘下沉 impl（INV-157-1/3）：tool 构造 SnapshotSink 闭包（绑定 workdir/toolCallId）
 *     经 execute ctx 传给 impl，impl decode/落盘后返路径文本
 *   - headless/managed-profile 走常驻实例（「像人的浏览器」）；NodeWorkerDriver.executeOnce 仅服务 web_fetch
 *
 * deps 注入：connectorManager + browserInstanceManager 经 ctx.config（类似 pluginManager）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult, textResult } from '../types';
import type { BrowserMode, BrowserLaunchOptions, BrowserExecuteResult } from './types';
import type { ConnectorManager } from './connector-manager';
import type { BrowserInstanceManager } from './instance-manager';
import { extractActionParams, formatExecuteError } from './tool-dispatch';
// screenshot 落盘 sink（INV-157 单一出口；tool 构造闭包注入 execute ctx）
import { saveSnapshot } from '../snapshot-store';
// SSRF 校验复用 web-fetch 模块（attach cdpUrl 远程端 fail-closed）
// CDP 控制面 ≠ 页面导航：本地 loopback CDP 豁免 SSRF，非 loopback 仍 fail-closed。
// 参考: specs/tech/agent/tools/[P1]browser_tool.md §4/§6
//       refs/openclaw/.../cdp-reachability-policy.ts:33（resolveCdpReachabilityPolicy）
import { assertSsrfSafe, SsrfError, isLoopbackHost } from '../web-fetch/ssrf';

/** browser tool 输入形状 */
interface BrowserInput {
  mode?: unknown;
  action?: unknown;
  profileName?: unknown;
  url?: unknown;
  ref?: unknown;
  text?: unknown;
  cdpUrl?: unknown;
  userDataDir?: unknown;
}

/** browser tool 工厂参数（注入 connectorManager + instanceManager 默认值） */
export interface BrowserToolDeps {
  /** attach 连接器管理器（缺省→读 ctx.config，再缺省→noop，attach 必 isError） */
  connectorManager?: ConnectorManager;
  /**
   * BrowserInstanceManager（headless/managed-profile/attach 常驻浏览器实例管理器）。
   * 缺省→读 ctx.config.browserInstanceManager，再缺省→三模式报「未注册」isError。
   */
  instanceManager?: BrowserInstanceManager;
}

/** 默认 browser Tool 单例（registry defaultTools 引用；run 时从 ctx.config 读注入依赖） */
export const browserTool: Tool = createBrowserTool();

/**
 * 创建 browser Tool（依赖注入 connectorManager + driverRegistry）。
 * registry.ts defaultTools 注入实际依赖；UT 注入 mock。
 */
export function createBrowserTool(deps: BrowserToolDeps = {}): Tool {
  const instanceManager = deps.instanceManager;

  const tool: Tool = {
    definition: {
      name: 'browser',
      description: 'Automate Chrome: headless / persistent-profile / attach modes.',
      intro: 'Automate Chrome to navigate and interact with web pages.',
      inputSchema: {
        type: 'object',
        required: ['mode', 'action'],
        properties: {
          mode: {
            type: 'string',
            enum: ['headless', 'managed-profile', 'attach'],
            description: 'chrome 启动/连接模式',
          },
          action: {
            type: 'string',
            enum: [
              'launch',
              'navigate',
              'snapshot',
              'click',
              'type',
              'listPages',
              'selectPage',
              'evaluate',
              'screenshot',
              'close',
            ],
            description:
              'launch / navigate / snapshot / click / type / listPages / selectPage / evaluate / screenshot / close。headless/managed-profile/attach 三模式统一：需先 launch 建立实例，再执行其他 action；close 显式关闭（attach = 断 CDP 连接，不杀用户 chrome）。',
          },
          profileName: { type: 'string', description: 'mode=②③ profile 名' },
          url: { type: 'string', description: 'action=navigate 目标 URL' },
          ref: { type: 'string', description: 'action=click/type 元素 ref（来自 snapshot）' },
          text: { type: 'string', description: 'action=type 待输入文本' },
          cdpUrl: { type: 'string', description: 'mode=③ attach fallback；本地 loopback(127.0.0.1/::1/localhost) 豁免 SSRF，非 loopback 远程/私网 fail-closed' },
        },
      },
    },

    // [v0.0.101] HITL 钩子：旧 needsApproval 退役（O7），attach 模式的 HITL 后续可通过
    // tool.interaction 返 need_approval 实现（本版未启用，spec 留位 O3）；现 fallback 立即 run

    async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
      const typed = input as BrowserInput;
      const mode = parseMode(typed.mode);
      if (!mode) return errorResult('browser: mode 必填 (headless|managed-profile|attach)');
      const action = typeof typed.action === 'string' ? typed.action : '';
      if (!action) return errorResult('browser: action 必填');

      // SSRF 门禁：cdpUrl（attach fallback）非 loopback 时 → 私网/file:// fail-closed。
      // loopback（127.x/::1/localhost）CDP 控制面豁免——本地 chrome attach 不该被页面导航
      // SSRF 语义误拦（refs/openclaw cdp-reachability-policy）。先于 driver/connect 校验。
      if (
        typeof typed.cdpUrl === 'string' &&
        typed.cdpUrl.length > 0 &&
        !isLoopbackHost(typed.cdpUrl)
      ) {
        try {
          await assertSsrfSafe(typed.cdpUrl);
        } catch (e) {
          if (e instanceof SsrfError) {
            return errorResult(`browser: cdpUrl 被 SSRF 拒绝 (${e.message})`);
          }
          throw e;
        }
      }

      // 优先用注入 deps；否则从 ctx.config 取（session-config 注入）
      const im =
        instanceManager ??
        ((ctx.config as { browserInstanceManager?: BrowserInstanceManager }).browserInstanceManager);

      // sessionId 用于实例 key 粒度隔离（design §3.3）。
      // ToolSessionConfigLike.sessionId 由 session-config 注入；缺省 fallback 保护 UT/异常路径。
      const sessionId =
        typeof ctx.config.sessionId === 'string' ? ctx.config.sessionId : '<unknown>';

      // 三模式统一走 BrowserInstanceManager（v0.0.266）：launch/close/操作 前置校验全在 manager。
      if (!im) {
        return errorResult('browser: browser instance manager 未注册（headless/managed-profile/attach 不可用）');
      }
      const launchOpts = toLaunchOptions(typed, mode);
      if (action === 'launch') {
        return toToolResult(await im.launch(sessionId, launchOpts));
      }
      if (action === 'close') {
        return toToolResult(await im.close(sessionId, launchOpts));
      }
      // 操作 action 统一走 execute（v0.0.266 T3：零 mode 分叉，registry 按 mode 路由 impl）。
      // ctx.signal 透传 abort；ctx.snapshot = SnapshotSink 闭包（绑定 workdir/toolCallId）供 impl 落盘。
      const params = extractActionParams(action, typed);
      const r = await im.execute(sessionId, launchOpts, action, params, {
        signal: ctx.signal,
        snapshot: {
          save: (data, mediaType) =>
            saveSnapshot({
              workdir: ctx.workdir,
              toolCallId: ctx.toolCallId,
              data,
              mediaType,
            }).then((s) => ({ relPath: s.relPath })),
        },
      });
      if (r.ok) return textResult(r.text ?? '');
      return errorResult(formatExecuteError(r));
    },
  };

  return tool;
}

/** 解析 mode（无效返 undefined） */
function parseMode(v: unknown): BrowserMode | undefined {
  if (v === 'headless' || v === 'managed-profile' || v === 'attach') return v;
  return undefined;
}

/** browser input → BrowserLaunchOptions（headless/managed-profile/attach 实例选择参数） */
function toLaunchOptions(typed: BrowserInput, mode: BrowserMode): BrowserLaunchOptions {
  const opts: BrowserLaunchOptions = { mode };
  if (typeof typed.profileName === 'string') opts.profileName = typed.profileName;
  if (mode === 'attach' && typeof typed.cdpUrl === 'string') opts.cdpUrl = typed.cdpUrl;
  return opts;
}

/** BrowserExecuteResult → ToolRunResult（launch/close 复用；error 带 kind 前缀） */
function toToolResult(r: BrowserExecuteResult): ToolRunResult {
  if (r.ok) return textResult(r.text ?? '');
  return errorResult(formatExecuteError(r));
}
