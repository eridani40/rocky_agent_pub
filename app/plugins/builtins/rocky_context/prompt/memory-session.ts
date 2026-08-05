/**
 * builtin rocky_context plugin — system_prompt_mapper: memory_session（default re-export）
 * 参考: ./memory.ts（实现）+ specs/tech/agent/memory/[P0]memory_injection.md §2
 *
 * 一行 re-export 满足 builtin-loader「一 implId 一文件一 default export 类」约定
 * （见 app/server/src/plugin/builtin-loader.ts §impl 模块约定）。
 */
export { MemorySessionMapper as default } from './memory';
