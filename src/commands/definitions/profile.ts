/**
 * Profile command definitions.
 *
 * Registers the credential-manager commands with the app-level registry so
 * they are reachable from the command palette, menus, and keyboard shortcuts.
 *
 * OCP: adding a new profile command = one `registry.register(def)` call here.
 */

import { registry } from "../registry";

// ---------------------------------------------------------------------------
// profile.add
// ---------------------------------------------------------------------------

registry.register({
  id: "profile.add",
  title: "Add Profile",
  group: "Profile",
  description: "Create a new credential profile.",
  run(_ctx) {
    // The run handler dispatches a custom DOM event so the Profiles sidebar
    // can react without a direct import dependency.  The sidebar mounts an
    // event listener for "profile:open-editor" and opens the ProfileEditor.
    window.dispatchEvent(
      new CustomEvent("profile:open-editor", { detail: { mode: "create" } }),
    );
  },
});

// ---------------------------------------------------------------------------
// profile.validate
// ---------------------------------------------------------------------------

registry.register({
  id: "profile.validate",
  title: "Validate Profile",
  group: "Profile",
  description: "Run a credential validation probe for the selected profile.",
  run(ctx) {
    const profileId =
      typeof ctx.profileId === "string" ? ctx.profileId : undefined;
    if (profileId === undefined) return;
    window.dispatchEvent(
      new CustomEvent("profile:validate", { detail: { profileId } }),
    );
  },
});

// ---------------------------------------------------------------------------
// profile.delete
// ---------------------------------------------------------------------------

registry.register({
  id: "profile.delete",
  title: "Delete Profile",
  group: "Profile",
  description: "Delete the currently selected profile.",
  run(ctx) {
    const profileId =
      typeof ctx.profileId === "string" ? ctx.profileId : undefined;
    if (profileId === undefined) return;
    window.dispatchEvent(
      new CustomEvent("profile:delete", { detail: { profileId } }),
    );
  },
});
