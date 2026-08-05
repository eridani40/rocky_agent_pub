/**
 * 测试用 SessionTypePolicy 工厂
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §6
 *
 * buildSessionConfigFromDeps 的 tools 解析强制走 SessionTypePolicy（deps.sessionTypePolicy 必填，
 * 未注入 fail-fast）。测试从真实 app/plugins/session-types/ 加载 profile 构造 policy
 * （与 bootstrap 装配同源），注入 deps fixture。
 */
import * as path from 'node:path';
import { defaultTools } from '../../tools/registry';
import { SessionTypeProfileLoader } from '../session-type-profile-loader';
import { SessionTypeProfileValidator } from '../session-type-profile-validator';
import { SessionTypePolicyImpl, type SessionTypePolicy } from '../session-type-policy';

/**
 * 从真实 session-types 目录构造 policy（loadAll + validateAll + SessionTypePolicyImpl）。
 *
 * @param workdir registry.defaultTools 的 workdir（测试 tmpRoot 即可；工具实例仅作注册序/name 源）
 * @returns 可用于 deps.sessionTypePolicy 注入的真实 policy
 */
export function buildRealSessionTypePolicy(workdir: string): SessionTypePolicy {
  // __dirname = app/server/src/agent/__helpers__ → 上溯 4 级到 app/ 再到 plugins/session-types
  const dir = path.resolve(__dirname, '../../../../plugins/session-types');
  const loader = new SessionTypeProfileLoader(dir);
  loader.loadAll();
  const allTools = defaultTools(workdir);
  const allToolDefs = allTools.map((t) => t.definition);
  new SessionTypeProfileValidator({
    loader,
    registered: { names: new Set(allToolDefs.map((d) => d.name)) },
  }).validateAll();
  return new SessionTypePolicyImpl({ loader, allTools, allToolDefinitions: allToolDefs });
}
