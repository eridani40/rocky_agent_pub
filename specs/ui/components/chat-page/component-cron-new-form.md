# component-cron-new-form（cron 新建表单）

> 层级: component
> 文件: app/web/src/components/chat-page/component-cron-new-form.tsx
> 数据契约: `specs/api/overall/16-cron.md` §2（POST /session/:sid/cron）

## 1. 定位

## Props
- sessionId: string
- form: NewFormState;            // {open, cron, prompt, name, submitting, error}
- setForm: (updater: (s: NewFormState) => NewFormState) => void
- onCancel: () => void;          // 重置为 INITIAL_NEW 并收起
- onSaved: () => Promise<void>;   // refetch 回调

## 3. 职责
- 受控渲染 name / freq / prompt 三输入框 + 错误展示 + 取消/保存按钮
- 保存：校验 cron/prompt 非空 → POST `/session/:sid/cron`（带 client tz）→ onSaved（refetch + 父层 setForm INITIAL_NEW）
- 失败：将 error 写回 `form.error`，不关闭表单

## 视觉基线
纯字段容器（`<div>` 包字段，间距由弹层 modal body padding 承担）——**去除**「占据列表底部」外层容器（ +  + padding 14px）+ 内部重复标题（弹层 head 已渲 `cron.form.newTitle`）。字段视觉沿用：label 11px uppercase tracking；input/textarea 13px；accent 主按钮 + outline 取消按钮。
