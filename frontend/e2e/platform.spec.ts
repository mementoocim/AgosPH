import {test,expect} from '@playwright/test';
test.beforeEach(async({page,request})=>{
 const settings=await (await request.get('http://127.0.0.1:8011/api/settings')).json();
 await request.put('http://127.0.0.1:8011/api/settings',{data:{...settings,active_scenario:'demo-standard',data_mode:'demonstration',layers:{}}});
 await page.goto('/');await expect(page.getByRole('button',{name:'Play simulation',exact:true})).toBeVisible();
});

test('starts Cesium, plays temporal depth frames, inspects a cell, and compares aligned scenarios',async({page})=>{
 const workerErrors:string[]=[];
 page.on('console',m=>{if(m.type()==='error'&&/worker/i.test(m.text()))workerErrors.push(m.text());});
 page.on('pageerror',e=>{if(/worker/i.test(e.message))workerErrors.push(e.message);});
 await expect(page.getByLabel('Data mode')).toHaveValue('demonstration');
 await expect(page.getByText('Terrain off · flat ellipsoid reference surface')).toBeVisible();
 await expect(page.getByTestId('main-map').locator('canvas')).toBeVisible();
 await page.getByRole('button',{name:'Play simulation',exact:true}).click();
 await expect(page.getByLabel('Simulation timeline')).not.toHaveValue('0');
 await page.getByRole('button',{name:'Pause simulation',exact:true}).click();
 const paused=await page.getByLabel('Simulation timeline').inputValue();
 await page.waitForTimeout(1100);expect(await page.getByLabel('Simulation timeline').inputValue()).toBe(paused);
 await page.getByLabel('Playback speed').selectOption('2');
 await page.getByRole('button',{name:'Stop simulation',exact:true}).click();await expect(page.getByLabel('Simulation timeline')).toHaveValue('0');
 await page.getByLabel('Select simulation time step').selectOption('4');
 await page.getByRole('button',{name:'Collapse work panel',exact:true}).click();
 await page.getByTestId('main-map').locator('canvas').click({position:{x:640,y:450}});
 await expect(page.getByText('Location inspection',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Close location inspection'}).click();
 await page.getByRole('button',{name:'Simulation',exact:true}).click();
 await page.getByLabel('Comparison scenario').selectOption('demo-intense');await page.getByRole('button',{name:'Compare side by side',exact:true}).click();
 await expect(page.getByTestId('comparison-map').locator('canvas')).toBeVisible();
 await page.getByRole('button',{name:'Close comparison',exact:true}).first().click();
 // MapLibre parses every GeoJSON layer in a web worker; if it fails to load, 2D draws basemap tiles only.
 const worker=page.waitForResponse(r=>r.url().includes('maplibre-gl-worker'));
 await page.getByRole('button',{name:'Use 2D map'}).click();await expect(page.getByTestId('main-map').locator('.maplibregl-canvas')).toBeVisible();
 expect((await worker).status()).toBe(200);
 await page.waitForTimeout(1500);expect(workerErrors).toEqual([]);
});

test('replays measurements through a threshold and acknowledges and resolves a TEST alert',async({page,request})=>{
 await request.post('http://127.0.0.1:8011/api/monitoring/reset',{data:{}});
 await request.put('http://127.0.0.1:8011/api/monitoring/test-a/thresholds',{data:{watch:1.2,warning:2,critical:3}});
 await page.getByRole('button',{name:'Monitoring',exact:true}).click();
 await page.getByRole('button',{name:'Next monitoring reading'}).click();
 await page.getByRole('button',{name:'Open alerts'}).click();
 await expect(page.getByRole('dialog')).toContainText('TEST · DEMONSTRATION');
 const active=page.locator('.alert-record').filter({has:page.getByRole('button',{name:'Acknowledge'})}).first();
 await active.getByRole('button',{name:'Acknowledge'}).click();
 const acknowledged=page.locator('.alert-record').filter({hasText:'acknowledged'}).first();
 await acknowledged.getByRole('button',{name:'Resolve test alert'}).click();
 await expect(page.getByRole('dialog')).toContainText('resolved');
});

test('imports a geographic file, inspects provenance, toggles its layer, persists settings and exports PDF/CSV',async({page})=>{
 await page.getByRole('button',{name:'Data center',exact:true}).click();
 const geojson={type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Polygon',coordinates:[[[121.88,17.12],[121.9,17.12],[121.9,17.14],[121.88,17.14],[121.88,17.12]]]},properties:{name:'E2E artificial test boundary'}}]};
 await page.getByLabel('Choose dataset file').setInputFiles({name:'e2e-test-boundary.geojson',mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify(geojson))});
 await page.getByLabel('Dataset source').fill('E2E FIXTURE · artificial test boundary, never an actual barangay');
 await page.getByRole('button',{name:'Validate & import locally'}).click();
 await expect(page.getByRole('dialog')).toContainText('EPSG:4326');await expect(page.getByRole('dialog')).toContainText('E2E FIXTURE');
 await page.getByRole('button',{name:'Close inspection',exact:true}).click();
 await expect(page.getByLabel('Data mode')).toHaveValue('imported');
 await page.getByRole('button',{name:'Layers',exact:true}).click();
 await page.getByLabel(/Barangay boundaries/).uncheck();
 await page.getByRole('button',{name:'Close layers'}).click();
 await page.reload();await expect(page.getByLabel('Data mode')).toHaveValue('imported');
 await page.getByRole('button',{name:'Layers',exact:true}).click();await expect(page.getByLabel(/Barangay boundaries/)).not.toBeChecked();await page.getByRole('button',{name:'Close layers'}).click();
 await page.getByLabel('Data mode').selectOption('demonstration');
 await page.getByRole('button',{name:'Reports',exact:true}).click();
 await page.getByText('Include current map capture',{exact:true}).click();
 const pdfEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Export scenario PDF report'}).click();expect((await pdfEvent).suggestedFilename()).toMatch(/\.pdf$/);
 const csvEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();expect((await csvEvent).suggestedFilename()).toMatch(/\.csv$/);
});

test('handles unavailable data and a failed API request without a rendering crash',async({page})=>{
 await page.getByLabel('Data mode').selectOption('imported');await page.getByRole('button',{name:'Monitoring',exact:true}).click();await expect(page.getByText('No monitoring measurements',{exact:true})).toBeVisible();
 await page.route('**/api/datasets',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"Test service failure"}'}));
 await page.reload();await expect(page.getByRole('alert')).toContainText('Test service failure');await expect(page.getByRole('button',{name:'Retry backend'})).toBeVisible();
});

test('keeps command-center controls accessible at 1920×1080 and mobile widths',async({page})=>{
 await page.setViewportSize({width:1920,height:1080});
 await page.getByLabel('Select simulation time step').selectOption('4');
 await expect(page.locator('.situation-panel')).toBeVisible();
 await expect(page.locator('.map-legend')).toBeVisible();
 const zoom=page.getByRole('button',{name:'Zoom in',exact:true});
 await zoom.click();
 await page.getByRole('button',{name:'Return to Ilagan'}).click();
 // Allow the explicit 1.2-second camera flight to finish before the evidence capture.
 await page.waitForTimeout(2000);
 await page.screenshot({path:'../docs/command-center.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Collapse work panel'}).click();
 await expect(page.getByRole('button',{name:'Zoom in',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Data center',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Data management'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
});
