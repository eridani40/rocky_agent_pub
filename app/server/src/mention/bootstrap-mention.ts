/**
 * Mention Provider Registry 引导——创建 Registry 并注册内置 provider
 * 参考: specs/tech/mention/provider-interface.md §4/§7/§8
 *
 * 从 bootstrap.ts 调用。注册三个内置 provider：
 *   - FileProvider：workspace 文件搜索（无外部依赖）
 *   - SkillProvider：skill 搜索（依赖 SkillResolver + SkillEnabledStore）
 *   - MemberProvider：squad 成员搜索（依赖 MemberStore）
 *
 * 注：spec provider-interface.md §8 写「SquadStore.getSquad(squadId).members」为概念表达——
 *   实际 member entity 落 members/ 子目录分片存储，MemberStore.listMembers 是权威数据源，
 *   故本处注入 MemberStore（非 SquadStore）。
 */
import { MentionProviderRegistry } from './registry';
import { FileProvider } from './providers/file-provider';
import { SkillProvider } from './providers/skill-provider';
import { MemberProvider } from './providers/member-provider';
import type { AppConfigService } from '../config/app-config-service';
import { SkillEnabledStore } from '../skills/enabled-store';
import { SkillResolver, builtinSkillRoot } from '../skills/resolver';
import type { MemberStore } from '../stores/squad-store';

/**
 * 创建 MentionProviderRegistry 并注册内置 provider。
 *
 * @param dataDir app 数据根目录（SkillResolver 扫描 app 层 skill 用）
 * @param appConfig app 配置服务（构造 SkillEnabledStore 用）
 * @param memberStore squad member store（MemberProvider 消费）
 * @returns 注册完毕的 Registry 实例（注入 BootstrapResult）
 */
export function bootstrapMentionRegistry(
  dataDir: string,
  appConfig: AppConfigService,
  memberStore: MemberStore,
): MentionProviderRegistry {
  const registry = new MentionProviderRegistry();

  // 内置 provider 1: 文件搜索（无外部依赖）
  registry.register(new FileProvider());

  // 内置 provider 2: skill 搜索（依赖 SkillResolver + SkillEnabledStore）
  const enabledStore = new SkillEnabledStore(appConfig);
  registry.register(
    new SkillProvider({
      resolve: SkillResolver.resolve,
      dataDir,
      enabledStore,
      builtinDir: builtinSkillRoot(),
    }),
  );

  // 内置 provider 3: squad 成员搜索（依赖 MemberStore）
  registry.register(new MemberProvider(memberStore));

  return registry;
}
