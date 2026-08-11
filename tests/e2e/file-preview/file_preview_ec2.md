# ET case: 多 tab 横滑 + 左右按钮滚动

> case_id: file_preview_ec2
> 来源: PRD §6 EC-2（UC-3 覆盖）+ test-plan §4 EC-2
> 前置: v0.0.320 文件预览区功能已编码完成（Task 2/3），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页
- workspace 目录内有足够多文件（≥8 个，如 `a.py`/`b.js`/`c.ts`/`d.md`/`e.json`/`f.txt`/`g.log`/`h.yaml`，可临时创建）

## 操作目标

1. 依次点击 8 个文件 → 预览区开 8 个 tab（顺序 a→h，最后一个激活）
2. 断言多 tab 渲染：
   - tab 区超容器宽度时可横向滑动（overflow-x-auto）
   - 右 chevron 按钮显示（有剩余内容）
3. 点右 chevron → tab 区右滚一屏；连续点直到末尾 → 右 chevron 隐藏（opacity/visibility 切换，不位移）
4. 点左 chevron → 左滚一屏；回到起始 → 左 chevron 隐藏
5. 点击中间某 tab（如 d）→ 激活切换正常，内容区显示对应文件
6. 截图留证：初始 8 tab + 右滚后 + 末尾（右 chevron 隐藏）+ 左滚回起始 + 切 tab

## 判定
- pass: 多 tab 横滑正常、左右按钮显隐正确（有剩余显示/无剩余隐藏）、tab 切换正常
- small: 横滑/切换正常但 chevron 显隐时机有小偏差（非功能阻断）
- blocking: tab 不能横滑 / chevron 不显示或一直显示 / 点 tab 不切换

## 备注
- 按钮显隐用 opacity/visibility 切换（不位移，对齐 ws-act 范式，D5）
- tab 结构：fileName 短名 + × 关闭；active 高亮；dirty tab 显示 ●（本 case 无编辑，全无 ●）
