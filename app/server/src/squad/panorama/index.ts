/**
 * panorama 模块统一导出 — tool + http + sse（集成层，Task#4）.
 *
 * dsl/validation/migration/store 子模块各自有 index.ts 导出（已 verified，此处不重导出避免循环）.
 * 本文件只导出 Task#4 集成层产出的符号（tool / routes / sse）.
 */
export { panoramaTool, PANORAMA_TOOL_DEFINITION } from './tool/panorama-tool';
export { handlePanoramaRoute } from './http/routes';
export type { PanoramaHandlerDeps } from './http/routes';
export {
  emitPanoramaEvent, panoramaGroup, PANORAMA_TOPIC,
} from './http/sse';
export type {
  PanoramaSseEventType, PanoramaEntityUpdateEvent, PanoramaSchemaUpdateEvent,
} from './http/sse';
