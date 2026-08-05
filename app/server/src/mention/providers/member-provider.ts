/**
 * MemberProvider —— squad 成员（leader + mate）搜索 mention provider
 * 参考: specs/tech/mention/provider-interface.md §8
 *
 * 设计：
 *   - name='member' label='Members'
 *   - 搜索范围：当前 squad 的全体成员（leader + mate，不含 bench 状态）
 *   - 数据来源：MemberStore.listMembers(squadId)（spec §8 写「SquadStore.getSquad(squadId).members」
 *     为概念表达——squad record 仅存 memberIds[] 字段，实际 member entity 在 members/ 子目录分片存储，
 *     故实现取 MemberStore.listMembers 为权威数据源）
 *   - 搜索算法：name 模糊匹配（小写包含），无分页
 *   - address 走 `id`（独立字段，非 path=memberId）
 *   - display.icon='member'，display.label=name，display.badge='leader' 仅 leader（mate 省略）
 *
 * 约束：
 *   - SearchCtx.squadId 缺失 → 返空数组
 *   - 仅 @member 一等引用，**不**暴露 subagent（subagent 是 mate 私产子 agent，非 squad 一等成员）
 *   - state='benched' 的 member 不入结果（暂停值勤，spec §8「不含 bench 状态」）
 */
import type {
  MentionProvider,
  SearchCtx,
  SearchResult,
  MentionItem,
  MentionItemDisplay,
} from '../types';
import type { MemberStore } from '../../stores/squad-store';

/**
 * squad 成员搜索 provider。
 * 构造时注入 MemberStore（bootstrap 阶段，registry 持引用）。
 */
export class MemberProvider implements MentionProvider {
  readonly name = 'member';
  readonly label = 'Members';

  constructor(private readonly memberStore: MemberStore) {}

  async search(ctx: SearchCtx): Promise<SearchResult> {
    // 防御：squadId 缺失（playground/subagent session）→ 返空数组
    if (!ctx.squadId) {
      return { items: [] };
    }

    const query = ctx.query.toLowerCase();
    const members = await this.memberStore.listMembers(ctx.squadId);

    // 过滤：name 模糊匹配 + state=deployed（不含 benched）
    // MemberSchema role 枚举 ['leader','mate']——天然不含 subagent，无需额外过滤
    const matches = members.filter(
      (m) =>
        m.state === 'deployed' && m.name.toLowerCase().includes(query),
    );

    return {
      items: matches.map((m) => this.toMentionItem(m.id, m.name, m.role)),
    };
  }

  /**
   * 构造 MentionItem（address 走 id 顶层字段；display.badge 仅 leader）。
   * mate **省略** badge 字段（条件 spread，对象里不出现 badge key，序列化 JSON 不含 badge）。
   * listView.subtitle=member role。
   */
  private toMentionItem(
    memberId: string,
    name: string,
    role: 'leader' | 'mate',
  ): MentionItem {
    // mate 不传 badge（条件 spread 省略 key，不写 undefined）
    const display: MentionItemDisplay = {
      icon: 'member',
      label: name,
      ...(role === 'leader' ? { badge: 'leader' } : {}),
    };

    return {
      type: 'member',
      id: memberId,
      display,
      listView: {
        title: name,
        subtitle: role,
        icon: 'member',
      },
    };
  }
}
