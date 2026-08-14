/**
 * browser 工具——chrome 自动化（headless / managed-profile / attach）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §7（Tool 层）
 *       specs/api/overall/08-web-tools.md §4（schema + isError 分支）
 *       specs/tech/version_logs/v0.0.266/change_plan.md Delta（T3：操作 action 统一 execute）
 *
 * 流程（v0.0.266 T3 registry 重构）：
 *   - action='launch'  → im.launch(sessionId, {mode, profileName?})（幂等复用）
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

/** browser tool 输入形状 */
interface BrowserInput {
  mode?: unknown;
  action?: unknown;
  profileName?: unknown;
  url?: unknown;
  ref?: unknown;
  text?: unknown;
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
      description:
        'Automate Chrome (headless / managed-profile / attach). 模式路由：我的 chrome→attach / 登录态→managed-profile / 默认→headless。\n' +
        '  headless: 无头临时浏览器（一次性、不留状态、不出窗口），适合快速抓取/截图/自动化；\n' +
        '  managed-profile: 有头持久 profile 浏览器（profileName 指定，可复用登录态/书签/扩展），适合需要登录态的长期任务；\n' +
        '  attach: 自动连接用户已打开的 Chrome（chrome://inspect 远调模式，无需指定地址/URL）。**前置条件：Chrome ≥144 且已开启 remote debugging**（chrome://inspect/#remote-debugging → Enable remote debugging）。**同意流程：launch 会触发用户 Chrome 的同意 prompt，需用户手动批准才建立连接**。**失败引导：连不上时提示用户开启/批准 remote debugging，或升级 Chrome（需 ≥144）后重试**。**安全警告：attach 操作的是用户真实浏览器，请谨慎操作**。attach close = 断连接 + 检测 Chrome 调试态残留并提示；**不杀用户浏览器**；用户 Chrome 调试态（9222 监听/提示条）由 chrome://inspect 授权，需用户取消勾选 Allow remote debugging 或重启 Chrome 恢复。\n' +
        '参数传递铁律：launch 一次性传全部初始化参数（mode + profileName）；创建后 navigate/snapshot/click/type/listPages/selectPage/evaluate/screenshot/close 只需 mode+action，不再重传初始化参数。未 launch 即操作或关闭 → 明确报错提示先调用 browser(action="launch")。\n' +
        '示例（headless）: {"mode":"headless","action":"launch"} → {"mode":"headless","action":"navigate","url":"https://example.com"} → {"mode":"headless","action":"snapshot"} → {"mode":"headless","action":"close"}\n' +
        '示例（managed-profile）: {"mode":"managed-profile","action":"launch","profileName":"default"} → {"mode":"managed-profile","action":"navigate","url":"https://example.com"} → {"mode":"managed-profile","action":"click","ref":"..."} → {"mode":"managed-profile","action":"close"}\n' +
        '示例（attach）: {"mode":"attach","action":"launch"} → {"mode":"attach","action":"navigate","url":"https://example.com"} → {"mode":"attach","action":"type","ref":"...","text":"..."} → {"mode":"attach","action":"close"}',
      intro: 'Automate Chrome to navigate and interact with web pages.',
      inputSchema: {
        type: 'object',
        required: ['mode', 'action'],
        properties: {
          mode: {
            type: 'string',
            enum: ['headless', 'managed-profile', 'attach'],
            description:
              'chrome 启动/连接模式。模式路由：我的 chrome→attach / 登录态→managed-profile / 默认→headless。' +
              'headless=无头临时浏览器（一次性、不留状态、不出窗口，适合快速抓取/截图/自动化）；' +
              'managed-profile=有头持久 profile 浏览器（profileName 指定，可复用登录态/书签/扩展，适合需要登录态的长期任务）；' +
              'attach=自动连接用户已打开的 Chrome（chrome://inspect 远调模式，无需指定地址/URL；**前置：Chrome ≥144 且已开启 remote debugging** chrome://inspect/#remote-debugging → Enable remote debugging；**launch 会触发用户同意 prompt，需用户批准才建立连接**；连不上提示开启/批准或升级 Chrome；**操作的是用户真实浏览器，谨慎操作**；close=断连接+检测调试态残留提示，不杀用户浏览器）',
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
              'launch / navigate / snapshot / click / type / listPages / selectPage / evaluate / screenshot / close。' +
              'headless/managed-profile/attach 三模式统一：**必须先 launch 初始化实例**，再执行其他 action（navigate/snapshot/click/type/listPages/selectPage/evaluate/screenshot）；' +
              'close 显式关闭（headless/managed-profile = 杀自启 chrome 进程 + 回收资源；attach = 断 CDP 连接 + 检测调试态残留并返回引导提示，不杀用户 chrome）；未 launch 即操作或 close → 报错提示先调用 launch',
          },
          profileName: { type: 'string', description: 'mode=② 初始化参数（仅 launch 时传；之后操作/关闭无需再传）' },
          url: { type: 'string', description: 'action=navigate 目标 URL' },
          ref: { type: 'string', description: 'action=click/type 元素 ref（来自 snapshot）' },
          text: { type: 'string', description: 'action=type 待输入文本' },
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
        // H8：launch 透传 ctx.signal（attach 超时 abort 感知，engine backstop 30s abort 后底层 connect 立即清理）
        return toToolResult(await im.launch(sessionId, launchOpts, { signal: ctx.signal }));
      }
      if (action === 'close') {
        // close 不透传 signal：清理动作必须完整执行（被 abort 反而中断清理，三层分裂）
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
  return opts;
}

/** BrowserExecuteResult → ToolRunResult（launch/close 复用；error 带 kind 前缀） */
function toToolResult(r: BrowserExecuteResult): ToolRunResult {
  if (r.ok) return textResult(r.text ?? '');
  return errorResult(formatExecuteError(r));
}
