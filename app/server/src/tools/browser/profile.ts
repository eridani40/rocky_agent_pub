/**
 * browser profile 目录与命名规则
 * 参考: specs/research/v0.0.23-browser-use.md §3.1 §3.3
 *       specs/tech/agent/tools/[P1]browser_tool.md §3
 *
 * profile 目录：~/.rocky_agent_{env}/browser/<profileName>/user-data（沿用 config dataDir 派生）
 * profile 命名：/^[a-z0-9][a-z0-9-]*$/ ≤64
 */
import { join } from 'node:path';

/** profile 名校验：小写字母/数字/连字符，首字符字母数字，≤64 字符 */
export function isValidProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}

/** 默认 profile 名（无 profileName 时的兜底，mode ② 持久登录态） */
export const DEFAULT_PROFILE_NAME = 'default';

/**
 * 解析 profile 的 chrome user-data-dir 绝对路径。
 * @param dataDir app dataDir（来自 config，含环境后缀如 ~/.rocky_agent_dev）
 * @param profileName profile 名（不传用 default）
 * @returns <dataDir>/browser/<profileName>/user-data
 */
export function resolveUserDataDir(dataDir: string, profileName?: string): string {
  const name = profileName && isValidProfileName(profileName) ? profileName : DEFAULT_PROFILE_NAME;
  return join(dataDir, 'browser', name, 'user-data');
}
