#!/usr/bin/env node
// Regenerates docs/screenshots/*.png (README's hero image and feature
// tour) headlessly and deterministically (docs/DESIGN.md §7 WP9 row).
//
// Each screenshot spawns its own real `python3 -m everwatch serve --demo`
// process (tests/e2e/real/backend.mjs) on the same fixed clock as the
// golden fixture, so pixels don't drift between runs. Headless Chromium
// only: no visible window is ever opened, the real display is never
// touched, and nothing plays a sound (EVERWATCH_NO_SOUND=1, set by
// spawnBackend itself).
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnBackend, apiClient } from '../tests/e2e/real/backend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const VIEWPORT = { width: 1280, height: 800 };

/** Spawn a fresh demo backend, open a page against it, run `act`, and
 * save `<name>.png`. A fresh backend per shot (rather than one shared
 * server) keeps each screenshot's prefs independent -- e.g. onboarding
 * needs `onboarding_done: false` (the real seeded default) while every
 * other shot wants it patched to `true` -- and matches how a user
 * actually encounters each screen. */
async function shot(browser, name, { colorScheme = 'dark', onboardingDone = true, query = '', prefs = null, viewport = VIEWPORT, act } = {}) {
  const server = await spawnBackend({ demoDiagnostics: 'all_ok' });
  try {
    const { status, data } = await apiClient(server).getState();
    if (status !== 200 || data?.mode !== 'demo' || data.sessions?.length !== 9
        || !data.sessions.every((session) => session.path === '~' || session.path?.startsWith('~/src/'))) {
      throw new Error('Screenshot backend did not return the expected sample sessions');
    }
    if (onboardingDone || prefs) {
      await apiClient(server).patchPrefs({ ...(onboardingDone ? { onboarding_done: true } : {}), ...prefs });
    }
    const page = await browser.newPage({ viewport, colorScheme, reducedMotion: 'reduce' });
    await page.goto(`${server.url}/${query}#t=${encodeURIComponent(server.token)}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 10000 });
    // The SSE connection (sse.mjs) finishes its handshake asynchronously
    // after data-ready flips (that only waits for the first GET /api/state),
    // and the status chip reads "Connecting…" until it does -- a real,
    // bimodal (not merely cosmetic) source of flaky pixels. Wait for "Live"
    // so every shot is taken in the same steady state.
    await page.waitForFunction(() => document.getElementById('status-chip')?.textContent?.includes('Live'), null, { timeout: 10000 });
    await page.evaluate(() => document.fonts.ready);
    if (act) await act(page);
    // Two rAF ticks: lets a just-resolved `<use href="#i-...">` sprite
    // reference (or any render triggered by `act`) settle into a stable
    // painted frame before the screenshot, so pixels don't flake between
    // runs (docs/DESIGN.md §7 WP9 row: "deterministic PNGs").
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const dest = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: dest, animations: 'disabled' });
    await page.close();
    return dest;
  } finally {
    await server.stop();
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  // Text/border anti-aliasing args: without these, Chromium's rasterizer
  // occasionally nudges a handful of edge pixels by +/-1-2 out of 255
  // between runs (LCD subpixel AA hinting-cache warmup) even though the
  // underlying DOM/paint is identical -- these flags make that go away.
  const browser = await chromium.launch({
    headless: true,
    args: ['--force-color-profile=srgb', '--disable-lcd-text-antialiasing', '--disable-font-subpixel-positioning'],
  });
  const written = [];
  try {
    // Hero (picture element, dark/light srcset): the ordinary split view.
    written.push(await shot(browser, 'hero-dark', { colorScheme: 'dark' }));
    written.push(await shot(browser, 'hero-light', { colorScheme: 'light' }));

    // Feature tour, one shot per section (README "Feature tour"). Split
    // view's own feature is the resizable list/preview split (P-22), so
    // this shot -- unlike the hero, which is the plain default state --
    // uses a different split_ratio and selects a second session, so the
    // two screenshots are genuinely different pixels instead of duplicates.
    written.push(await shot(browser, 'split-dark', {
      colorScheme: 'dark', prefs: { split_ratio: 0.6 },
      act: async (page) => {
        const uid = await page.locator('.row').nth(1).getAttribute('data-uid');
        await page.locator('.row').nth(1).click();
        await page.waitForFunction((u) => document.querySelector('.preview')?.dataset.uid === u, uid);
      },
    }));
    written.push(await shot(browser, 'grid-dark', {
      colorScheme: 'dark',
      act: async (page) => { await page.keyboard.press('Meta+3'); await page.locator('.tile').first().waitFor(); },
    }));
    written.push(await shot(browser, 'usage-light', {
      colorScheme: 'light',
      act: async (page) => { await page.keyboard.press('u'); await page.locator('.usage-section').first().waitFor(); },
    }));
    written.push(await shot(browser, 'settings-light', {
      colorScheme: 'light',
      act: async (page) => { await page.locator('#btn-settings').click(); await page.locator('.settings-page').waitFor(); },
    }));
    written.push(await shot(browser, 'palette-dark', {
      colorScheme: 'dark',
      act: async (page) => { await page.keyboard.press('Meta+k'); await page.locator('#palette').waitFor(); },
    }));
    // 320x480: the CompactPanelController's own default NSPanel size
    // (shell/Sources/App/WebWindows.swift), so the shot matches the real
    // floating panel rather than a full-window-wide list.
    written.push(await shot(browser, 'compact-dark', {
      colorScheme: 'dark', query: '?mode=compact',
      viewport: { width: 320, height: 480 },
    }));
    written.push(await shot(browser, 'onboarding-light', { colorScheme: 'light', onboardingDone: false }));
  } finally {
    await browser.close();
  }
  for (const dest of written) console.log(path.relative(ROOT, dest));
  console.log(`wrote ${written.length} screenshots to docs/screenshots/`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
