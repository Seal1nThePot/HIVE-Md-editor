import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fork, spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createExternalHttpLinkHandler} from '../desktop/externalLinks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const output = path.resolve(process.env.HIVE_EDITOR_REGRESSION_EVIDENCE || path.join(root, '.runtime/checks/r6-editor'));
const wrapProbe = process.argv.includes('--wrap-probe');
const samples = [
  '普通段落起点普通汉字文字，另有普通内容句号。',
  '- 一级列表开始，这是用于验证自动换行的较长文字记录，应当与首行正文对齐。',
  '  续行文本从本项正文对齐。',
  '  - 嵌套列表开始，前面有一些 Markdown 文本。',
  '- 安装包的目录是 \x60win-unpacked\x60，链接文档是[维护记录](next.md)。',
];
const documentText = [
  '# 回归样例', '', ...samples, '', '可编辑的[单元格组件](next.md)。',
  '', '[网页一](http://example.test/one)', '', '[网页二](<https://example.test/two?q=汉字>)',
  '', '<https://example.test/autolink>', '', 'https://example.test/bare',
  '', '[仓库文件](next.md)', '', '列表与粗体验证', '',
  '- 第一项', '- 第二项', '- 第三项', '', '**Bold sample**', '', '> First quote',
  '> Second \x60quoted code\x60', '> Last quote', '',
  ...Array.from({length: 71}, (_, i) => i === 20 ? '滚动验证专用标注段落' : '普通测试行 ' + i),
].join('\n');

