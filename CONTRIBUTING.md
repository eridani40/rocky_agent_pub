# Contributing to Rocky Agent

Thanks for your interest in contributing! 🚀 Rocky Agent is a **spec-driven** project — this guide helps your contribution land smoothly.

## Development setup

Requires [Bun](https://bun.sh) ≥ 1.3 and Node ≥ 22.

```bash
git clone https://github.com/eridani40/rocky_agent_pub && cd rocky_agent_pub
bun install                       # also installs playwright chromium
cp dev.env.example dev.env        # fill in ports; LLM keys are configured in-app, not via env
bun run gen-version
bash scripts/run-dev.sh           # start backend API + renderer
```

Launch the app → **Settings → Providers** → configure an LLM provider. Keys stay local under `DATA_DIR`.

## Spec-driven workflow

Rocky Agent is **spec-first**: features are designed in `specs/` *before* any code is written.

| Directory | Holds |
|-----------|-------|
| `specs/prd/` | product requirements |
| `specs/tech/` | technical architecture (per-subsystem knowledge bases) |
| `specs/api/` | HTTP contracts |
| `specs/ui/` | UI contracts & component specs |

`specs/` is the source of truth — code implements specs, not the other way around. Before writing code for a new feature, check `specs/`. If the concept isn't there yet, **open an issue** to propose it first.

## Before opening a PR

1. **Type-check & test**
   ```bash
   bun run typecheck
   bun run test
   ```
2. **Code style**
   - One responsibility per file; keep files focused (~300 lines max per file).
   - Match the surrounding code's naming and conventions.
3. **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` new feature · `fix:` bug fix · `docs:` · `refactor:` · `perf:` · `chore:`
4. **Update specs** if your change alters user-visible behavior or any contract — specs must stay aligned with code.

## PR process

1. Fork → feature branch (`feat/...`, `fix/...`).
2. Open a PR against `main`; fill in the PR template.
3. Make sure typecheck is green.

## Issues

Use the issue templates (bug report / feature request). For LLM-behavior bugs, please include:
- the **provider + model** used,
- a **minimal reproduction** (what you did, what you expected, what happened),
- Rocky Agent version or commit.

## License

By contributing, you agree your contributions are licensed under the [MIT license](LICENSE).
