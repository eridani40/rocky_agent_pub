/**
 * emptyUsage —— SessionUsageView 全 0 占位常量
 *
 * usage=null 时（进会话 GET /session/:id/usage 拉到真值前 / usage fetch 失败兜底），
 * ComponentUsagePanel 用此常量兜底渲染（0/0 圆环 + 空表格），避免 UI 崩。
 *
 * 消费方：section-chat-session（统一装配层）。
 */
import type { SessionUsageView } from './types';

export const emptyUsage: SessionUsageView = {
  current: {},
  sub: {},
  forked: {},
  total: {},
  ratio: 0,
  contextWindowUsage: {
    systemTokens: 0,
    messageTokens: 0,
    toolTokens: 0,
    totalTokens: 0,
    maxOutputTokens: 0,
    tokenLimit: 0,
    remainingTokens: 0,
  },
  currentCacheRate: 0,
  subCacheRate: 0,
  forkedCacheRate: 0,
  totalCacheRate: 0,
};
