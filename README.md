# dsh-sdd-compass

[![CI](https://github.com/AndrewGanzha/dsh-sdd-compass/actions/workflows/ci.yml/badge.svg)](https://github.com/AndrewGanzha/dsh-sdd-compass/actions/workflows/ci.yml)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
shows where a project stands in its spec-driven development (SDD) flow — phase,
active change, tasks, drift warnings and the documents worth reading — right in
the composer dock, in the system prompt and through `/sdd`.

**Landing page:** https://andrewganzha.github.io/dsh-sdd-compass/

It does not replace OpenSpec or a spec workflow: it observes the artifacts those
tools already produce and turns them into a compass.

```
SDD ● реализация 4/7 ⚠2
```

Click the line to open the panel: phase ladder, next step, findings, statistics
(cycle time from git, drift over the last 7 days) and the document list.

## Supported practices

| practice | markers | reads |
| --- | --- | --- |
| `openspec` | `openspec/changes/*/` | proposal, specs, design, tasks, archive |
| `scratch` | `.scratch/<feature>/spec.md` + `issues/NN-*.md` | spec + `**Status:**` tickets |
| `ssc` | `model.json` (root or `docs/*/model.json`) | model, artifact reviews, open questions, `workflow.md` |

Phase ladder: `idle → proposal → spec → design → tasks → apply → verify → archive`.
A phase is a pure function of the artifacts on disk; nothing is invented.

## Install

1. Clone the repository next to your other plugins:

   ```bash
   git clone https://github.com/AndrewGanzha/dsh-sdd-compass.git
   ```

2. Register the bundle in the profile (or use **Plugins → Add plugin** and pick
   the directory):

   ```jsonc
   // ~/.dsh/profiles/desktop/package.json
   "dsh": { "profile": { "bundles": ["...", "dsh-sdd-compass"] } },
   "dependencies": { "dsh-sdd-compass": "link:C:/path/to/dsh-sdd-compass" }
   ```

3. Reload the window (`Ctrl+R`). The Host half applies as soon as the bundle is
   enabled; the dock and panel appear after the page reload.

## Configure

Optional `.sdd/config.json` in the project (created by `/sdd init`):

```jsonc
{
  "practice": "auto",          // auto | openspec | scratch | ssc
  "change": "auto",            // auto = freshest unfinished change
  "strictness": "warn",        // quiet | info | warn | gate
  "staleAfterDays": 14,
  "language": "ru",
  "docs": { "roots": ["docs", "openspec/specs"], "maxItems": 5 },
  "checks": { "drift": true, "archive": true, "stale": true, "statuses": true, "trace": true },
  "stats": { "git": true, "drift": true, "cacheSeconds": 600 },
  "trace": { "roots": ["src", "app", "lib", "tests", "test", "packages"], "maxFiles": 800 }
}
```

### Strictness

| value | behaviour |
| --- | --- |
| `quiet` | dock and `/sdd` only |
| `info` | + prompt section and session-start briefing |
| `warn` (default) | + one model-facing warning after a code write in a pre-implementation phase |
| `gate` | + refuse `write`/`edit` of non-artifact files in `proposal`/`spec`/`design` with a reason |

`gate` is opt-in per project; the default never blocks a tool call.

## Surfaces

- **Dock line** — phase, task progress and warning count; hidden when the
  project has no SDD markers or no active change.
- **Panel** — action-first: `Сейчас` (actions and top findings), `Задачи`
  (kanban), `Ещё` (documents, projects, metrics).
- **System prompt section** — one short, byte-stable line with the phase, next
  step and rule for the current phase (`Код не менять до утверждённой спеки`).
- **Session-start briefing** — one `agent.inject()` message with the change and
  the documents to read first.
- **`/sdd`** — `status | next | advance | archive | check | docs | stats | report | digest | projects | init | refresh | help`.
- **Tools** — `sdd_status`, `sdd_check`, `sdd_projects`, `sdd_digest`, `sdd_tasks` and `sdd_task_move` for the model.

## Panel actions

- **«+ Задача»** — opens a fresh chat in the project with a grilling prompt
  (the Host creates the session and sends the first message). If the project
  has no `grilling` skill, the prompt points to
  [basic-skills](https://github.com/AndrewGanzha/basic-skills/tree/main/skills/grilling).
- **«Дальше» / «Проверить»** — ask the agent in the current chat to call
  `sdd_status` / `sdd_check`; the Host injects the instruction.
- **«Заархивировать»** — copies the exact `openspec archive …` command.
- **«Начать задачу»** — moves the next queued task to work and opens a chat
  with it (also from the task card).
- **«Открыть» / «Файл» / «Папка»** — open the document, task file or project
  folder with the host's default application.

`/sdd advance` prints the exact command for the next step (for example
`openspec archive --change <name>`); the plugin never executes the CLI itself,
the person runs and confirms it.

## Traceability

Annotate code and tests with `@sdd`:

```ts
// @sdd FR-012          — links to an SSC requirement
// @sdd composition-contour-and-fields — links to an OpenSpec change
```

The scanner reads `trace.roots` (bounded to `trace.maxFiles`, 10-minute cache)
and reports:

- `trace.unknown` — an annotation references an ID that does not exist;
- `trace.orphan` — SSC requirements without any `@sdd` annotation;
- `trace.unannotated` — the changed code carries no annotations while the
  change is in `apply`/`verify`.

### Impact map

OpenSpec proposals can declare the files a change touches under `## Impact`.
The compass compares that list with the working tree:

- `link.impact-missed` — Impact lists paths, but no changed file matches them;
- `link.untracked` — a code file changed outside Impact and without `@sdd`.

Both rules stay quiet until the change reaches `apply`/`verify`.

## CI

Fail a pipeline when the project drifts:

```bash
node scripts/check.js . --ci                 # exit 1 on warn or error
node scripts/check.js . --ci --fail-on error # exit 1 on error only
node scripts/check.js . --json --ci          # machine-readable + exit code
```

`--ci` implies `--fail-on warn`; without it the exit code is always 0.
`--report` prints a Markdown summary ready for a chat or a ticket.

## Weekly digest

`/sdd digest [days]`, `node scripts/check.js . --digest 7` and the `sdd_digest`
tool produce a Markdown digest of the window: changes archived and started,
commits with code versus artifacts, drift files, cycle median, the current
phase and the findings. It stays honest when git is unavailable.

To deliver it weekly, create a DSH scheduled task whose prompt asks for the
digest (for example "Сделай недельный SDD-дайджест проекта: вызови sdd_digest
и пришли результат"). The plugin never creates schedules by itself.

## Task board

The **Задачи** tab is a small kanban of the active change:

- columns: `Очередь`, `В работе`, `Проверка`, `Готово`;
- cards come from scratch tickets (`**Status:**`) and OpenSpec checkboxes;
- buttons move a task by rewriting **only** its status marker — the
  `**Status:**` value or one `[ ]`/`[x]` — the rest of the file stays intact;
- OpenSpec tasks are binary, so «Готово»/«Вернуть» toggle the checkbox, while
  «Начать» keeps the transient "in progress" state in `.sdd/board.json` and
  never touches `tasks.md`;
- «Начать» also opens a fresh chat in the project and sends the task as its
  first prompt (through the client session API; the button still moves the task
  if that API is unavailable);
- the same actions are exposed as `sdd_tasks` and `sdd_task_move`.

The board is honest about its source of truth: it edits the artifacts the
practice already uses, and never keeps a second copy of the status.

## Checks

- change not updated for longer than `staleAfterDays`;
- tasks done but the change not archived for 7+ days; OpenSpec archive never used;
- code writes/commits in `proposal`/`spec`/`design` (drift);
- scratch tickets never started, or closed with open checkboxes;
- SSC artifact reviews pending, blocking open questions, broken `model.json`;
- `@sdd` annotations with unknown IDs, missing requirement coverage, or changed
  code without any annotation;
- changed code outside the proposal's `## Impact`;
- documents for changed modules are surfaced with the reason
  `документация изменённого модуля`.

Nothing blocks by default; findings appear in the dock, the prompt and `/sdd check`.

## Safety

- Read-only over project sources; the only write is `.sdd/config.json` on
  `/sdd init`, and it never overwrites.
- No network calls, no telemetry, no credentials; the web route answers only
  the current session's project and returns paths, never file contents.
- Git is optional: without it, cycle-time statistics degrade to `мало данных`.

## Development

```bash
node --check index.js && node --check client.js
node test/host.test.mjs        # fixtures: openspec, scratch, ssc, docs, trace, plain
node scripts/check.js <path> --stats --prompt --report
node scripts/check.js <path> --ci --fail-on warn
```

## License

MIT.
