import { test, expect } from './fixtures.mjs';

// Affordance icons must be real SVG (SVG namespace) and actually paint pixels.
// An <svg> built with document.createElement lands in the XHTML namespace as an
// HTMLUnknownElement: it keeps its 12x12 box (so opacity/visibility checks pass)
// but draws nothing. These checks catch that.
// # parity: P-48, P-61

async function paintsPixels(locator) {
  const png = await locator.screenshot({ animations: 'disabled' });
  // Compare against the element's own background by sampling the PNG's distinct colors.
  return locator.page().evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 4) colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return colors.size;
  }, png.toString('base64'));
}

async function svgInfo(locator) {
  return locator.evaluate((el) => {
    const svg = el.matches('svg') ? el : el.querySelector('svg');
    return { ns: svg?.namespaceURI, isSvg: svg instanceof SVGSVGElement };
  });
}

test('P-48 the session-row rename pencil is a real SVG that paints on hover', async ({ app, page }) => {
  await app.open();
  const row = page.locator('.row').first();
  await row.hover();
  const pencil = row.locator('.row-edit-icon');
  await expect(pencil).toBeVisible();
  expect(await svgInfo(pencil)).toEqual({ ns: 'http://www.w3.org/2000/svg', isSvg: true });
  expect(await paintsPixels(pencil)).toBeGreaterThan(1);
});

test('P-61 project-slot pencil and × are real SVGs that paint', async ({ app, page }) => {
  await app.open();
  await app.press('p');
  const panel = page.locator('.proj-panel');
  const emptySlot = panel.locator('.proj-slot[data-slot="3"]');
  const namedSlot = panel.locator('.proj-slot[data-slot="1"]');
  expect(await svgInfo(emptySlot.locator('.proj-edit-icon'))).toEqual({ ns: 'http://www.w3.org/2000/svg', isSvg: true });
  expect(await paintsPixels(emptySlot.locator('.proj-edit-icon'))).toBeGreaterThan(1);
  await namedSlot.hover();
  const clear = namedSlot.locator('.proj-clear');
  await expect(clear).toBeVisible();
  expect(await svgInfo(clear)).toEqual({ ns: 'http://www.w3.org/2000/svg', isSvg: true });
  expect(await paintsPixels(clear)).toBeGreaterThan(1);
});
