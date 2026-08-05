// @vitest-environment node
/**
 * view-store 单测（内存路由 currentView 切换）
 * 参考: specs/ui/overall/02-llm-chat.md §1.1（内存路由，无 URL router）
 */
import { describe, it, expect } from 'vitest';
import { createViewStore } from '../view-store';

describe('view-store', () => {
  // [v0.0.33.1] view id 改名：'chat' → 'playground'（默认）+ 新增 'studio'
  it('初态 currentView=playground（原 chat 改名）', () => {
    const store = createViewStore();
    expect(store.getState().currentView).toBe('playground');
  });

  it('setView 切换到 settings-app', () => {
    const store = createViewStore();
    store.getState().setView('settings-app');
    expect(store.getState().currentView).toBe('settings-app');
  });

  it('setView 切换到 studio（[v0.0.33.1] 新增 Studio view）', () => {
    const store = createViewStore();
    store.getState().setView('studio');
    expect(store.getState().currentView).toBe('studio');
  });

  it('setView 切换到 skill / connector / playground 全覆盖（[v0.0.47] 删 settings-dev/plugin）', () => {
    const store = createViewStore();
    store.getState().setView('skill');
    expect(store.getState().currentView).toBe('skill');
    store.getState().setView('connector');
    expect(store.getState().currentView).toBe('connector');
    store.getState().setView('playground');
    expect(store.getState().currentView).toBe('playground');
  });
});