function installBrowserChecks() {
  const editor = () => document.querySelector('.active-editor .split-main .cm-content')?.cmTile?.root?.view;
  const wait = async test => {
    for (let i = 0; i < 150; i++) {
      if (test()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for the editor fixture');
  };
  const rects = line => {
    const result = [];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement.closest('[aria-hidden=true]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let i = 0; i < node.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0) result.push({text: node.data[i], x: rect.left, y: rect.top});
      }
    }
    return result;
  };
  const center = element => {
    const box = element.getBoundingClientRect();
    return {x: box.left + box.width / 2, y: box.top + box.height / 2};
  };
  const line = text => [...editor().contentDOM.querySelectorAll('.cm-line')].find(element => element.textContent.includes(text));
  const renderedLink = text => [...editor().contentDOM.querySelectorAll('[data-hive-link]')].find(element => element.textContent === text);
  window.regression = {
    async open(name) {
      await wait(() => document.querySelector('.explorer-row[data-path="' + name + '"]'));
      document.querySelector('.explorer-row[data-path="' + name + '"]').click();
      await wait(() => editor()?.state.doc.toString().includes('可编辑的'));
    },
    async wrap() {
      const view = editor();
      const cases = [], host = view.dom.closest('.editor-host');
      const oldWidth = host.style.width;
      for (let width = 104; width <= 420; width += 2) {
        host.style.width = width + 'px';
        for (const sample of ['普通段落起点', '安装包的目录']) {
          const characters = rects(line(sample));
          const issues = characters.flatMap((char, index) => {
            const prior = characters.slice(0, index).findLast(item => item.text.trim());
            return prior && /[，。]/.test(char.text) && Math.abs(prior.y - char.y) > 6 ? [{prior, char}] : [];
          });
          if (issues.length) cases.push({width, sample, issues});
        }
      }
      host.style.width = oldWidth;
      return cases;
    },
    async list() {
      const view = editor(), host = view.dom.closest('.editor-host'), oldWidth = host.style.width;
      host.style.width = '220px';
      view.requestMeasure();
      await new Promise(requestAnimationFrame);
      const plain = rects(line('普通段落起点')), firstLine = line('一级列表开始'), next = rects(line('续行文本'));
      const first = rects(firstLine), nestedLine = line('嵌套列表开始');
      const body = first.find(char => char.text === '一');
      const wrapped = first.find(char => char.y > body.y + 6);
      const positions = {plain: plain[0].x, marker: firstLine.querySelector('.cm-preview-bullet').getBoundingClientRect().left, body: body.x, wrapped: wrapped?.x, continuation: next[0].x, nested: nestedLine.querySelector('.cm-preview-bullet').getBoundingClientRect().left};
      host.style.width = oldWidth;
      return positions;
    },
    select(text) {
      const view = editor(), from = view.state.doc.toString().indexOf(text);
      if (from < 0) throw new Error('Missing selection: ' + text);
      view.focus();
      view.dispatch({selection: {anchor: from, head: from + text.length}, scrollIntoView: true});
      return from;
    },
    text() { return editor().state.doc.toString(); },
    focus() { return editor().hasFocus && document.activeElement === editor().contentDOM; },
    firstAt(text) {
      const view = editor(), from = view.state.doc.toString().indexOf(text);
      view.focus();
      view.dispatch({selection: {anchor: from}, scrollIntoView: true});
    },
    linkPoint(text) {
      const link = renderedLink(text);
      link.scrollIntoView({block: 'center'});
      return center(link);
    },
    linkExists(text) { return !!renderedLink(text); },
    activateLink() {
      const view = editor(), from = view.state.doc.toString().indexOf('单元格组件')+1;
      view.focus();
      view.dispatch({selection: {anchor: from}, scrollIntoView: true});
    },
    editLink() {
      const view = editor();
      const from = view.state.doc.toString().indexOf('单元格组件](next.md)');
      const newTitle = '修改后的标签';
      view.dispatch({changes: {from, to: from + '单元格组件](next.md)'.length, insert: newTitle + '](new.md)'}, selection: {anchor: from + 1}});
    },
    linkStyle(text) {
      const link = [...editor().contentDOM.querySelectorAll('.cm-source-link')].find(element => element.textContent === text);
      return {text: link?.textContent, source: line(text)?.textContent, rendered: !!renderedLink(text), focus: editor().hasFocus, selection:editor().state.selection.main.head, color: link && getComputedStyle(link).color, underline: link && getComputedStyle(link).textDecorationLine};
    },
    markup(text) { return line(text)?.textContent; },
    composition() {
      const view = editor();
      const events = [];
      for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) view.contentDOM.addEventListener(name, () => events.push(name), {once: true});
      this.compositionEvents = () => events;
    },
    composing() { return editor().compositionStarted; },
    linePoint(text) {
      const target = line(text);
      target.scrollIntoView({block: 'center'});
      const view=editor(), from=view.state.doc.toString().indexOf(text)+1;
      const character=view.coordsForChar(from);
      const point={x:(character.left+character.right)/2,y:(character.top+character.bottom)/2};
      if(!document.elementFromPoint(point.x,point.y)?.closest('.cm-content')) throw new Error('Character is outside active editor: '+JSON.stringify({text,point}));
      return point;
    },
    pencil(text) {
      const button = [...document.querySelectorAll('.annotation-bubble')].find(el => el.title.includes(text));
      return button && {point: center(button), inScroller: !!button.closest('.cm-scroller')};
    },
    pencilGeometry(text) {
      const view = editor(), scroller = view.scrollDOM, clip = scroller.getBoundingClientRect();
      const mark = [...view.contentDOM.querySelectorAll('[data-annotation-id]')].find(el => el.textContent.includes(text));
      const pencil = this.pencil(text), rect = mark?.getBoundingClientRect();
      return rect && pencil && {scroll: scroller.scrollTop, top: rect.top, relative: pencil.point.y - (rect.top + rect.bottom) / 2, wheel: {x: clip.left + 15, y: (clip.top + clip.bottom) / 2}};
    },
    async scrollPencil(text) {
      const scroller = editor().scrollDOM;
      const mark = () => [...editor().contentDOM.querySelectorAll('[data-annotation-id]')].find(el => el.textContent.includes(text));
      const origin = scroller.scrollTop, samples = [];
      for (const offset of [0, 11, 23, 38, 63, 38, 23, 11, 0]) {
        scroller.scrollTop = origin + offset;
        const pencil = this.pencil(text), rect = mark()?.getBoundingClientRect();
        if (rect && pencil) samples.push({offset, top: rect.top, relative: pencil.point.y - (rect.top + rect.bottom) / 2});
        await new Promise(requestAnimationFrame);
      }
      return samples;
    },
    selectionColors() {
      const root = document.documentElement;
      root.style.setProperty('--hive-editor-selection-background', '#cc223344', 'important');
      root.style.setProperty('--hive-editor-selection-border', '#2211aa', 'important');
      const selected = editor().dom.querySelector('.cm-selectionBackground');
      const before = {fill: getComputedStyle(selected).backgroundColor, line: getComputedStyle(selected).boxShadow};
      root.style.setProperty('--hive-editor-selection-border', '#111122', 'important');
      const after = {fill: getComputedStyle(selected).backgroundColor, line: getComputedStyle(selected).boxShadow};
      root.style.removeProperty('--hive-editor-selection-background');
      root.style.removeProperty('--hive-editor-selection-border');
      return {before, after};
    },
  };
}

