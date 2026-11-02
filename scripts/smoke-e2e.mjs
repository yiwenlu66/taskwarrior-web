#!/usr/bin/env node
// Disposable real-Taskwarrior/browser acceptance. Never reads or writes ~/.task.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
if (!existsSync(join(root, 'dist/index.html'))) throw Error('dist/index.html missing: run npm run build before acceptance');
let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  try { ({ chromium } = createRequire(join(globalRoot, 'agent-browser/package.json'))('playwright-core')); }
  catch { throw Error('Install playwright or agent-browser with playwright-core'); }
}
const fixture = mkdtempSync(join(tmpdir(), 'taskweb-e2e-'));
const data = join(fixture, 'data'); mkdirSync(data);
const taskrc = join(fixture, 'taskrc');
writeFileSync(taskrc, `data.location=${data}\nconfirmation=no\nverbose=nothing\ncolor=off\nuda.tiebreak.type=numeric\nuda.tiebreak.label=Tie\nreport.next.columns=id,project,tiebreak,description\nreport.next.labels=ID,Project,Tie,Description\nreport.next.sort=tiebreak+,id+\nreport.next.filter=status:pending limit:page\nreport.completed.columns=id,description\nreport.completed.labels=ID,Description\nreport.completed.sort=description+\nreport.completed.filter=status:completed\nreport.deleted.columns=id,description\nreport.deleted.labels=ID,Description\nreport.deleted.sort=description+\nreport.deleted.filter=status:deleted\n`);
const env = { ...process.env, TASKRC: taskrc, TASKDATA: data, HOME: fixture };
function task(...args) {
  const p = spawnSync('task', ['rc.confirmation=no', ...args], { env, encoding: 'utf8' });
  if (p.status !== 0) throw Error(`task ${args.join(' ')}: ${p.stderr || p.stdout}`);
  return p.stdout;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [], passes = [];
async function check(name, fn) {
  try { await fn(); passes.push(name); console.log('PASS', name); }
  catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); }
}
let server, browser, browser2;
try {
  for (let i = 0; i < 36; i++) task('add', `Fixture task ${String(i).padStart(2, '0')}`, `tiebreak:${35-i}`, `project:${i%2 ? 'alpha' : 'beta'}`, '+fixture');
  task('add', 'Fixture completed', 'project:archive'); task('description:Fixture completed', 'done');
  task('add', 'Fixture deleted', 'project:archive'); task('description:Fixture deleted', 'delete');
  // Validate all date suggestions with the native parser, without affecting visible rows.
  for (const date of ['today', 'tomorrow', 'now+3d', 'monday', 'eow', 'eom']) task('add', `Date probe ${date}`, `due:${date}`, '+dateprobe');
  for (const probe of JSON.parse(task('+dateprobe', 'export'))) task(probe.uuid, 'delete');
  server = spawn('python3', ['server.py', '--host', '127.0.0.1', '--port', '7835', '--static-dir', 'dist'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
  for (let i=0;i<80;i++) {
    if (server.exitCode !== null) throw Error(`fixture server exited: ${serverLog}`);
    if (serverLog.includes('web listening on http://127.0.0.1:7835')) break;
    if (i === 79) throw Error(`fixture server not healthy: ${serverLog}`);
    await wait(100);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  browser2 = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const context2 = await browser2.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const a = await context.newPage(), b = await context2.newPage();
  a.setDefaultTimeout(6000); b.setDefaultTimeout(6000);
  const url = 'http://127.0.0.1:7835';
  await Promise.all([a.goto(url), b.goto(url)]);
  const rows = p => p.locator('tbody tr');
  const selected = p => p.locator('tbody tr[aria-selected="true"]');
  const cmd = p => p.getByLabel('Task command');
  const focus = async p => { await p.locator('[aria-label^="Task list."][aria-busy="false"]').waitFor(); await p.getByRole('region', { name: /Task list/ }).focus(); };
  const open = async (p, text) => { await focus(p); await p.keyboard.press(':'); await cmd(p).fill(text); };
  const submit = async (p, text) => { await open(p, text); await cmd(p).press('Enter'); };
  const confirm = async p => { await p.getByRole('button', {name:'Confirm', exact:true}).click(); };
  const selectedId = async p => selected(p).getAttribute('id');
  await a.waitForSelector('tbody tr', { timeout: 15000 });
  await b.waitForSelector('tbody tr', { timeout: 15000 });
  await check('native report filter, ordering, limit removal and custom columns', async () => {
    const native = JSON.parse(task('rc.report.next.filter=status:pending', 'export', 'next'));
    const api = await (await fetch(url + '/api/tasks?report=next')).json();
    assert.equal(native.length, 36); assert.equal(api.tasks.length, 36);
    assert.deepEqual(api.tasks.map(t=>t.uuid), native.map(t=>t.uuid));
    assert.deepEqual(await a.locator('thead th').allTextContents(), ['Mark','ID','Project','Tie','Description']);
    assert.equal(await rows(a).count(), 36);
    assert(!api.tasks.some(t=>['Fixture completed','Fixture deleted'].includes(t.description)));
    const filtered = await (await fetch(url + '/api/tasks?report=next&filter=project%3Aalpha')).json();
    assert.equal(filtered.tasks.length, 18); assert(filtered.tasks.every(t=>t.project==='alpha'));
    for (const name of ['completed','deleted']) {
      const response = await (await fetch(url + '/api/tasks?report='+name)).json();
      const reportFilter = response.report.filter.replace(/(?:^|\s)limit:\S+/g, ' ').trim();
      const expected = JSON.parse(task(`rc.report.${name}.filter=${reportFilter}`, 'export', name));
      assert.deepEqual(response.tasks.map(t=>t.uuid), expected.map(t=>t.uuid), `${name} native report`);
      await a.getByLabel('Report', {exact:true}).selectOption(name);
      await a.waitForFunction(n => document.querySelector('table')?.getAttribute('aria-label') === n+' report',name);
      await a.waitForFunction(n => document.querySelectorAll('tbody tr').length === n,expected.length);
    }
    await a.getByLabel('Report', {exact:true}).selectOption('next');
    await a.waitForFunction(() => document.querySelectorAll('tbody tr').length === 36);
  });
  await check('light and dark dense table screenshots', async () => {
    await a.screenshot({path:'/tmp/taskwarrior-web-fixture.png'});
    await a.evaluate(() => { localStorage.setItem('taskwarrior.view', JSON.stringify({report:'next',theme:'dark'})); });
    await a.reload(); await a.waitForSelector('tbody tr');
    assert.equal(await a.locator('html').getAttribute('data-mode'), 'dark');
    await a.screenshot({path:'/tmp/taskwarrior-web-fixture-dark.png'});
  });
  await check('j/k, Space, gg/G navigation', async () => {
    await focus(a); await a.keyboard.press('g'); await a.keyboard.press('g');
    let ids = await rows(a).evaluateAll(rs => rs.map(r=>r.id)); assert.equal(await selectedId(a), ids[0], 'gg selects first');
    await a.keyboard.press('j'); assert.equal(await selectedId(a), ids[1], 'j moves down');
    await a.keyboard.press('k'); assert.equal(await selectedId(a), ids[0], 'k moves up');
    await a.keyboard.press('Space'); assert.equal(await selectedId(a), ids[1], 'Space moves down');
    await a.keyboard.press('G'); assert.equal(await selectedId(a), ids.at(-1), 'G selects last');
    await a.keyboard.press('g'); await a.keyboard.press('g'); assert.equal(await selectedId(a), ids[0]);
  });
  await check('completion: due, projects, tags, attributes, reports and cycling', async () => {
    for (const [text, expected] of [['m due:tom','tomorrow'],['m project:al','alpha'],['m +fix','fixture'],['m tie','tiebreak'],['r ne','next']]) {
      await open(a,text); await a.getByRole('listbox', {name:'Command suggestions'}).getByRole('option').filter({hasText:expected}).first().waitFor({timeout:3000});
      await a.getByLabel('Close command entry').click();
    }
    await open(a,'m due:'); await cmd(a).press('Tab'); const first = await cmd(a).inputValue();
    await cmd(a).press('Tab'); const second = await cmd(a).inputValue(); assert.notEqual(first,second);
    await cmd(a).press('Shift+Tab'); assert.equal(await cmd(a).inputValue(), first);
    await a.getByLabel('Close command entry').click();
  });
  await check('modify :m due:tomorrow executes with Enter', async () => {
    const uuid = (await selectedId(a)).slice(5); await open(a, 'm due:tom');
    await cmd(a).press('Tab'); assert.equal(await cmd(a).inputValue(), 'm due:tomorrow');
    await cmd(a).press('Enter'); await cmd(a).press('Enter');
    await a.waitForFunction(id => !document.querySelector('[aria-label="Task command"]') && document.querySelector('#task-'+id), uuid);
    const obj = JSON.parse(task(uuid,'export'))[0]; assert(obj.due, 'due must be set by Taskwarrior');
  });
  await check('start and stop confirmation', async () => {
    await focus(a); const uuid = (await selectedId(a)).slice(5);
    await a.keyboard.press('b'); await a.getByRole('dialog', {name:/start/i}).waitFor(); await confirm(a);
    await a.waitForFunction(id => document.querySelector('#task-'+id)?.classList.contains('started'),uuid);
    await focus(a); await a.keyboard.press('b'); await a.getByRole('dialog', {name:/stop/i}).waitFor(); await confirm(a);
    await a.waitForFunction(id => !document.querySelector('#task-'+id)?.classList.contains('started'),uuid);
  });
  await check('add, annotate, priority/project/tag/wait actions', async () => {
    await a.reload(); await a.waitForSelector('tbody tr');
    await submit(a,'add Browser fixture added');
    try { await a.getByText('Browser fixture added', {exact:true}).first().waitFor(); }
    catch { throw Error(`add did not appear; alert=${await a.getByRole('alert').allTextContents()}, draft=${await cmd(a).count() ? await cmd(a).inputValue() : '(closed)'}`); }
    await a.getByText('Browser fixture added', {exact:true}).first().click();
    const uuid = (await selectedId(a)).slice(5);
    for (const [key, value] of [['A','browser note'],['P','H'],['p','alpha'],['T','+fresh'],['w','tomorrow']]) {
      await focus(a); await a.keyboard.press(key);
      await cmd(a).fill((await cmd(a).inputValue())+value); await cmd(a).press('Enter');
      try { await a.waitForSelector('[aria-label="Task command"]', {state:'detached'}); }
      catch { throw Error(`${key}: command ${await cmd(a).inputValue()} did not execute; alert=${await a.getByRole('alert').allTextContents()}`); }
    }
    const obj = JSON.parse(task(uuid,'export'))[0];
    assert(obj.annotations?.some(x=>x.description==='browser note')); assert.equal(obj.priority,'H'); assert.equal(obj.project,'alpha'); assert(obj.tags?.includes('fresh')); assert(obj.wait);
  });
  await check('details and :help', async () => {
    await a.reload(); await a.waitForSelector('tbody tr'); await focus(a); await a.keyboard.press('Enter'); await a.getByRole('complementary', {name:'Task details'}).waitFor();
    await a.getByLabel('Close task details').click(); await submit(a,'help'); await a.getByRole('dialog',{name:'Keyboard reference'}).waitFor();
    await a.getByLabel('Close Keyboard reference').click();
  });
  await check('two clients refresh external change preserving selected UUID and draft; metadata refresh', async () => {
    await a.reload(); await a.waitForSelector('tbody tr'); await focus(a); await a.keyboard.press('g'); await a.keyboard.press('g');
    await focus(b); await b.keyboard.press('g'); await b.keyboard.press('g');
    const ids = await Promise.all([selectedId(a),selectedId(b)]);
    await open(a,'m due:tom'); await open(b,'m project:ex');
    task('add','External fixture change','project:externalproject','+externaltag','tiebreak:42');
    for (const p of [a,b]) await p.getByText('External fixture change',{exact:true}).first().waitFor({timeout:10000});
    assert.deepEqual(await Promise.all([selectedId(a),selectedId(b)]),ids);
    assert.equal(await cmd(a).inputValue(),'m due:tom'); assert.equal(await cmd(b).inputValue(),'m project:ex');
    await b.getByRole('listbox', {name:'Command suggestions'}).getByRole('option').filter({hasText:'externalproject'}).first().waitFor({timeout:5000});
    await cmd(b).fill('m +extern'); await b.getByRole('listbox', {name:'Command suggestions'}).getByRole('option').filter({hasText:'externaltag'}).first().waitFor({timeout:5000});
    await a.getByLabel('Close command entry').click(); await b.getByLabel('Close command entry').click();
  });
  await check('mixed marked start/stop toggles each UUID independently', async () => {
    await a.reload(); await a.waitForSelector('tbody tr');
    const ids = await rows(a).evaluateAll(rs => rs.slice(3,5).map(r=>r.id.slice(5)));
    task(ids[0], 'start'); await a.waitForFunction(id => document.querySelector('#task-'+id)?.classList.contains('started'), ids[0], {timeout:10000});
    for (const id of ids) await a.locator('#task-'+id+' .mark-button').click();
    await a.locator('#task-'+ids[0]).click(); await a.keyboard.press('b');
    await a.getByRole('dialog').waitFor(); await confirm(a);
    await a.waitForFunction(([on,off]) => !document.querySelector('#task-'+on)?.classList.contains('started') && document.querySelector('#task-'+off)?.classList.contains('started'), ids, {timeout:10000});
    assert(!JSON.parse(task(ids[0],'export'))[0].start); assert(JSON.parse(task(ids[1],'export'))[0].start);
    const clear = a.getByRole('button',{name:/marked · clear/}); if (await clear.count()) await clear.click();
  });
  await check('done focus stays at nearest row; delete confirmation', async () => {
    await a.reload(); await a.waitForSelector('tbody tr'); await focus(a);
    for (let i=0;i<5;i++) await a.keyboard.press('j');
    const before = await rows(a).evaluateAll(rs => rs.map(r=>r.id)); const selectedBefore = await selectedId(a);
    const index = before.indexOf(selectedBefore); assert(index > 0); const uuid = selectedBefore.slice(5);
    await a.keyboard.press('d'); await a.getByRole('dialog',{name:/Complete/}).waitFor(); await confirm(a);
    await a.waitForFunction(id => !document.querySelector('#task-'+id),uuid);
    assert.equal(JSON.parse(task(uuid,'export'))[0].status,'completed');
    assert.equal(await selectedId(a),before[index+1], 'focus should move to next surviving row');
  });
  await check('delete requires confirmation and changes status', async () => {
    await a.reload(); await a.waitForSelector('tbody tr'); await focus(a); const deleted = (await selectedId(a)).slice(5); await a.keyboard.press('D');
    await a.getByRole('dialog',{name:/Delete/}).waitFor(); await confirm(a);
    await a.waitForFunction(id => !document.querySelector('#task-'+id),deleted);
    assert.equal(JSON.parse(task(deleted,'export'))[0].status,'deleted');
  });
  await check('empty report and command error views', async () => {
    await a.reload(); await a.waitForSelector('tbody tr');
    const filter = a.getByLabel('Task filter'); await filter.fill('project:no-such-fixture-project'); await filter.press('Enter');
    await a.getByText('No tasks in this view').waitFor(); await a.getByLabel('Clear filter').click(); await a.waitForSelector('tbody tr');
    await submit(a,'this-is-not-a-command'); await a.getByRole('alert').waitFor(); await a.getByLabel('Dismiss error').click();
    await a.route('**/api/tasks?*', route => route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Fixture read failure'})}));
    await a.getByLabel('Refresh tasks').click(); await a.getByRole('alert').filter({hasText:'Fixture read failure'}).waitFor();
    await a.unroute('**/api/tasks?*');
  });
} finally {
  await browser?.close(); await browser2?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit',r)); }
  rmSync(fixture,{recursive:true,force:true});
}
console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode=1; }
