import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile, writeFile } from 'node:fs/promises';
const fixture = JSON.parse(await readFile(new URL('../../examples/research-workflow.json', import.meta.url)));
const key = 'workflow-canvas.theme';
async function seed(request) {
  const created = await request.post('/api/workflows', { data: { title: fixture.title } });
  expect(created.ok()).toBeTruthy();
  const doc = await created.json();
  doc.nodes = fixture.nodes.map(n => ({ instructions: '', spec: '', inputs: [], outputs: [], acceptanceCriteria: [], inferred: false, ...n }));
  doc.edges = fixture.edges.map(e => ({ inferred: false, ...e }));
  const saved = await request.put(`/api/workflows/${doc.id}`, { data: doc });
  expect(saved.ok()).toBeTruthy();
  return saved.json();
}
async function opened(page, request) {
  const doc = await seed(request);
  await page.goto(`/?w=${doc.id}`);
  await expect(page.locator('.card')).toHaveCount(fixture.nodes.length);
  return doc;
}
async function theme(page, value) { await expect(page.locator('html')).toHaveAttribute('data-theme', value); }

test('Light default; keyboard selector, persistence, collapsed rail and system changes', async ({ page, request }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const doc = await opened(page, request);
  await theme(page, 'light');
  const select = page.getByRole('combobox', { name: 'Theme', exact: true });
  // Reach the selector with real Tab navigation, not programmatic focus.
  for (let i = 0; i < 40 && !(await select.evaluate(e => e === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(select).toBeFocused();
  expect(await select.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('solid');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await theme(page, 'dark');
  await expect.poll(() => page.evaluate(k => localStorage.getItem(k), key)).toBe('dark');
  await page.reload(); await theme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' }); await theme(page, 'dark');
  await select.selectOption('system'); await theme(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' }); await theme(page, 'dark');
  await page.reload(); await theme(page, 'dark');
  await expect(select).toHaveValue('system');
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(select).toBeVisible();
  await select.selectOption('light');
  await page.emulateMedia({ colorScheme: 'dark' }); await theme(page, 'light');
  await page.reload(); await theme(page, 'light');
  // Theme changes are presentation only: no revisions or graph changes.
  expect(await (await request.get(`/api/workflows/${doc.id}`)).json()).toEqual(doc);
});

test('corrupt and unavailable storage recover to Light and remain usable', async ({ page, request }) => {
  await page.addInitScript(k => localStorage.setItem(k, 'not-a-theme'), key);
  await opened(page, request); await theme(page, 'light');
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
  await page.reload(); await theme(page, 'light');
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark'); await theme(page, 'dark');
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await page.reload(); await theme(page, 'light');
});

for (const mode of ['light', 'dark']) test(`${mode}: cards, edges, menus, details, warnings, contrast`, async ({ page, request }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const doc = await opened(page, request);
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(mode);
  await theme(page, mode);
  await page.locator('.row-item--active').getByRole('button', { name: 'Actions for ' + fixture.title }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath(`${mode}-menu-canvas.png`), fullPage: true });
  const menuAudit = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(menuAudit.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await page.locator('[data-id="research"] .card').click();
  await expect(page.getByRole('complementary', { name: 'Card details' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Check 2 link', exact: true }).fill('javascript:bad');
  await expect(page.locator('.field-error')).toContainText('Not saved');
  await page.locator('.field-error').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`${mode}-details-warning.png`), fullPage: true });
  const audit = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(audit.violations).toEqual([]);
  await page.getByRole('button', { name: 'Close details' }).click();
  // Markers and paths share CSS tokens and update without rebuilding graph state.
  for (const kind of ['requires', 'data', 'conditional', 'revision']) {
    const edge = page.locator(`.edge--${kind}`).first();
    const colors = await edge.evaluate(el => {
      const path = el.querySelector('.react-flow__edge-path');
      const ref = path.getAttribute('marker-end');
      const marker = document.getElementById(ref.replace(/^url\(['"]?#/, '').replace(/['"]?\)$/, ''));
      if (!marker) throw new Error(`Missing marker ${ref}; available: ${Array.from(document.querySelectorAll('marker')).map(m => m.id)}`);
      return [getComputedStyle(path).stroke, getComputedStyle(marker.querySelector('polyline')).fill];
    });
    expect(colors[0]).toBe(colors[1]);
  }
  await page.getByRole('button', { name: 'Fit View', exact: true }).click();
  await page.locator('.edge--conditional .react-flow__edge-textbg').click();
  await page.getByRole('textbox', { name: 'Condition (required)' }).fill('');
  await expect(page.locator('.field-error')).toContainText('needs a condition');
  await page.screenshot({ path: info.outputPath(`${mode}-arrow-warning.png`), fullPage: true });
  const arrowAudit = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(arrowAudit.violations).toEqual([]);
  await page.getByRole('button', { name: 'Close details' }).click();
  // A real optimistic-lock conflict exercises the warning banner, not an injected DOM fixture.
  const current = await (await request.get(`/api/workflows/${doc.id}`)).json();
  expect((await request.put(`/api/workflows/${doc.id}`, { data: { ...current, title: 'Changed elsewhere' } })).ok()).toBeTruthy();
  await page.getByRole('textbox', { name: 'Workflow title' }).fill('Stale local edit');
  await expect(page.getByRole('alert')).toContainText('not saved');
  await page.screenshot({ path: info.outputPath(`${mode}-conflict-warning.png`), fullPage: true });
  const warningAudit = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(warningAudit.violations).toEqual([]);
  await info.attach('contrast-audits', { body: JSON.stringify({ menu: menuAudit, card: audit, arrow: arrowAudit, warning: warningAudit }, null, 2), contentType: 'application/json' });
  const ratios = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    function lum(token) {
      let hex = css.getPropertyValue(token).trim().slice(1);
      if (hex.length === 3) hex = Array.from(hex, c => c + c).join('');
      const c = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
    }
    function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
    return [
      ...['requires', 'data', 'conditional', 'revision'].map(k => ({ name: `edge ${k}`, ratio: ratio(`--edge-${k}`, '--bg'), minimum: 3 })),
      ...['task', 'agent', 'integration', 'approval', 'artifact', 'note'].map(k => ({ name: `kind ${k}`, ratio: ratio(`--kind-${k}`, k === 'note' ? '--note-bg' : '--surface'), minimum: 4.5 })),
      ...['--surface', '--bg', '--sidebar'].map(bg => ({ name: `focus ${bg}`, ratio: ratio('--accent', bg), minimum: 3 })),
      { name: 'button', ratio: ratio('--on-button', '--button'), minimum: 4.5 },
      { name: 'button hover', ratio: ratio('--on-button', '--button-hover'), minimum: 4.5 },
    ];
  });
  for (const result of ratios) expect(result.ratio, result.name).toBeGreaterThanOrEqual(result.minimum);
  await writeFile(info.outputPath(`${mode}-contrast.json`), JSON.stringify({ ratios, audits: { menu: menuAudit, card: audit, arrow: arrowAudit, warning: warningAudit } }, null, 2));
  expect(errors).toEqual([]);
});