async function worker(port, profile) {
  const {app, BrowserWindow, ipcMain} = require('electron');
  app.setPath('userData', path.join(profile, 'profile'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, focusable: false, skipTaskbar: true, width: 1340, height: 920,
    webPreferences: {offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, 'desktop/preload.cjs'), backgroundThrottling: false},
  });
  const origin = 'http://127.0.0.1:' + port;
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  ipcMain.on('hive:preferences-read', event => {event.returnValue = null;});
  ipcMain.on('hive:panel-drag', event => {event.returnValue = false;});
  ipcMain.on('hive:panel-ready', event => {event.returnValue = false;});
  ipcMain.on('hive:panel-rect', event => {event.returnValue = null;});
  const external = [];
  const isMainFrame = event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin;
  ipcMain.handle('hive:open-external-http-link', createExternalHttpLinkHandler({isMainFrame, shell: {openExternal: async url => {external.push(url);}}}));

  const cdp = win.webContents.debugger;
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  const call = (name, ...args) => evaluate('regression.' + name + '(' + args.map(arg => JSON.stringify(arg)).join(',') + ')');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const mouse = (type, point, options) => cdp.sendCommand('Input.dispatchMouseEvent', {type, ...point, ...options});
  async function click(point, button = 'left', modifiers = 0) {
    await mouse('mousePressed', point, {button, buttons: button === 'right' ? 2 : 1, modifiers, clickCount: 1});
    await mouse('mouseReleased', point, {button, buttons: 0, modifiers, clickCount: 1});
  }
  const checks = [];
  function check(id, name, passed, detail) {
    checks.push({id, name, passed: !!passed, detail});
    console.log((passed ? 'PASS' : 'FAIL') + ' ' + id + ' ' + name);
    if (!passed && id !== 'BUG-102') console.log(JSON.stringify(detail));
  }
  try {
    cdp.attach();
    await win.loadURL(origin);
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
    console.log('Hidden editor page loaded');
    await evaluate('(' + installBrowserChecks.toString() + ')()');
    await call('open', 'editor-fixture.md');
    console.log('Synthetic note opened');
    const wrap = await call('wrap');
    check('BUG-102', 'Chinese closers stay with prose, links and inline code at every tested width', !wrap.length, {widths: '104–420 by 2px', violations: wrap});
    if (!wrapProbe) {
      const list = await call('list');
      check('BUG-066', 'first-level bullets indent, nested bullets step right, and both continuation types align',
        list.marker - list.plain > 8 && list.nested - list.marker > 18 && Math.abs(list.body - list.wrapped) < 1 && Math.abs(list.body - list.continuation) < 1, list);

      await call('activateLink');
      await delay(60);
      const original = await call('linkStyle', '单元格组件');
      await call('editLink');
      await delay(60);
      const changed = await call('linkStyle', '修改后的标签');
      check('BUG-099', 'active Markdown keeps editable syntax and an underlined colored label',
        original.underline === 'underline' && changed.underline === 'underline' && original.color === changed.color && original.source?.includes('[单元格组件](next.md)') && changed.source?.includes('[修改后的标签](new.md)'), {original, changed});

      await call('firstAt', '普通段落起点');
      await delay(60);
      const tab = (type, autoRepeat) => cdp.sendCommand('Input.dispatchKeyEvent', {type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, autoRepeat});
      const indent = async () => (await call('text')).split('\n').find(line => line.includes('普通段落起点')).match(/^\s*/)[0].length;
      await tab('keyDown', false);
      const first = await indent();
      for (let i = 0; i < 8; i++) await tab('keyDown', true);
      const held = await indent(), heldFocus = await call('focus');
      await tab('keyUp', false);
      await tab('keyDown', false);
      const second = await indent();
      await tab('keyUp', false);
      check('BUG-100', 'native Chromium Tab repeats are consumed while independent presses indent and retain focus',
        first > 0 && first === held && second === first * 2 && heldFocus && await call('focus'), {first, held, second, heldFocus});

      const urls = ['网页一', '网页二', 'https://example.test/autolink', 'https://example.test/bare'];
      for (const url of urls) {
        await call('firstAt', '普通段落起点');
        if (!await call('linkExists', url)) throw new Error('Missing rendered link ' + url);
        await click(await call('linkPoint', url));
      }
      const blocked = await evaluate("hiveDesktop.openExternalHttpLink('file:///forbidden.md')");
      await click(await call('linkPoint', '仓库文件'));
      await delay(200);
      check('BUG-106', 'four links reach the real sandbox preload and validated main-frame IPC, repository opens internally',
        external.length === 4 && external[0] === 'http://example.test/one' && external[1] === 'https://example.test/two?q=%E6%B1%89%E5%AD%97' &&
        external[2] === 'https://example.test/autolink' && external[3] === 'https://example.test/bare' && blocked === false && (await call('text')).includes('仓库文件打开验收。'),
        {external, blocked, repositoryOpened: (await call('text')).includes('仓库文件打开验收。')});

      await call('open', 'editor-fixture.md');
      for (const [active, inactive] of [['第一项', '第二项'], ['第二项', '第三项'], ['第三项', 'Bold sample']]) {
        await click(await call('linePoint', active));
        await delay(75);
        const raw = await call('markup', active);
        await click(await call('linePoint', inactive));
        await delay(75);
        const restored = await call('markup', active);
        check('BUG-101', 'released pointer re-renders ' + active, raw.startsWith('-') && restored.startsWith('•'), {raw, restored});
      }
      const boldRaw = await call('markup', 'Bold sample');
      await click(await call('linePoint', '第三项'));
      await delay(75);
      const boldRestored = await call('markup', 'Bold sample');
      check('BUG-101', 'strong delimiters collapse on pointer departure', boldRaw.includes('**') && !boldRestored.includes('**'), {boldRaw, boldRestored});

      await call('firstAt', '第三项');
      await cdp.sendCommand('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38});
      await cdp.sendCommand('Input.dispatchKeyEvent', {type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38});
      const keyboard = await call('markup', '第三项');
      check('BUG-101', 'arrow movement restores the list decoration', !keyboard.startsWith('-'), {keyboard});
      await call('firstAt', '第三项');
      await call('composition');
      await cdp.sendCommand('Input.imeSetComposition', {text: 'ni', selectionStart: 2, selectionEnd: 2});
      const composing = await call('composing');
      await cdp.sendCommand('Input.insertText', {text: '你'});
      await delay(80);
      const compositionEvents = await call('compositionEvents');
      const committed = (await call('text')).includes('你第三项');
      await click(await call('linePoint', 'Bold sample'));
      await delay(80);
      const composedLine = await call('markup', '第三项');
      check('BUG-101', 'Chromium composition commits once and leaving the item restores its decoration',
        composing && committed && compositionEvents.includes('compositionend') && !composedLine.startsWith('-'), {composing, committed, compositionEvents, composedLine});

      await call('select', 'First quote\n> Second \x60quoted code\x60\n> Last quote');
      await delay(75);
      const colors = await call('selectionColors');
      check('BUG-079', 'line color changes independently of fill on editor selection layer',
        colors.before.fill === colors.after.fill && colors.before.line !== colors.after.line && colors.before.fill.includes('204, 34, 51'), colors);

      const marked = '滚动验证专用标注段落';
      await call('select', marked);
      await delay(100);
      await click(await call('linePoint', marked), 'right');
      await delay(70);
      await evaluate("[...document.querySelectorAll('.editor-context-menu button')].find(button=>button.textContent.includes('标注选区')&&!button.disabled)?.click()");
      await delay(200);
      const pencil = await call('pencil', marked);
      const positions = pencil ? await call('scrollPencil', marked) : [];
      const stable = positions.every(item => Math.abs(item.relative - positions[0].relative) < 0.5);
      check('BUG-110', 'pencil stays in the CodeMirror scroller and retains vertical offset during two-way scrolling',
        pencil?.inScroller && positions.length === 9 && Math.abs(positions[0].top - positions[4].top) > 50 && stable, {pencil, positions});
      const origin = await call('pencilGeometry', marked);
      const wheel = [origin];
      if (origin) {
        for (const deltaY of [18, 22, -18, -22]) {
          await mouse('mouseWheel', origin.wheel, {deltaX: 0, deltaY});
          await delay(70);
          wheel.push(await call('pencilGeometry', marked));
        }
      }
      check('BUG-110', 'native Chromium wheel moves the marked text and pencil together in both directions',
        wheel.length === 5 && wheel.every(sample => sample && Math.abs(sample.relative - origin.relative) < 0.5) &&
        wheel[2].scroll - origin.scroll >= 35 && Math.abs(wheel[4].scroll - origin.scroll) < 1, wheel);
    }
  } catch (error) {
    check('harness', error.message, false, {stack: error.stack});
  } finally {
    await fs.writeFile(path.join(output, wrapProbe ? 'wrap-probe.json' : 'checks.json'), JSON.stringify(checks, null, 2));
    win.destroy();
    app.exit(wrapProbe || checks.every(item => item.passed) ? 0 : 1);
  }
}

