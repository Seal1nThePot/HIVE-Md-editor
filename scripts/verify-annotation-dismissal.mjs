import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fork, spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(import.meta.url);
const output = path.resolve(process.env.HIVE_ANNOTATION_EVIDENCE || path.join(root, '.runtime/checks/annotations'));
const require = createRequire(import.meta.url);
const ctrl = 2;
const cases = [
  {mode: 'ctrl', outside: 'text', text: 'Ctrl outside body'},
  {mode: 'ctrl', outside: 'blank', text: 'Ctrl outside blank'},
  {mode: 'toolbar', outside: 'text', text: 'Toolbar outside body'},
  {mode: 'toolbar', outside: 'blank', text: 'Toolbar outside blank'},
];
const lastLine = 'This paragraph is an outside click target.';
const tableCells = ['Group cell A', 'Group cell B'];
const tableText = '| Header A | Header B |\n| --- | --- |\n| ' + tableCells.join(' | ') + ' |';
const fixture = [...cases.map(({text}) => text), 'Context menu fallback', 'Regular drag leaves no popup', 'Ctrl click still annotates', lastLine, tableText].join('\n\n');

function browserSetup() {
  const visible = el => el?.checkVisibility({checkVisibilityCSS: true});
  const pane = () => [...document.querySelectorAll('.document-pane')].find(visible);
  const editor = () => pane()?.querySelector('.split-main .cm-editor');
  const popup = () => document.querySelector('.inline-annotation-editor');
  const button = () => document.querySelector('.dock-annotation-button');
  const center = (rect) => ({x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)});
  window.annotationTest = {
    popup: () => !!visible(popup()),
    note: () => popup()?.querySelector('textarea').value,
    confirmation: () => {
      const dialog = document.querySelector('dialog.annotation-delete-confirm[open]');
      return dialog && {text: dialog.textContent, focused: document.activeElement?.textContent};
    },
    exists: text => [...editor().querySelectorAll('[data-annotation-id]')].some(el => el.textContent.includes(text)),
    idsAt: text => [...new Set([...editor().querySelectorAll('[data-annotation-id]')].filter(el => el.textContent.includes(text)).map(el => el.dataset.annotationId))],
    tableIds: () => [...new Set([...editor().querySelectorAll('[data-table-annotation-ids]')].flatMap(el=>JSON.parse(el.dataset.tableAnnotationIds)))],
    markTable(values) {
      const view = editor().querySelector('.cm-content').cmTile.root.view;
      const ranges = values.map(value=>{
        const from=view.state.doc.toString().indexOf(value);
        return {from,to:from+value.length};
      });
      view.dispatch({effects:view.constructor.scrollIntoView(ranges[0].from,{y:'center'})});
      view.dom.dispatchEvent(new CustomEvent('hive:table-annotation',{bubbles:true,detail:{action:'mark',ranges}}));
    },
    selection: () => ({
      range: editor().querySelector('.cm-content').cmTile.root.view.state.selection.main.toJSON(),
      hidden: editor().hasAttribute('data-annotation-selection-hidden'),
    }),
    presentation: selector => {
      const pencil = document.querySelector(selector);
      const key = pencil?.dataset.annotationKey;
      const frame = [...editor().querySelectorAll('[data-annotation-frame-id]')].find(el => el.dataset.annotationFrameId === key);
      return {pencil: !!visible(pencil), frame: !!visible(frame), popup: !!visible(popup()), note: popup()?.querySelector('textarea').value};
    },
    selected: () => document.getSelection().toString(),
    mode: () => button().getAttribute('aria-pressed'),
    toolbar: () => center(button().getBoundingClientRect()),
    point(selector) {
      const el = document.querySelector(selector);
      if (!visible(el)) throw Error('Cannot find ' + selector);
      return center(el.getBoundingClientRect());
    },
    line(text) {
      const line = [...editor().querySelectorAll('.cm-line')].find(el => el.textContent === text);
      if (!line) throw Error('Cannot find line ' + text);
      const start = document.createRange();
      const end = document.createRange();
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode();
      let last = first;
      while (walker.nextNode()) last = walker.currentNode;
      start.setStart(first, 0);
      start.setEnd(first, 1);
      end.setStart(last, last.length - 1);
      end.setEnd(last, last.length);
      const a = start.getBoundingClientRect();
      const b = end.getBoundingClientRect();
      const y = Math.round(a.top + a.height / 2);
      return {start: {x: Math.ceil(a.left), y}, end: {x: Math.floor(b.right), y}};
    },
    blank() {
      const bounds = editor().querySelector('.cm-scroller').getBoundingClientRect();
      return {x: Math.round(bounds.left + bounds.width * .15), y: Math.round(bounds.bottom - 90)};
    },
    hit(point) {
      const el = document.elementFromPoint(point.x, point.y);
      return {className: el?.className?.toString(), editor: !!el?.closest('.cm-editor'), popup: !!el?.closest('.inline-annotation-editor')};
    },
    findButton(text) {
      const el = [...document.querySelectorAll('button')].find(el => visible(el) && el.textContent.trim().startsWith(text));
      if (!el) throw Error('Cannot find button ' + text);
      return center(el.getBoundingClientRect());
    },
  };
}

