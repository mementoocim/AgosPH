import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
test.beforeEach(async({page,request})=>{
 const settings=await (await request.get('http://127.0.0.1:8011/api/settings')).json();
 await request.put('http://127.0.0.1:8011/api/settings',{data:{...settings,active_scenario:'demo-standard',data_mode:'demonstration',layers:{}}});
 await page.goto('/');await expect(page.getByRole('button',{name:'Play simulation',exact:true})).toBeVisible();
});

test('logs an exercise incident at a clicked map location, resolves it, and exports it',async({page})=>{
 const title=`E2E exercise · water over the road ${Date.now()}`;
 await page.getByRole('button',{name:'Log incident',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await expect(dialog).toContainText('EXERCISE · DEMONSTRATION MODE');
 await dialog.getByLabel('Incident title').fill(title);
 await dialog.getByLabel('Reported by').fill('E2E FIXTURE · drill controller');
 await dialog.getByRole('button',{name:'Pick location on map'}).click();
 await expect(page.getByRole('status').filter({hasText:'Click the map to place the incident'})).toBeVisible();
 await expect(dialog).toBeHidden();
 await page.getByTestId('main-map').locator('canvas').first().click({position:{x:700,y:450}});
 await expect(dialog.getByLabel('Longitude')).not.toHaveValue('');
 await expect(dialog.getByLabel('Incident title')).toHaveValue(title);
 await dialog.getByRole('button',{name:'Save exercise incident'}).click();
 const record=page.locator('.incident-record').filter({hasText:title});
 await expect(record).toContainText('EXERCISE · DEMONSTRATION MODE');
 await record.getByLabel(`Status of ${title}`).selectOption('verified');
 await expect(record.getByLabel(`Status of ${title}`)).toHaveValue('verified');
 await record.getByLabel(`Status of ${title}`).selectOption('resolved');
 await record.getByRole('button',{name:'Confirm resolve'}).click();
 await expect(record).toHaveCount(0);
 await page.getByRole('button',{name:'Reports',exact:true}).click();
 await page.getByLabel('CSV content').selectOption('incidents');
 const csvEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();
 const csv=readFileSync((await (await csvEvent).path())!,'utf-8');
 expect(csv).toContain(title);expect(csv).toContain('EXERCISE · DEMONSTRATION MODE');expect(csv).toContain('resolved');
});
