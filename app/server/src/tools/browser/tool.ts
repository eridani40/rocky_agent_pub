/**
 * browser 工具——chrome 自动化（headless / managed-profile / attach）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §7（Tool 层）
 *       specs/api/overall/08-web-tools.md §4（schema + isError 分支）
 *       states/v0.0.46.connector_opt/design.md §3（tool 层 lazy connect）
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 A（needsApproval 退役 → interaction）
 *
 * 流程：
 *   - [v0.0.101] needsApproval 已退役（O7）：attach 模式原 HITL 占位退役；
 *     未来可改用 tool.interaction 返 need_approval 实现，本版 spec 留位不实例（O3）
 *   - run：mode=attach →
 *       action='disconnect'  → connectorManager.disconnect(id, ctx.sessionId)（幂等，不改 intent）
 *       其他 action           → connectorManager.connectForToolRun(id, ctx.sessionId)：
 *           ok:true  → dispatchAction(session, action, ...)
 *           ok:false → errorResult(formatConnectorError(err))（not_enabled/in_use_by_other/connect_failed）
 *     mode=headless/managed-profile → pickDriver(PlaywrightDriver).connect → dispatch → finally close
 *   - dispatch(action)：navigate/snapshot/click/type/evaluate/listPages/selectPage/screenshot
 *
 * 设计要点：
 *   - attach 由 connectorManager 主动 lazy connect（无 isReady 静态门禁）
 *   - disconnect 仅断连不改 persist intent（disable=用户 toggle off 才清 intent；LLM 不该改 persist intent）
 *
 * deps 注入：connectorManager + browserDriverRegistry 经 ctx.config（类似 pluginManager）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult, textResult } from '../types';
import type { BrowserMode, BrowserConnectOptions, BrowserSession } from './types';
import type { DriverRegistry } from './pick-driver';
import { pickDriver } from './pick-driver';
import type { ConnectorManager } from './connector-manager';
import { formatConnectorError } from './tool-error-format';
import {
  dispatchAction,
  formatBrowserError,
  extractActionParams,
  formatExecuteError,
} from './tool-dispatch';
// headless screenshot 拦截：executeOnce 返 base64 → caller 层落盘
import { saveSnapshot, formatSnapshotText } from '../snapshot-store';
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

/** browser tool 工厂参数（注入 connectorManager + registry 默认值） */
export interface BrowserToolDeps {
  /** attach 连接器管理器（缺省→读 ctx.config，再缺省→noop，attach 必 isError） */
  connectorManager?: ConnectorManager;
  /** driver 注册表（缺省→读 ctx.config；headless/managed-profile 用） */
  driverRegistry?: DriverRegistry;
}

/** 默认 browser Tool 单例（registry defaultTools 引用；run 时从 ctx.config 读注入依赖） */
export const browserTool: Tool = createBrowserTool();

/**
 * 创建 browser Tool（依赖注入 connectorManager + driverRegistry）。
 * registry.ts defaultTools 注入实际依赖；UT 注入 mock。
 */
