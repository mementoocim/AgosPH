import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = 'http://127.0.0.1:8000/api';
const response = await fetch(`${base}/datasets`);
if (!response.ok) throw new Error('Local dataset catalog unavailable');
const datasets = (await response.json()).filter((d) => d.mode === 'imported');
const results = [];
for (const d of datasets) {
  const detail = await (await fetch(`${base}/datasets/${d.id}`)).json();
  if (!detail.source || !detail.provenance?.sha256) throw new Error(`Missing provenance: ${d.name}`);
  if (d.kind === 'vector') {
    const data = await (await fetch(`${base}/datasets/${d.id}/geojson`)).json();
    if (data.features.length !== d.feature_count) throw new Error(`Feature count mismatch: ${d.name}`);
  } else if (d.kind === 'raster') {
    const image = await fetch(`${base}/datasets/${d.id}/image.png`);
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (!image.ok || bytes[0] !== 137 || bytes[1] !== 80) throw new Error(`Raster preview failed: ${d.name}`);
  } else if (detail.records.length !== d.record_count) throw new Error(`Record count mismatch: ${d.name}`);
  results.push({ name: d.name, role: d.role, kind: d.kind, count: d.feature_count ?? d.record_count ?? [d.width, d.height], source_sha256: detail.provenance.sha256, checked: true });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Data mode')).toHaveValue('imported', { timeout: 30000 });
  await expect(page.getByTestId('main-map').locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  for (const name of [/rivers/i, /Barangay boundaries/i, /roads/i, /bridges/i, /buildings/i, /DEM elevation colors/i, /rainfall/i]) {
    await expect(page.getByRole('checkbox', { name })).toBeEnabled();
  }
  if (datasets.some((d) => d.role === 'facilities')) await expect(page.getByRole('checkbox', { name: /facilities/i })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: /inundation/i })).toBeDisabled();
  // Give asynchronous Cesium GeoJSON primitives a render opportunity for evidence.
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/ilagan-imported-layers.png', fullPage: true });
  await page.getByRole('button', { name: 'Close layers' }).click();
  await page.getByRole('button', { name: 'Rainfall', exact: true }).click();
  await expect(page.getByLabel('Rainfall station')).toContainText('NOT a gauge');
  await expect(page.getByLabel('Rainfall raster timestamp')).toBeVisible();
  await page.getByRole('button', { name: 'Animate rainfall layers' }).click();
  await expect(page.getByLabel('Rainfall raster timestamp')).not.toHaveValue('0', { timeout: 8000 });
  if (await page.getByRole('button', { name: 'Pause rainfall layers' }).count()) await page.getByRole('button', { name: 'Pause rainfall layers' }).click();
  await page.screenshot({ path: 'docs/ilagan-imported-rainfall.png', fullPage: true });
  if (pageErrors.length) throw new Error('Browser rendering errors: ' + pageErrors.join('; '));
  await fs.writeFile(path.join('data/public/ilagan', 'verification.json'), JSON.stringify({ checked_at: new Date().toISOString(), datasets: results, browser_checks: ['imported data mode', 'available layer controls', 'missing model inundation remains unavailable', 'historical rainfall series clearly named NOT a gauge', 'rainfall raster playback'], page_errors: pageErrors }, null, 2));
  console.log(JSON.stringify({ verified_datasets: results.length, page_errors: pageErrors, screenshots: ['docs/ilagan-imported-layers.png', 'docs/ilagan-imported-rainfall.png'] }));
} finally {
  await browser.close();
  const settings = await (await fetch(`${base}/settings`)).json();
  settings.layers.rainfall = { visible: false, opacity: .65 };
  await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
}
