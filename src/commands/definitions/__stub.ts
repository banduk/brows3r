/**
 * Stub registration — keeps the registry non-empty until real command
 * definition files are added (tasks 17+).
 *
 * Remove this file once at least one real definition file exists.
 */

import { registry } from "../registry";

registry.register({
  id: "app.about",
  title: "About brows3r",
  group: "Application",
  description: "Show version and build information.",
  run(_ctx) {
    // Implemented in task 17+ when the command palette arrives.
  },
});
