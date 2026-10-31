#!/usr/bin/env node
// orchestrator/web-seat.mjs — T-208 网页席驱动器 CLI（对标 EAgent「发送并等待回复」脚本）
//
// 形态（借鉴 EAgent 规范层，不抄代码）：
//   一条命令跑完一轮 = 发消息 → 可选送附件 → 等回复完成 → 原文落盘 → 全链路硬超时
//   长 prompt 走 --prompt-file 文件通道（避开命令行长度与引号转义）
//   席位配置来自 orchestrator/reviewers.yaml（不写死选择器，网页改版只改配置）
//   纪律：网页只作展示，消息只走 CDP（不在网页里手工打字）
//
// 用法：
//   node orchestrator/web-seat.mjs --seat deepseek --prompt-file tmp/p.md --out archive/evidence/T-208/raw/deepseek.json
//   node orchestrator/web-seat.mjs --seat all --prompt-file tmp/p.md --parallel --out archive/evidence/T-208/raw/all.json
//   node orchestrator/web-seat.mjs --seat qwen --prompt-file tmp/p.md --attach tmp/a.md --out out.json
//
// 退出码：0=全部成功 / 2=部分成功 / 3=失败

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { CDP } from './cdp-client.mjs';
import * as ws from './lib/web-seat.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