async function run() {
  await fs.mkdir(output, {recursive: true});
  const fixture = await fs.mkdtemp(path.join(output, 'fixture-'));
  const documents = path.join(fixture, 'documents'), state = path.join(fixture, 'state');
  await fs.mkdir(documents);
  await fs.writeFile(path.join(documents, 'editor-fixture.md'), documentText);
  await fs.writeFile(path.join(documents, 'next.md'), '仓库文件打开验收。');
  const env = {...process.env, HIVE_PORT: '0', HIVE_DOCUMENTS: documents, HIVE_STATE_DIR: state, HIVE_APP_DATA_DIR: fixture, HIVE_TEMPLATES_DIR: path.join(fixture, 'templates'), HIVE_TEMPLATES_SOURCE: '', HIVE_API_KEY: ''};
  delete env.ELECTRON_RUN_AS_NODE;
  const server = fork(path.join(root, 'server/index.mjs'), ['--production'], {cwd: root, silent: true, windowsHide: true, env});
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture server timeout')), 15000);
      server.on('message', value => {if (value?.type === 'hive-ready') {clearTimeout(timer); resolve(value.port);}});
      server.once('exit', code => {clearTimeout(timer); reject(new Error('Fixture server exited ' + code));});
    });
    const child = spawn((await import('electron')).default, [entry, '--worker', String(port), fixture, ...(wrapProbe ? ['--wrap-probe'] : [])], {cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let log = '';
    child.stdout.on('data', data => {log += data; process.stdout.write(data);});
    child.stderr.on('data', data => {log += data; process.stderr.write(data);});
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {child.kill(); reject(new Error('Hidden Electron timed out'));}, 60000);
      child.once('error', error => {clearTimeout(timer); reject(error);});
      child.once('exit', result => {clearTimeout(timer); resolve(result);});
    });
    await fs.writeFile(path.join(output, wrapProbe ? 'wrap-probe.log' : 'checks.log'), log);
    assert.equal(code, 0, 'See hidden Electron evidence under ' + output);
  } finally {
    if (server.exitCode === null) {
      const stopped = new Promise(resolve => server.once('exit', resolve));
      server.send({type: 'hive-shutdown'});
      await stopped;
    }
  }
}

if (process.argv.includes('--worker')) {
  void worker(Number(process.argv[3]), process.argv[4]).catch(error => {
    console.error(error.stack);
    require('electron').app.exit(1);
  });
} else {
  await run();
}
