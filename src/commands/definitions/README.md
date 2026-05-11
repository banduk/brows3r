# Command Definitions

Command definitions live in this directory, organized by feature group.

## Convention

Each file in this directory is responsible for one feature group (e.g.
`profile.ts`, `file.ts`, `view.ts`). Each file imports the shared `registry`
singleton from `../registry` and calls `registry.register(def)` for each
command it owns.

## Adding a new command

1. Create or open the relevant group file (e.g. `src/commands/definitions/file.ts`).
2. Call `registry.register({ id, title, group, defaultShortcut?, run })`.
3. If the command has a baseline shortcut, add it to
   `src/commands/shortcuts.ts` under `BASELINE_SHORTCUTS` and update the
   fixture at `src/commands/__fixtures__/baseline-shortcuts.proposal.json`.

## Registration order

Files register their commands at module load time. The app entry point
imports each definition file to trigger registration before the UI renders.

## Example

```ts
import { registry } from "../registry";

registry.register({
  id: "file.open",
  title: "Open",
  group: "File",
  run(_ctx) {
    // implementation
  },
});
```
