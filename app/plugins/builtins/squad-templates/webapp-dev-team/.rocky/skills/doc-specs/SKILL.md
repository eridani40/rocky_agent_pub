---
name: doc-specs
description: Documentation standards and specifications for AI agent development projects. Use when creating or updating research reports, PRD, technical design, API docs, UI protocol docs, or version logs.
---

# Doc Specs

## Purpose

定义项目各类文档的规范与模板，确保文档结构一致、版本可追溯、内容完整。

## When to Use This Skill

Automatically activates when:
- 创建或更新调研报告
- 创建或更新 PRD 文档
- 编写或维护技术设计文档
- 编写或维护 API 文档
- 编写或维护 UI 协议文档
- 记录版本变更日志

---

## OKF：tech specs 的组织方法

**`${SPECS_DIR}/tech/` 用 OKF（Open Knowledge Format）组织**——每个子系统目录 = 一个 OKF 知识库（KB）：
- 方法本身（业务无关）见 **`.rocky/skills/okf-skill/`**；tech 怎么用 OKF 见 **`references/tech-spec-rules.md`**（权威：index 5 章 + 单文件章节 + frontmatter + 两套 log）。
- 核心：每 KB 一个 `index.md`（总起）+ `log.md`（变更倒序）；每文件 YAML frontmatter（`type` 必填 + priority/status/updated）；**正文 = 当前现状，变更去 log**（不再满篇 inline `[vX.Y]`）。
- prd / api / ui **暂仍用** `overall/` + `version_logs/`（可后续按需迁 OKF）。

---

## 项目文档目录

> 文档根目录 = 变量区 `${SPECS_DIR}`（团队 AGENTS.md 定义，默认 `specs/`）。以下用 `${SPECS_DIR}` 代指项目文档根。

所有项目文档统一存放在项目根目录的 `${SPECS_DIR}` 下：

```
${SPECS_DIR}/
├── research/                       # 调研报告（researcher 产出）
│   └── ${SLUG}.md
├── prd/
│   ├── overall/                    # 全量产品文档（prd 产出）
│   │   ├── 01-product-framework.md
│   │   └── ...
│   └── version_logs/
│       └── v${VERSION}/change_log.md
├── tech/                           # ★ OKF 知识库（每个子系统目录=一个 KB；见 okf-skill + tech-spec-rules）
│   ├── index.md                    # 顶层总起（子系统导航）
│   ├── ${SUBSYSTEM}/                    # 一个 KB：squad / agent / app / ...
│   │   ├── index.md                # 子系统总起（5 章：是什么/边界/关系/原则/导航）
│   │   ├── log.md                  # 本目录变更（ISO 倒序）
│   │   └── ${TOPIC}.md              # spec 文件（frontmatter + 正文=现状）
│   └── version_logs/
│       └── v${VERSION}/change_log.md  # 跨版本发布说明（保留，§两套 log）
├── api/
│   ├── overall/                    # API 全量文档（arch 产出，coder 细化）
│   │   ├── 01-sessions.md
│   │   └── ...
│   └── version_logs/
│       └── v${VERSION}/change_log.md
├── ui/
│   ├── overall/                    # UI 协议文档（coder 产出；含 app-guide 作 ET executor 导航底图）
│   │   ├── ${PAGE_NAME}.md
│   │   └── ...
│   └── version_logs/
│       └── v${VERSION}/change_log.md
```

### 说明

1. **research/** 是调研报告，feature 开发前由 researcher 产出，无 overall/version_logs 结构
2. **overall** 是全量文档，反映系统当前最新全貌。每版本交付后由 doc-modifier 同步更新
3. **version_logs** 是增量文档，记录每个版本的变更差异
4. **api/** 关注「怎么调用」，**ui/** 关注「怎么观测」，两者都是测试的唯一依据
5. **编号前缀**（01-、02-...）保证目录排序稳定

---

## 文档体系

### tech（OKF）：现状 / 变更分离
- **正文 = 现状**：spec 文件正文只描述"当前是什么"，无版本史。
- **变更两套 log**：per-KB `log.md`（位置轴，目录级，倒序精简）+ 跨版本 `version_logs/vX.Y/change_log.md`（版本轴，发布说明，详）。见 `tech-spec-rules.md §4`。

### prd / api / ui（未迁 OKF）：全量 + 增量
- **全量 overall/**：当前全貌，条目标注 `[vX.Y]`，就地更新。
- **增量 version_logs/**：每版本一目录 `change_log.md`。

---

## 文档产出链路

```
researcher → ${SPECS_DIR}/research/（调研报告）
prd → prd/overall + prd/version_logs
    → arch 读 prd 产出 tech/ + api/
    → coder 读 tech/ 编码并细化 api/ + 产出/更新 ui/
    → api-test-designer 读 api/ 写 mjs case / api-test-executor 起 env + node --test 验证（不看代码）
    → ET（范式）：orchestrator 委派 e2e-test-executor，executor 用 playwright-cli 按 case.md + app-guide 玩 app（不看代码，留证 + 自由心证）
    → doc-modifier 最终同步所有 overall
```

---

## 核心规则

1. **tech 按 OKF**：目录组织 + index/log + frontmatter + 现状/log 分离，权威见 `references/tech-spec-rules.md`。下列为通用规则。
2. **按领域拆分不按版本拆分**：同一主题归一处"当前现状"，禁 v014/v015 分文件。
3. **双线对齐**：PRD ↔ Tech ↔ API 可互相追溯。
4. **语言**：中文为主，术语和代码保留英文。
5. **代码路径标注**：描述流程时用 `文件.方法() → 文件.方法()` 格式（精确到源文件+方法）。
6. **写作质量红线**：设计思路非废话、接口必解释、JSON 禁 `...` 省略关键字段（详 `tech-spec-rules §6`）。
7. **版本标注分轨**：
   - tech → inline `[vX.Y]` 退役，版本信息进 frontmatter `since` + 两套 log（per-KB `log.md` + `version_logs/`）。
   - prd/api/ui（未迁 OKF）→ 仍 `[vX.Y]` 引入 / `[vX.Y modified]` 修改 + overall 就地追加。

## 行数预算

- **tech**：`index.md` 60–120 行硬上限；spec 文件按主题，超长按子主题下沉 topic 文件。
- **prd/api/ui**：单文件 **300–500 行**（下限保内容充实，上限防臃肿，超出按领域拆分）。

---

## Reference Files

- [research-spec-rules.md](references/research-spec-rules.md) - 调研报告规范
- [prd-spec-rules.md](references/prd-spec-rules.md) - PRD 文档规范
- [tech-spec-rules.md](references/tech-spec-rules.md) - 技术设计文档规范（**OKF 版**：目录组织/index/log/frontmatter）
- [ui-spec-rules.md](references/ui-spec-rules.md) - UI 协议文档规范
- **OKF 方法本身（业务无关）**：`.rocky/skills/okf-skill/SKILL.md` — tech specs 的底层组织方法

---

**Skill Status**: INITIALIZED