function parseArgs(argv) {
  const a = { seat: '', promptFile: '', attach: [], out: '', textOut: '', timeout: 180, readyTimeout: 90, parallel: false, fresh: true, host: '127.0.0.1', port: 9222, probe: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--seat') a.seat = next();
    else if (k === '--prompt-file') a.promptFile = next();
    else if (k === '--attach') a.attach.push(next());
    else if (k === '--out') a.out = next();
    else if (k === '--text-out') a.textOut = next();
    else if (k === '--timeout') a.timeout = Number(next());
    else if (k === '--ready-timeout') a.readyTimeout = Number(next());
    else if (k === '--host') a.host = next();
    else if (k === '--port') a.port = Number(next());
    else if (k === '--parallel') a.parallel = true;
    else if (k === '--probe') a.probe = true;
    else if (k === '--no-fresh') a.fresh = false;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function loadSeats() {
  const cfg = yaml.load(readFileSync('orchestrator/reviewers.yaml', 'utf8'));
  return cfg.reviewers_role.filter(s => s.enabled);
}

function ensureDir(p) {
  const dir = dirname(p);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
}

async function listPages(host, port) {
  const r = await fetch(`http://${host}:${port}/json/list`);
  return await r.json();
}

async function findOrCreateTab(cdp, seat, host, port) {
  const pages = await listPages(host, port);
  const re = new RegExp(seat.url_match, 'i');
  let page = pages.find(p => p.type === 'page' && re.test(p.url));
  let created = false;
  if (!page) {
    const t = await cdp.send('Target.createTarget', { url: seat.url_open });
    page = { id: t.targetId, url: seat.url_open };
    created = true;
  }
  return { page, created };
}

async function attach(cdp, page) {
  const a = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  const sid = a.sessionId;
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.enable', {}, sid);
  return sid;
}

async function runOne(cdp, seat, prompt, args) {
  const t0 = Date.now();
  const rec = {
    seat: seat.name, url_open: seat.url_open, editor_selector: seat.editor_selector,
    editor_kind: seat.editor_kind || 'textarea', response_selector: seat.response_selector || null,
    status: 'pending', error: null, text: '', textLen: 0, latencyMs: 0,
  };
  try {
    const { page, created } = await findOrCreateTab(cdp, seat, args.host, args.port);
    rec.targetId = page.id;
    rec.tabCreated = created;
    const sid = await attach(cdp, page);
    if (args.fresh) {
      // 导航超时不致命（ChatGPT/Cloudflare 首屏可能 >60s），改为"等编辑器出现"
      try { await cdp.send('Page.navigate', { url: seat.url_open }, sid); }
      catch (e) { rec.navError = e.message; }
      const readyMs = args.readyTimeout * 1000;
      const t1 = Date.now();
      let ready = false;
      while (Date.now() - t1 < readyMs) {
        try {
          const r = await cdp.send('Runtime.evaluate', {
            expression: `(() => { const el=document.querySelector(${JSON.stringify(seat.editor_selector)}); return { ready: document.readyState === 'complete', ed: !!el }; })()`,
            returnByValue: true,
          }, sid);
          const v = (r && r.result && r.result.value) || {};
          if (v.ed) { ready = true; break; }
        } catch {}
        await new Promise(x => setTimeout(x, 1000));
      }
      rec.editorReady = ready;
      rec.readyWaitMs = Date.now() - t1;
      if (!ready) { rec.status = 'editor_not_ready'; rec.error = 'editor_not_ready:' + (rec.navError || 'timeout'); rec.latencyMs = Date.now() - t0; return rec; }
    }
    const inj = await ws.injectBySelector(cdp, sid, seat.editor_selector, prompt, seat.editor_kind || 'textarea');
    rec.inject = inj;
    if (!inj.ok) { rec.status = 'inject_failed'; rec.error = 'inject:' + (inj.reason || 'unknown'); rec.latencyMs = Date.now() - t0; return rec; }
    if (args.attach.length && seat.file_input_selector) {
      const up = await ws.attachFiles(cdp, sid, seat.file_input_selector, args.attach);
      rec.upload = up;
      if (!up.ok) { rec.status = 'upload_failed'; rec.error = 'upload:' + (up.reason || 'unknown'); rec.latencyMs = Date.now() - t0; return rec; }
    }
    const sub = await ws.submit(cdp, sid, seat);
    rec.submit = sub;
    const w = await ws.waitGeneric(cdp, sid, {
      selector: seat.response_selector || 'body',
      timeoutMs: args.timeout * 1000,
      stableRounds: 3,
      intervalMs: 1500,
      minLen: 10,
    });
    rec.wait = { ok: w.ok, ms: w.ms, polls: w.polls, reason: w.reason || null, lastLen: w.lastLen ?? null };
    rec.text = w.text;
    rec.textLen = (w.text || '').length;
    rec.status = w.ok ? 'ok' : 'wait_failed';
    if (!w.ok) rec.error = 'wait:' + (w.reason || 'timeout');
  } catch (e) {
    rec.status = 'error';
    rec.error = e.message;
  }
  rec.latencyMs = Date.now() - t0;
  return rec;
}

async function probeSeat(cdp, seat, args) {
  const { page, created } = await findOrCreateTab(cdp, seat, args.host, args.port);
  const sid = await attach(cdp, page);
  if (args.fresh) {
    await cdp.send('Page.navigate', { url: seat.url_open }, sid);
    await new Promise(x => setTimeout(x, 6000));
  }
  const expr = `(() => {
    const vis = el => !!(el && (el.offsetParent !== null || el.getBoundingClientRect().height > 0));
    const desc = el => ({ tag: el.tagName.toLowerCase(), id: el.id || null, cls: (el.className || '').toString().slice(0, 70), ph: el.getAttribute ? el.getAttribute('placeholder') : null, ce: el.getAttribute ? el.getAttribute('contenteditable') : null, role: el.getAttribute ? el.getAttribute('role') : null, aria: el.getAttribute ? el.getAttribute('aria-label') : null, visible: vis(el) });
    return {
      url: location.href, title: document.title,
      bodyLen: document.body ? document.body.innerText.length : 0,
      bodyHead: document.body ? document.body.innerText.slice(0, 600) : '',
      iframes: [...document.querySelectorAll('iframe')].map(f => ({ src: (f.src || '').slice(0, 120), title: f.title || null })),
      textareas: [...document.querySelectorAll('textarea')].map(desc),
      inputs: [...document.querySelectorAll('input')].map(desc),
      contenteditables: [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')].map(desc),
      prosemirror: [...document.querySelectorAll('.ProseMirror, .tiptap, [data-lexical-editor="true"]')].map(desc),
      buttons: [...document.querySelectorAll('button')].filter(vis).slice(0, 20).map(desc),
    };
  })()`;
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
  const info = (r && r.result && r.result.value) || { error: 'probe_failed' };
  return { seat: seat.name, targetId: page.id, tabCreated: created, configured: { editor_selector: seat.editor_selector, editor_kind: seat.editor_kind, submit_selector: seat.submit_selector, response_selector: seat.response_selector, file_input_selector: seat.file_input_selector }, dom: info };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.seat || (!args.probe && !args.promptFile)) {
    console.log('用法: node orchestrator/web-seat.mjs --seat <name|all> --prompt-file <path> [--attach <file>] [--out <json>] [--text-out <path>] [--timeout 180] [--parallel] [--no-fresh]');
    console.log('      node orchestrator/web-seat.mjs --seat <name|all> --probe --out <json>   （查席位真实 DOM 配置）');
    process.exit(args.help ? 0 : 1);
  }
  let prompt = '';
  if (args.promptFile) {
    try { prompt = readFileSync(args.promptFile, 'utf8'); }
    catch (e) { console.error('[FATAL] 读不到 prompt 文件: ' + e.message); process.exit(3); }
  }

  const seats = loadSeats();
  const targets = args.seat === 'all' ? seats : seats.filter(s => s.name === args.seat);
  if (targets.length === 0) { console.error('[FATAL] 无匹配席位: ' + args.seat); process.exit(3); }

  let version;
  try { version = await fetch(`http://${args.host}:${args.port}/json/version`).then(r => r.json()); }
  catch (e) { console.error('[FATAL] CDP 不可达 ' + args.host + ':' + args.port + ' → ' + e.message); process.exit(3); }
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.connect();

  let recs = [];
  if (args.probe) {
    for (const s of targets) recs.push(await probeSeat(cdp, s, args));
    cdp.close();
    const out = { startedAt: new Date().toISOString(), mode: 'probe', results: recs };
    if (args.out) { ensureDir(args.out); writeFileSync(args.out, JSON.stringify(out, null, 2)); }
    console.log('[WEB-SEAT] probe 结果: ' + (args.out || '(仅 stdout)'));
    for (const r of recs) {
      const d = r.dom || {};
      console.log(`  ${r.seat}: url=${d.url || '?'} bodyLen=${d.bodyLen ?? '?'} frames=${(d.iframes || []).length}`);
      console.log(`    head: ${String(d.bodyHead || '').replace(/\s+/g, ' ').slice(0, 260)}`);
      console.log(`    textarea=${(d.textareas || []).length} input=${(d.inputs || []).length} ce=${(d.contenteditables || []).length} pm=${(d.prosemirror || []).length} btn=${(d.buttons || []).length}`);
      for (const t of (d.textareas || []).slice(0, 4)) console.log(`    [ta] ${t.visible ? 'V' : '-'} ph=${t.ph} cls=${t.cls}`);
      for (const t of (d.contenteditables || []).slice(0, 4)) console.log(`    [ce] ${t.visible ? 'V' : '-'} cls=${t.cls}`);
      for (const t of (d.prosemirror || []).slice(0, 4)) console.log(`    [pm] ${t.visible ? 'V' : '-'} cls=${t.cls}`);
      for (const t of (d.buttons || []).slice(0, 6)) console.log(`    [btn] ${t.aria || t.role || ''} cls=${t.cls}`);
    }
    process.exit(0);
  }
  if (args.parallel) {
    const settled = await Promise.allSettled(targets.map(s => runOne(cdp, s, prompt, args)));
    recs = settled.map((r, i) => r.status === 'fulfilled' ? r.value : { seat: targets[i].name, status: 'rejected', error: String(r.reason) });
  } else {
    for (const s of targets) recs.push(await runOne(cdp, s, prompt, args));
  }
  cdp.close();

  const okCount = recs.filter(r => r.status === 'ok').length;
  const out = { startedAt: new Date().toISOString(), browser: version.Browser, parallel: args.parallel, total: recs.length, ok: okCount, results: recs };
  if (args.out) { ensureDir(args.out); writeFileSync(args.out, JSON.stringify(out, null, 2)); }
  if (args.textOut) {
    ensureDir(args.textOut);
    writeFileSync(args.textOut, recs.map(r => `# ${r.seat} [${r.status}]\n\n${r.text || ''}`).join('\n\n---\n\n'));
  }
  console.log(`[WEB-SEAT] browser=${version.Browser} ok=${okCount}/${recs.length}`);
  for (const r of recs) console.log(`  ${r.seat}\t${r.status}\t${r.latencyMs}ms\tlen=${r.textLen}\t${r.error || ''}`);
  if (args.out) console.log('[WEB-SEAT] 证据: ' + args.out);
  process.exit(okCount === recs.length ? 0 : (okCount > 0 ? 2 : 3));
}

main().catch(e => { console.error('[FATAL] ' + e.message); process.exit(3); });
