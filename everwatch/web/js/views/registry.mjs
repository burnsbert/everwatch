// View registry: effective view / route name → factory. The content area
// mounts one entry at a time (instances are cached so scroll positions
// survive switching). Later packages replace the stub entries:
// grid (WP5), settings + diagnostics + onboarding (WP7 — done), projects (WP5).

import { createSplitView } from './split.mjs';
import { createListView } from './list.mjs';
import { createZoomView } from './zoom.mjs';
import { createUsageView } from './usage.mjs';
import { createGridView } from './grid.mjs';
import { createCompactView } from './compact.mjs';
import { createSettingsView } from './settings.mjs';
import { createDiagnosticsView } from './diagnostics.mjs';
import { createOnboardingView } from './onboarding.mjs';

export const registry = {
  split: (ctx) => createSplitView(ctx),
  list: (ctx) => createListView(ctx),
  zoom: (ctx) => createZoomView(ctx),
  usage: (ctx) => createUsageView(ctx),
  grid: (ctx) => createGridView(ctx),
  compact: (ctx) => createCompactView(ctx),
  settings: (ctx) => createSettingsView(ctx),
  diagnostics: (ctx) => createDiagnosticsView(ctx),
  onboarding: (ctx) => createOnboardingView(ctx),
};

/** Register or replace a view factory (extension point for WP5/WP7/WP8). */
export function registerView(name, factory) {
  registry[name] = factory;
}
