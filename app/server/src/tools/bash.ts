/**
 * bash 工具（持久 shell 执行命令）
 * 参考: specs/tech/agent/tools/[P0]bash_tools.md §2
 *       specs/tech/version_logs/v0.0.8/change_log.md §11
 *
 * 行为：
 *   - command 必填（shell 命令，可含管道/&&）；description 必填（人类可读说明）
 *   - timeout：默认 120000ms，上限 600000ms（超上限截断 + 警告）
 *   - per-session 持久 cwd：默认 <workdir>（= session.workspaceDir 绝对路径，由 session-config 创建）
 *     调用间 cwd 持久（sessionStore 范围）；shell 状态不持久（每次新 spawn）
 *   - runInBackground：仅支持前台（true → 标记未实现，仍前台执行并警告）
 *   - 输出截断 MAX_OUTPUT_CHARS=64KB（超则截断 + 尾部 "[truncated]" 标记）
 *   - 交互式 flag -i（如 git rebase -i / git add -i）→ reject isError
 *   - 退出码非 0 → isError
 *   - timeout 超时 → kill SIGTERM + isError
 *
 * [v0.0.122] 执行层走 getBashEngine()（SecureBashEngine seatbelt 沙箱，darwin only）。
 * [v0.0.122] 新增 checkPermission 钩子（调 checkBashPermission，纯判定，INV-P3）。
 */
import { isAbsolute } from 'node:path';
import type { Tool, ToolCtx, ToolInput, ToolRunResult, PermissionDecision } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';
import { getBashEngine } from './bash-engine';
import { checkBashPermission } from './bash-policy';
import { formatTimeoutText } from './engine-timeout';

/** 默认超时（对齐 bash_tools §2 / change_log §11） */
const DEFAULT_TIMEOUT = 120000;
/** 超时上限（10 分钟） */
const MAX_TIMEOUT = 600000;
/** 输出字符上限（64KB，对齐 change_log §11） */
export const MAX_OUTPUT_CHARS = 64 * 1024;
/** 截断标记 */
const TRUNCATED_MARK = '\n[truncated]';

/**
 * 检测命令是否含交互式 flag（git rebase -i / git add -i 等）。
 * 直接 reject（无 TTY 支持）。
 */
function isInteractive(command: string): boolean {
  return /\bgit\s+(rebase|add)\s+(-\w*i|i\b|-i\b)/.test(command) || /\b-\w*i\b\s*rebase/.test(command);
}

/**
 * bash 工具实现（单例导出，registry 组装时引用）。
 * cwd = ctx.workdir（session.workspaceDir 绝对路径，不套 workspace 子目录，#1 绝对路径修复）。
 */
export const bashTool: Tool = {
  definition: {
    name: 'bash',
    description:
      'Execute a shell command. Persistent cwd per session (default <workdir>). Timeout default 120s, max 600s. Output truncated at 64KB.',
    intro: 'Execute a shell command.',
    inputSchema: {
      type: 'object',
      required: ['command', 'description'],
      properties: {
        command: { type: 'string', description: 'Shell command (pipes/&& allowed)' },
        description: { type: 'string', description: 'Human-readable description (5-10 words)' },
        timeout: { type: 'integer', description: `Timeout ms (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})` },
        runInBackground: { type: 'boolean', description: 'Run in background (v0.0.8 unsupported, runs foreground)' },
      },
    },
  },
  // [v0.0.130.hang] per-tool 默认超时：与 bash 自身 DEFAULT_TIMEOUT 对齐，120s
  // （engine 层 resolveEffectiveTimeout 的 per-tool 兜底；LLM per-call 可覆盖，封顶 600s。
  //  仅加此字段，run()/childRegistry 透传归 task-2，本 task 不动）
  defaultTimeoutMs: 120000,

  /**
   * [v0.0.122] 权限检查钩子（INV-P3 纯判定无副作用）。
   * 调 checkBashPermission 检测 rm-wildcard 策略。
   * deny 优先于 ask（bash-policy.ts 保证）。
   */
  checkPermission(input: ToolInput): PermissionDecision {
    const command = String(input.command ?? '');
    return checkBashPermission(command);
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const command = String(input.command ?? '');
    const description = String(input.description ?? '');
    if (!command) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] command is required`);
    }
    if (!description) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] description is required`);
    }

    // 交互式 flag → reject
    if (isInteractive(command)) {
      return errorResult(
        `[${ToolErrorCode.INTERACTIVE_UNSUPPORTED}] interactive flag (-i) is not supported (no TTY): ${command}`,
      );
    }

    // timeout 上限校验
    let timeout = Number(input.timeout ?? DEFAULT_TIMEOUT);
    if (!Number.isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT;
    if (timeout > MAX_TIMEOUT) timeout = MAX_TIMEOUT;

    // cwd：per-session 持久，= ctx.workdir（session.workspaceDir 绝对路径，不套 workspace 子目录）
    // workdir 由 session-config 创建保证存在；若 workdir 缺省/非绝对则回退 process.cwd()
    const cwd = ctx.workdir && isAbsolute(ctx.workdir) ? ctx.workdir : process.cwd();

    // 执行（via BashEngine，darwin 走 seatbelt 沙箱；childRegistry 透传供 wireChildLifecycle
    // 注册子进程，供 run 终止级 sweep 兜底清理，见 [v0.0.130.hang] 模块 B）
    try {
      const { stdout, exitCode, timedOut, spawnErrno } = await getBashEngine().exec(command, {
        cwd,
        timeoutMs: timeout,
        signal: ctx.signal,
        childRegistry: ctx.childRegistry,
      });

      let output = stdout;
      // 截断
      let truncated = false;
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MARK;
        truncated = true;
      }

      // 超时 → isError。[v0.0.130.hang] 统一超时文案契约（drift 裁决①）：文本恒以
      // formatTimeoutText('bash', effectiveTimeoutMs) 开头（= engine backstop 分支同一格式化点），
      // 保证「bash 内部先超时」与「engine backstop 后触发」两条路径 LLM 读到的文案前缀一致；
      // 其后追加部分 stdout/stderr（已截断的仍保留，避免丢弃对 LLM 有价值的部分输出）。
      if (timedOut) {
        const prefix = formatTimeoutText('bash', timeout);
        const msg = output ? `${prefix}\n${output}` : prefix;
        return errorResult(msg);
      }

      // 退出码非 0 → isError（含退出码）
      // spawnErrno 存在（spawn 系统调用失败）→ 前置 [RUNTIME_ERROR] spawn XXX 文本，
      // 让真机一跑即可区分 errno（EBADF/EMFILE/ENOENT/EACCES）；缺失走原 NON_ZERO_EXIT 路径
      if (exitCode !== 0) {
        const runtimePrefix = spawnErrno ? `[${ToolErrorCode.RUNTIME_ERROR}] spawn ${spawnErrno}\n` : '';
        const msg = truncated
          ? output
          : output + `\n[${ToolErrorCode.NON_ZERO_EXIT}] exit code ${exitCode}`;
        return errorResult(runtimePrefix + msg);
      }

      return textResult(output);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] ${msg}`);
    }
  },
};