async function worker(port, profile) {
  const {app, BrowserWindow} = require('electron');
  app.setPath('userData', path.join(profile, 'electron'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, focusable: false, skipTaskbar: true, width: 1600, height: 1000,
    webPreferences: {offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false},
  });
  const cdp = win.webContents.debugger;
  const evaluate = async expression => {
    const result = await win.webContents.executeJavaScript(`Promise.resolve().then(() => (${expression})).then(value => ({ value }), error => ({ error: String(error.stack || error) }))`);
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  const call = (name, ...args) => evaluate('annotationTest.' + name + '(' + args.map(arg => JSON.stringify(arg)).join(',') + ')');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evidence = [];
  function check(name, passed, detail) {
    evidence.push({name, passed: !!passed, detail});
    console.log((passed ? 'PASS ' : 'FAIL ') + name);
  }
  async function until(test, duration = 4500) {
    const deadline = Date.now() + duration;
    do {
      if (await test()) return true;
      await pause(35);
    } while (Date.now() < deadline);
    return false;
  }
  const mouse = (type, point, options) => cdp.sendCommand('Input.dispatchMouseEvent', {type, ...point, ...options});
  async function click(point, button = 'left', modifiers = 0) {
    await mouse('mousePressed', point, {button, buttons: button === 'right' ? 2 : 1, modifiers, clickCount: 1});
    await mouse('mouseReleased', point, {button, buttons: 0, modifiers, clickCount: 1});
  }
  async function confirmDeletion(cancel = false) {
    assert.ok(await until(() => call('confirmation')), 'Annotation deletion confirmation did not open');
    const target = cancel ? 'button:first-child' : '.annotation-delete-danger';
    await click(await call('point', 'dialog.annotation-delete-confirm ' + target));
    assert.ok(await until(async () => !(await call('confirmation'))), 'Annotation deletion confirmation did not close');
  }
  async function escape() {
    const params = {key:'Escape', code:'Escape', windowsVirtualKeyCode:27};
    await cdp.sendCommand('Input.dispatchKeyEvent', {type:'rawKeyDown', ...params});
    await cdp.sendCommand('Input.dispatchKeyEvent', {type:'keyUp', ...params});
  }
  async function drag({start, end}, modifiers = 0) {
    await mouse('mousePressed', start, {button: 'left', buttons: 1, modifiers, clickCount: 1});
    for (let i = 1; i <= 8; i++) {
      const ratio = i / 8;
      const point = {x: Math.round(start.x + (end.x - start.x) * ratio), y: Math.round(start.y + (end.y - start.y) * ratio)};
      await mouse('mouseMoved', point, {buttons: 1, modifiers});
      await pause(16);
    }
    await mouse('mouseReleased', end, {button: 'left', buttons: 0, modifiers, clickCount: 1});
    await pause(140);
  }
  const outsideText = async () => {
    const {start, end} = await call('line', lastLine);
    return {x: Math.round((start.x + end.x) / 2), y: start.y};
  };
  const hoverLine = async text => {
    const {start, end} = await call('line', text);
    await mouse('mouseMoved', {x: Math.round((start.x + end.x) / 2), y: start.y});
    await pause(65);
  };
  async function checkDismiss(name, point) {
    const hit = await call('hit', point);
    assert.ok(hit.editor && !hit.popup, 'Outside target must be in the editor outside the popup: ' + JSON.stringify(hit));
    await mouse('mousePressed', point, {button: 'left', buttons: 1, clickCount: 1});
    const dismissedOnPress = !(await call('popup'));
    await mouse('mouseReleased', point, {button: 'left', buttons: 0, clickCount: 1});
    await pause(180);
    check(name, dismissedOnPress && !(await call('popup')), {point, hit, dismissedOnPress, reopened: await call('popup')});
  }
  try {
    cdp.attach('1.3');
    await win.loadURL('http://127.0.0.1:' + port);
    await evaluate('(' + browserSetup.toString() + ')()');
    assert.ok(await until(() => evaluate('!!document.querySelector(\'[data-path="annotation-source.md"]\')')), 'Missing document fixture');
    await evaluate('document.querySelector(\'[data-path="annotation-source.md"]\').click()');
    assert.ok(await until(() => evaluate('document.body.textContent.includes(' + JSON.stringify(lastLine) + ')')), 'Fixture did not open');
    await pause(350);

    for (const test of cases) {
      const name = test.mode + ' drag, ' + test.outside;
      if (test.mode === 'toolbar' && await call('mode') !== 'true') await click(await call('toolbar'));
      const line = await call('line', test.text);
      await drag(line, test.mode === 'ctrl' ? ctrl : 0);
      const opened = await call('popup');
      check(name + ' opens a real annotation', opened && await call('exists', test.text), {opened, selected: await call('selected'), toolbarPressed: await call('mode')});
      if (!opened) continue;
      const textarea = '.inline-annotation-editor textarea';
      await click(await call('point', textarea));
      const note = 'requirement for ' + test.text;
      await cdp.sendCommand('Input.insertText', {text: note});
      check(name + ' internal click keeps the editor open and editable', await call('note') === note);
      await checkDismiss(name + ' closes on first outside press without reopening', test.outside === 'text' ? await outsideText() : await call('blank'));
      if (await call('popup')) await click(await call('findButton', '完成'));
    }
    const modeActive = await call('mode') === 'true';
    check('Toolbar enters annotation mode and outside clicks leave it active', modeActive);
    if (modeActive) await click(await call('toolbar'));
    check('Toolbar toggles its mode off', await call('mode') === 'false');
    const regular = await call('line', 'Regular drag leaves no popup');
    await drag(regular);
    check('Unmodified drag selects without creating an annotation outside toolbar mode', !(await call('popup')) && !(await call('exists', 'Regular drag leaves no popup')));

    const ctrlClick = await call('line', 'Ctrl click still annotates');
    await drag(ctrlClick);
    await click({x: Math.round((ctrlClick.start.x + ctrlClick.end.x) / 2), y: ctrlClick.start.y}, 'left', ctrl);
    check('Ctrl click on an existing selection still annotates', await until(() => call('popup')) && await call('exists', 'Ctrl click still annotates'));
    if (await call('popup')) {
      await click(await call('findButton', '完成'));
      check('Done closes the popup and keeps the annotation', !(await call('popup')) && await call('exists', 'Ctrl click still annotates'));
    }

    const fallback = await call('line', 'Context menu fallback');
    await drag(fallback);
    await click({x: Math.round((fallback.start.x + fallback.end.x) / 2), y: fallback.start.y}, 'right');
    assert.ok(await until(() => evaluate('!!document.querySelector(\'[role="menuitem"] kbd\')')), 'Editor context menu did not open');
    await click(await call('findButton', '标注选区'));
    assert.ok(await until(() => call('popup')), 'Context menu did not open the annotation editor');
    await checkDismiss('Existing context-menu popup also closes when clicking blank editor space', await call('blank'));
    if (await call('popup')) await click(await call('findButton', '完成'));
    const firstBubble = '.annotation-bubble[title*="Ctrl outside body"]';
    if (await evaluate('!!document.querySelector(' + JSON.stringify(firstBubble) + ')')) {
      await hoverLine('Ctrl outside body');
      await click(await call('point', firstBubble));
      check('Reopening the annotation preserves the note edited before dismissal', await call('note') === 'requirement for Ctrl outside body');
      await mouse('mouseMoved', await call('blank'));
      await pause(420);
      const hidden = await call('presentation', firstBubble);
      check('Moving away hides the pencil, frame and editor while retaining the draft',
        !hidden.pencil && !hidden.frame && !hidden.popup && hidden.note === 'requirement for Ctrl outside body', hidden);
      await hoverLine('Ctrl outside body');
      const restored = await call('presentation', firstBubble);
      check('Returning restores the same pencil, frame and open annotation draft',
        restored.pencil && restored.frame && restored.popup && restored.note === hidden.note, restored);
      const [firstId] = await call('idsAt', 'Ctrl outside body');
      await click(await call('blank'));
      await drag(await call('line', 'Ctrl outside body'), ctrl);
      const colocated = await call('idsAt', 'Ctrl outside body');
      assert.equal(colocated.length, 2, 'Two notes should share the same visible text range');
      assert.ok(await until(() => call('popup')), 'New co-located note did not open');
      await cdp.sendCommand('Input.insertText', {text: 'Second note at the same span'});
      const selection = await call('selection');
      await mouse('mouseMoved', await call('blank'));
      await pause(420);
      const hiddenSelection = await call('selection');
      check('Pointer exit hides the drawn selection without changing the editor selection',
        hiddenSelection.hidden && JSON.stringify(selection.range) === JSON.stringify(hiddenSelection.range), {selection, hiddenSelection});
      await hoverLine('Ctrl outside body');
      check('Pointer return restores the drawn selection', !(await call('selection')).hidden);
      await click(await call('point', firstBubble), 'right');
      assert.ok(await until(() => call('confirmation')), 'Open co-located annotation should require confirmation');
      const prompt=await call('confirmation');
      check('Right-click names the displayed note and focuses Cancel with both marks and source range retained',
        prompt.text.includes('Second note at the same span') && prompt.focused === '取消' &&
        JSON.stringify(await call('idsAt', 'Ctrl outside body')) === JSON.stringify(colocated) &&
        JSON.stringify((await call('selection')).range) === JSON.stringify(selection.range), prompt);
      await confirmDeletion(true);
      await hoverLine('Ctrl outside body');
      check('Cancel keeps the open note, range and both annotations', await call('note') === 'Second note at the same span' &&
        JSON.stringify((await call('selection')).range) === JSON.stringify(selection.range) &&
        JSON.stringify(await call('idsAt', 'Ctrl outside body')) === JSON.stringify(colocated));
      await click(await call('point', firstBubble), 'right');
      assert.ok(await until(() => call('confirmation')), 'Delete dialog did not reopen');
      await escape();
      check('Escape dismisses confirmation without modifying either annotation',
        await until(async()=>!(await call('confirmation'))) &&
        JSON.stringify(await call('idsAt', 'Ctrl outside body')) === JSON.stringify(colocated));
      await click(await call('blank'));
      await hoverLine('Ctrl outside body');
      await click(await call('point', firstBubble), 'right');
      const chooser = '.annotation-bubble-choices[aria-label="选择要删除的标注"]';
      assert.ok(await until(() => evaluate('!!document.querySelector(' + JSON.stringify(chooser) + ')')), 'Ambiguous pencil should offer a chooser');
      check('Right-click on a shared pencil without an open note asks which note to delete',
        await evaluate('document.querySelectorAll(' + JSON.stringify(chooser + ' button') + ').length===2') && !(await call('confirmation')));
      await escape();
      check('Escape dismisses the chooser without modifying either annotation',
        await until(() => evaluate('!document.querySelector(' + JSON.stringify(chooser) + ')')) &&
        JSON.stringify(await call('idsAt', 'Ctrl outside body')) === JSON.stringify(colocated));
      await hoverLine('Ctrl outside body');
      await click(await call('point', firstBubble), 'right');
      await click(await call('point', chooser + ' button[title="Second note at the same span"]'));
      await confirmDeletion();
      check('Confirmed deletion removes only the selected note at the shared position',
        await until(async () => JSON.stringify(await call('idsAt', 'Ctrl outside body')) === JSON.stringify([firstId])));
      await hoverLine('Ctrl outside body');
      await click(await call('point', firstBubble));
      check('The other note at the same range keeps its original text', await call('note') === hidden.note);
      await click(await call('point', firstBubble), 'right');
      await confirmDeletion();
      check('Confirmed deletion leaves a neighboring annotation intact',
        await until(async () => !(await call('popup')) && !(await call('exists', 'Ctrl outside body')) && await call('exists', 'Ctrl outside blank')));
    }

    const secondBubble = '.annotation-bubble[title*="Ctrl outside blank"]';
    if (await evaluate('!!document.querySelector(' + JSON.stringify(secondBubble) + ')')) {
      await hoverLine('Ctrl outside blank');
      await click(await call('point', secondBubble));
      assert.ok(await call('popup'), 'Second annotation did not reopen');
      await evaluate('window.dispatchEvent(new Event("blur"))');
      check('Owner window blur closes the popup (synthetic blur)', !(await call('popup')));
      await hoverLine('Ctrl outside blank');
      await click(await call('point', secondBubble));
      assert.ok(await call('popup'), 'Annotation did not reopen after owner blur');
      await click(await call('point', secondBubble), 'right');
      assert.ok(await until(() => call('confirmation')), 'Expected confirmation before switching source');
      await evaluate('document.querySelector(\'[data-path="annotation-other.md"]\').click()');
      assert.ok(await until(() => evaluate('document.querySelector(\'.document-pane:not([inert]) .cm-content\')?.textContent === \'Second note for annotation tests.\'')), 'Second source did not open');
      check('Switching documents dismisses the old annotation editor and deletion confirmation', !(await call('popup')) && !(await call('confirmation')));
      await evaluate('document.querySelector(\'[data-path="annotation-source.md"]\').click()');
      assert.ok(await until(() => evaluate('!!document.querySelector(' + JSON.stringify(secondBubble) + ')')), 'Returning to source did not restore its annotation bubble');
      check('Returning to the previous document keeps its popup dismissed', !(await call('popup')));
      await hoverLine('Ctrl outside blank');
      await click(await call('point', secondBubble));
      await click(await call('point', '.inline-annotation-editor .gold-button'));
      check('Send closes the popup and shows the submitted annotation as a compact chip', await until(() => evaluate('!annotationTest.popup() && [...document.querySelectorAll(".messages .message.user .chat-annotation-entries > button")].some(button=>button.textContent.includes("Ctrl outside blank"))')));
      check('The submitted note still reaches the demo reply', await until(() => evaluate('[...document.querySelectorAll(".messages .message.assistant")].some(el=>el.textContent.includes("requirement for Ctrl outside blank"))')));
    }
    const pendingText = 'Toolbar outside blank';
    const pendingBubble = '.annotation-bubble[title*="'+pendingText+'"]';
    await hoverLine(pendingText);
    await click(await call('point', pendingBubble));
    await click(await call('point', '.inline-annotation-editor .gold-button'));
    await hoverLine(pendingText);
    await click(await call('point', pendingBubble), 'right');
    assert.ok(await until(() => call('confirmation')), 'Pending request should still require confirmation');
    check('Opening confirmation leaves the submitted annotation and generation in place',
      await call('exists', pendingText) && await evaluate('!!document.querySelector(".message.thinking")'));
    await confirmDeletion();
    await pause(850);
    check('Confirmed deletion during a submitted annotation request prevents a late response',
      !(await call('exists', pendingText)) && !(await evaluate('[...document.querySelectorAll(".messages .message.assistant")].some(el=>el.textContent.includes("requirement for Toolbar outside blank"))')));
    await call('markTable', tableCells);
    assert.ok(await until(async()=> (await call('tableIds')).length===2), 'Expect a group of two cell annotations');
    const tableIds = await call('tableIds');
    const groupedPencil = '.annotation-bubble[data-annotation-key="' + tableIds[0] + '"]';
    await evaluate('document.querySelector('+JSON.stringify(groupedPencil)+').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,button:2}))');
    assert.ok(await until(() => call('confirmation')), 'Grouped cell dialog did not open');
    const grouped=await call('confirmation');
    check('One logical cell annotation reports the exact two-cell deletion scope',
      grouped.text.includes('是否删除当前这组标注') && grouped.text.includes('2 个选区'));
    await confirmDeletion(true);
    check('Cancel preserves all cells in the group', JSON.stringify(await call('tableIds')) === JSON.stringify(tableIds));
    await evaluate('document.querySelector('+JSON.stringify(groupedPencil)+').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,button:2}))');
    await confirmDeletion();
    check('Confirm removes the whole logical group and leaves unrelated annotations',
      await until(async()=> (await call('tableIds')).length===0 && await call('exists','Ctrl outside blank')));
  } catch (error) {
    check('Test harness', false, error.stack);
  } finally {
    await fs.writeFile(path.join(output, 'checks.json'), JSON.stringify({
      method: 'Hidden offscreen Electron with Chromium DevTools Protocol pointer and text input',
      evidence,
    }, null, 2));
    win.destroy();
    app.exit(evidence.every(check => check.passed) ? 0 : 1);
  }
}

async function run() {
  await fs.mkdir(output, {recursive: true});
  const profile = await fs.mkdtemp(path.join(output, 'annotation-profile-'));
  const documents = path.join(profile, 'documents');
  const state = path.join(profile, 'state');
  await fs.mkdir(documents);
  await fs.mkdir(path.join(profile, 'electron'));
  await fs.mkdir(state);
  await fs.writeFile(path.join(state, 'workspace.json'), JSON.stringify({root: documents, autoSave: false, revision: 0}));
  await fs.writeFile(path.join(documents, 'annotation-source.md'), fixture);
  await fs.writeFile(path.join(documents, 'annotation-other.md'), 'Second note for annotation tests.');
  const backend = fork(path.join(root, 'server/index.mjs'), [], {
    cwd: root, silent: true, windowsHide: true,
    env: {...process.env, HIVE_PORT: '0', HIVE_STATE_DIR: state, HIVE_DOCUMENTS: documents, HIVE_API_KEY: ''},
  });
  backend.stdout.resume();
  backend.stderr.pipe(process.stderr);
  let vite;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Backend did not report ready')), 15000);
      backend.once('error', reject);
      backend.on('message', msg => {
        if (msg?.type === 'hive-ready') {
          clearTimeout(timer);
          resolve(msg.port);
        }
      });
    });
    const {createServer} = await import('vite');
    vite = await createServer({root, cacheDir: path.join(profile, '.vite'), server: {
      host: '127.0.0.1', port: 0, hmr: false, ws: false,
      proxy: {'/api': {target: 'http://127.0.0.1:' + port, changeOrigin: true,
        configure(proxy) { proxy.on('proxyReq', request => request.setHeader('origin', 'http://127.0.0.1:' + port)); },
      }},
    }});
    await vite.listen();
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    const electronArgs = ['--user-data-dir=' + path.join(profile, 'electron')];
    if (process.env.HIVE_TEST_ELECTRON_NO_SANDBOX === '1') electronArgs.push('--no-sandbox');
    const child = spawn((await import('electron')).default, [...electronArgs, entry, '--worker', vite.httpServer.address().port, profile], {
      cwd: root, env, windowsHide: true, stdio: 'inherit',
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('Hidden annotation regression timed out'));
      }, 90000);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(code, 0, 'See ' + path.join(output, 'checks.json'));
  } finally {
    if (vite) await vite.close();
    if (backend.exitCode === null && backend.signalCode === null)
      await new Promise(resolve => { backend.once('exit', resolve); backend.kill(); });
    const resolvedProfile = await fs.realpath(profile);
    assert.equal(path.dirname(resolvedProfile), await fs.realpath(output));
    assert.ok(path.basename(resolvedProfile).startsWith('annotation-profile-'));
    await fs.rm(resolvedProfile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
}

const workerArg = process.argv.indexOf('--worker');
if (workerArg !== -1)
  void worker(process.argv[workerArg + 1], process.argv[workerArg + 2]).catch(error => {
    console.error(error);
    require('electron').app.exit(1);
  });
else
  void run().catch(error => { console.error(error); process.exitCode = 1; });
