/**
 * Settings command definition.
 *
 * Registers `settings.open` with the app-level registry.
 * The command dispatches a custom DOM event so SettingsScreen can subscribe
 * without tight coupling to this definition.
 *
 * OCP: adding a new settings-related command = one more `registry.register`.
 */

import { registry } from "../registry";

registry.register({
  id: "settings.open",
  title: "Open Settings",
  group: "Settings",
  description: "Open the settings screen.",
  defaultShortcut: {
    mac: { key: ",", mod: ["cmd"] },
    default: { key: ",", mod: ["ctrl"] },
  },
  run(_ctx) {
    window.dispatchEvent(new CustomEvent("settings:open"));
  },
});
