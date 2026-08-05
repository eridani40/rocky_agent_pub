/**
 * enqueue-view 排队项（对齐 _overview §4.11a）。
 *
 * 拆分自原 chat-page/types.ts（v0.0.156 纯拆分，类型定义 100% 不变）。
 */
export interface EnqueueItem {
  /** inbox 入队句柄（drain 时由后端分配 messageId，与 messageId 解耦） */
  enqueueId: string;
  /** user query 内容预览 */
  content: string;
}
