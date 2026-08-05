/**
 * Mention 子系统入口——类型 + Registry + 内置 Provider + Search Service 统一 re-export
 * 参考: specs/tech/mention/index.md
 *
 * 消费者（handler / bootstrap）从此路径 import，不直接引用内部文件。
 */
export type {
  MentionProvider,
  SearchResult,
  SearchCtx,
  MentionItem,
  MentionItemDisplay,
  MentionItemListView,
} from './types';
export { MentionProviderRegistry } from './registry';
export { FileProvider } from './providers/file-provider';
export { SkillProvider } from './providers/skill-provider';
export type { SkillProviderDeps } from './providers/skill-provider';
export {
  searchMentions,
  SessionNotFoundError,
  ProviderNotFoundError,
} from './search-service';
export type { SearchMentionsDeps, SearchMentionsParams } from './search-service';

