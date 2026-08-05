/**
 * SkillProvider —— skill 搜索 mention provider
 * 参考: specs/tech/mention/provider-interface.md §6
 *
 * 搜索范围 = SkillResolver.resolve 返回的全量 SkillCatalog（三层目录）。
 * 搜索算法 = skill name 包含匹配（大小写不敏感）。
 * skill 数量预期小（数十个），全量枚举足够。
 */
import type { MentionProvider, SearchCtx, SearchResult, MentionItem } from '../types';
import type { SkillCatalog, SkillEntry } from '../../skills/types';
import type { SkillEnabledStore } from '../../skills/enabled-store';

/** SkillProvider 依赖注入（解耦 SkillResolver，方便单测 mock） */
export interface SkillProviderDeps {
  /**
   * 解析 skill 目录 → SkillCatalog。
   * 生产环境传 SkillResolver.resolve；测试传 mock 函数。
   */
  resolve: (
    dataDir: string,
    workspaceDir: string | undefined,
    enabledStore: SkillEnabledStore | null,
    builtinDir?: string,
  ) => SkillCatalog;
  /** app 数据根目录 */
  dataDir: string;
  /** skill enabled 状态源 */
  enabledStore: SkillEnabledStore | null;
  /** 可选 builtin skill 根目录（生产传 builtinSkillRoot()，测试省略） */
  builtinDir?: string;
}

/** description 截取最大长度 */
const MAX_DESC_LENGTH = 60;

/**
 * skill 搜索 provider。
 * 调 SkillResolver.resolve 获取全量 enabled skill，按 name 包含匹配过滤。
 * 首版返回所有 enabled skill（不按 sessionType 差异化过滤，见 spec §7 未决事项）。
 */
export class SkillProvider implements MentionProvider {
  readonly name = 'skill';
  readonly label = 'Skills';

  constructor(private readonly deps: SkillProviderDeps) {}

  async search(ctx: SearchCtx): Promise<SearchResult> {
    const query = ctx.query.toLowerCase();

    // 调 SkillResolver 获取全量 skill catalog
    const catalog = this.deps.resolve(
      this.deps.dataDir,
      ctx.workspaceDir,
      this.deps.enabledStore,
      this.deps.builtinDir,
    );

    // 只保留 enabled + name 包含匹配
    const matches = catalog.entries.filter(
      (e) => e.enabled && e.name.toLowerCase().includes(query),
    );

    return {
      items: matches.map((e) => this.toMentionItem(e)),
    };
  }

  /**
   * 将 SkillEntry 转换为 MentionItem。
   * path = skill 目录绝对路径；display.label/listView.title = skill name（同源）。
   */
  private toMentionItem(entry: SkillEntry): MentionItem {
    const subtitle =
      entry.description.length > MAX_DESC_LENGTH
        ? `${entry.description.slice(0, MAX_DESC_LENGTH)}...`
        : entry.description;

    return {
      type: 'skill',
      path: entry.skillDir,
      display: {
        icon: 'skill',
        label: entry.name,
      },
      listView: {
        title: entry.name,
        subtitle: subtitle || undefined,
        icon: 'skill',
      },
    };
  }
}