export function createBrowserTool(deps: BrowserToolDeps = {}): Tool {
  const connectorManager = deps.connectorManager;
  const driverRegistry = deps.driverRegistry;

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
              'navigate',
              'snapshot',
              'click',
              'type',
              'listPages',
              'selectPage',
              'evaluate',
              'screenshot',
              'disconnect',
            ],
            description:
              'navigate / snapshot / click / type / listPages / selectPage / evaluate / screenshot / disconnect（仅 attach：主动断开 chrome-devtools-mcp 并清 owner，不改 persist intent）',
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
      const cm = connectorManager ?? (ctx.config.connectorManager as ConnectorManager | undefined);
      const reg =
        driverRegistry ?? (ctx.config.browserDriverRegistry as DriverRegistry | undefined);

      // sessionId 用于 owner 粒度占用判定与 disconnect 匹配（design §3.3）。
      // ToolSessionConfigLike.sessionId 由 session-config 注入；缺省 fallback 保护 UT/异常路径。
      const sessionId =
        typeof ctx.config.sessionId === 'string' ? ctx.config.sessionId : '<unknown>';

      // disconnect action 仅 attach 模式有意义（design §3.1）
      if (action === 'disconnect' && mode !== 'attach') {
        return errorResult('browser disconnect: 仅 attach 模式支持 disconnect action');
      }

      // attach：走 connectorManager.connectForToolRun（lazy connect）+ disconnect
      if (mode === 'attach') {
        // (a) disconnect：不改 intent、不看 isReady——幂等（若无占用则 no-op）。
        //     只清 owner+session、保持 switch=on（PRD P3「switch=on 保持」契约；disable 才清 intent）。
        if (action === 'disconnect') {
          if (!cm || typeof cm.disconnect !== 'function') {
            return errorResult('browser disconnect: 连接器不支持断开');
          }
          try {
            await cm.disconnect('browser', sessionId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return errorResult(`browser disconnect 失败: ${msg}`);
          }
          return textResult('browser attach 已断开（若无活跃连接则无副作用）');
        }
        // (b) 其他 action：门禁 + lazy connect
        //     cm 缺失/接口不全 → 与 connectForToolRun 返 not_enabled 走同一文案（DRY）
        if (!cm || typeof cm.connectForToolRun !== 'function') {
          return errorResult(formatConnectorError({ kind: 'not_enabled', message: '' }));
        }
        const r = await cm.connectForToolRun('browser', sessionId);
        if (!r.ok) {
          return errorResult(formatConnectorError(r.error));
        }
        // 复用 dispatchAction（不 close：session 由 ConnectorManager 生命周期持有）
        return dispatchAction(r.session, action, typed, ctx);
      }

      // headless/managed-profile：自启 driver
      // 走 driver.executeOnce（node worker 子进程绕开 Bun playwright bug）。
      // driver.connect → dispatchAction → close 仅当 executeOnce 未实现时兜底（如 PlaywrightDriver UT）。
      if (!reg) return errorResult('browser: driver 未注册（headless/managed-profile 不可用）');
      const driver = pickDriver(reg, mode);
      const connectOpts = toConnectOpts(typed, mode);
      if (driver.executeOnce) {
        const params = extractActionParams(action, typed);
        const r = await driver.executeOnce(connectOpts, action, params, ctx.signal);
        if (r.ok) {
          // headless screenshot 拦截（INV-157-1/3）：
          // worker boundary 不能传 Buffer，driver.executeOnce 协议保持
          // `r.text = JSON.stringify({mime, data:base64})`（UT 兼容、不改 worker 协议）；
          // 在 caller 层（这里）decode base64 → saveSnapshot 落盘 → 替换为路径文本。
          // 其他 action 保持原 textResult(r.text) 不变。
          if (action === 'screenshot' && r.text) {
            try {
              const parsed = JSON.parse(r.text) as { mime?: string; data?: string };
              if (!parsed.mime || !parsed.data) {
                return errorResult('browser screenshot: worker 返回数据缺 mime/data');
              }
              const r2 = await saveSnapshot({
                workdir: ctx.workdir,
                toolCallId: ctx.toolCallId,
                data: Buffer.from(parsed.data, 'base64'),
                mediaType: parsed.mime,
              });
              return textResult(formatSnapshotText({ relPath: r2.relPath, source: 'browser' }));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              return errorResult(`browser screenshot 落盘失败: ${msg}`);
            }
          }
          return textResult(r.text ?? '');
        }
        return errorResult(formatExecuteError(r));
      }
      // 兜底：老 connect/dispatch/close 路径（旧 driver 实现 / UT mock）
      let session: BrowserSession | undefined;
      try {
        session = await driver.connect(connectOpts, ctx.signal);
        return await dispatchAction(session, action, typed, ctx);
      } catch (e) {
        return errorResult(formatBrowserError(e));
      } finally {
        try {
          await session?.close();
        } catch {
          /* ignore */
        }
      }
    },
  };

  return tool;
}

/** 解析 mode（无效返 undefined） */
function parseMode(v: unknown): BrowserMode | undefined {
  if (v === 'headless' || v === 'managed-profile' || v === 'attach') return v;
  return undefined;
}

/** browser input → BrowserConnectOptions */
function toConnectOpts(typed: BrowserInput, _mode: BrowserMode): BrowserConnectOptions {
  const opts: BrowserConnectOptions = {};
  if (typeof typed.profileName === 'string') opts.profileName = typed.profileName;
  if (typeof typed.cdpUrl === 'string') opts.cdpUrl = typed.cdpUrl;
  if (typeof typed.userDataDir === 'string') opts.userDataDir = typed.userDataDir;
  if (_mode === 'headless') opts.headless = true;
  return opts;
}
