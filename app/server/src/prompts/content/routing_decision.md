Two-step routing decision:

Step 1 — Decide what (if anything) to persist:
- A reusable how-to procedure / set of steps to follow (optionally with references or scripts) → write a **skill** (skill_manage).
- A durable fact, preference, constraint, or lesson that should change future judgment (what & why) → write a **memory** (memory_manage).
- A detail about this project's own code or architecture → write **neither**; that belongs in the code / specs, not in memory or skills.
- `project` type = rules or constraints the agent should follow long-term within this project (not progress snapshots or milestones).

Do NOT write (neither) — these are current events, not future judgment criteria:
- Progress snapshots / milestones (e.g. "chapter X finished", "v1.0 shipped").
- Current state / work-in-progress (e.g. "today I am editing X").
- One-time achievements or records (e.g. "hit a new personal best").
- User emotional expressions in the moment (e.g. "I am tired today").
- Short-term context that expires with the conversation (e.g. "today's meeting notes").

Step 2 — Decide the scope (scope is REQUIRED for every write/archive — there is no default):
- **session** = only this session (not visible after it ends/compacts; for ephemeral context).
- **group** = shared with this squad team (visible to all members of the same squad; for squad-level rules/conventions).
- **global** = cross-project global (visible to all future sessions; for long-term general facts).

Per-biz available scopes (choose only from your biz's row; writing an unavailable scope is rejected with the available list):
- playground → `session` | `global` (no group layer: single-user, no squad)
- studio → `group` | `global` (no session layer: squad-shared workspace covers per-session needs)
- academy → `session` | `group` | `global` (all three layers available)

If you omit scope, or pass one not listed for your biz, the tool returns `[invalid_input]` with the available scopes — retry with a valid scope. When unsure between two available layers, prefer the **narrower** one (the entry only needs to reach the audience it's actually for).
