import { test, expect, FIXTURE } from './fixtures.mjs';

const NOW = FIXTURE.now;

// # parity: P-19
test('P-19 toolbar shows an amber waiting pill that runs next-waiting, the title count, and (D3) the counts in the status bar', async ({ app, page }) => {
  await app.open();
  // D3: the `N tabs · N agents` counts moved from the brand to the status bar
  await expect(page.locator('#statusbar #counts')).toHaveText('9 tabs · 6 agents');
  await expect(page.locator('.toolbar #counts')).toHaveCount(0);
  await expect(page.locator('.brand')).toBeVisible(); // browser mode keeps the brand
  const pill = page.locator('#waiting-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText('2 waiting');
  await expect(page).toHaveTitle('Everwatch — 2 waiting');
  // amber: pill text uses the attention token
  const color = await pill.evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe('rgb(255, 175, 0)');

  await app.row('2.1').click();
  await pill.click();
  await expect(app.row('1.1')).toHaveClass(/is-selected/);
  await pill.click();
  await expect(app.row('1.3')).toHaveClass(/is-selected/);

  app.backend.setState((s) => ({
    counts: { ...s.counts, waiting: 0 }, waiting_order: [],
    sessions: s.sessions.map((x) => (x.state === 'waiting' ? { ...x, state: 'idle', attention: false } : x)),
  }));
  await expect(pill).toBeHidden();
  await expect(page).toHaveTitle('Everwatch');
});

// # parity: P-20
test('P-20 status chip: Live, STALE on query error, STALE {age}, iTerm2 not running — with tooltip and Diagnose', async ({ app, page }) => {
  await app.open();
  const chip = page.locator('#status-chip');
  await expect(chip).toHaveText('Live');
  await expect(chip).toHaveAttribute('data-level', 'ok');

  app.backend.setState({ iterm: { status: 'ok', error: '', snapshot_at: NOW - 10 } });
  await expect(chip).toHaveText('STALE 10s');
  await expect(chip).toHaveAttribute('data-level', 'warn');
  await expect(chip).toHaveAttribute('title', /No fresh iTerm2 snapshot for 10 seconds/);

  app.backend.setState({ iterm: { status: 'error', error: 'osascript exited 1', snapshot_at: NOW - 1 } });
  await expect(chip).toHaveText('STALE');
  await expect(chip).toHaveAttribute('title', /osascript exited 1/);

  app.backend.setState({ iterm: { status: 'not_running', error: '', snapshot_at: 0 } });
  await expect(chip).toHaveText('iTerm2 not running');
  await expect(chip).toHaveAttribute('data-level', 'danger');

  await chip.click();
  const pop = page.locator('#status-pop');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('iTerm2 isn’t running');
  await pop.getByRole('button', { name: 'Diagnose…' }).click();
  await expect(pop).toBeHidden();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'diagnostics');
  await app.press('Escape');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'empty');
});

// # parity: P-20
test('P-20 status chip shows Reconnecting… when the event stream drops', async ({ app, page }) => {
  app.allowErrors(/503/);
  await app.open({ pause: false });
  const chip = page.locator('#status-chip');
  await expect(chip).toHaveText('Live');
  await expect.poll(() => app.backend.clientCount).toBe(1);
  app.backend.opts.sseReject = true;
  app.backend.dropClients();
  await expect(chip).toHaveText('Reconnecting…');
  await expect(chip).toHaveAttribute('data-level', 'warn');
  app.backend.opts.sseReject = false;
  await expect(chip).toHaveText('Live', { timeout: 10000 });
  await expect.poll(() => app.backend.clientCount).toBe(1);
});

// # parity: P-21 (retired T046: user feedback — no toolbar quota chip; every
// warning lives in the bottom Tokens Used strip instead. See tokens.spec.mjs.)
test('T046 the toolbar has no token/quota chip — the header ends with the theme toggle and page buttons', async ({ app, page }) => {
  await app.open();
  await expect(page.locator('#token-chip')).toHaveCount(0);
  await expect(page.locator('.toolbar')).not.toContainText(/runs out|limit reached/);
  await expect(page.locator('#btn-theme')).toBeVisible();
});

// # parity: P-19 (D3)
test('P-19 shell mode hides the brand (the native title bar already says Everwatch); the status text never shrinks', async ({ app, page }) => {
  await app.open({ shell: true });
  await expect(page.locator('.brand')).toBeHidden();
  const chip = page.locator('#status-chip');
  await expect(chip).toHaveText('Live');
  await expect(chip).toHaveCSS('flex-shrink', '0');
  // below 820px only the dot shows; the words stay in the accessible name
  await page.setViewportSize({ width: 760, height: 700 });
  await expect(page.locator('#status-text')).toBeHidden();
  await expect(chip).toHaveAttribute('aria-label', /^Status: Live\./);
});
