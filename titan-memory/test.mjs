#!/usr/bin/env node
// End-to-end test for the shared memory MCP server.
//
// Speaks real newline-delimited JSON-RPC to server.mjs over stdio — the same
// frames OpenCode and Cline send — then verifies:
//   1. initialize / tools/list negotiate correctly (12 tools)
//   2. remember -> recall round-trips through the ACTUAL store file
//   3. the written fact satisfies DSH's FactSchema (writeDoc asserts it)
//   4. pre-existing Harness facts are left untouched
//   5. search and consolidate return usable output
//   6. error paths surface as isError content, not protocol failures
//   7. the test fact is removed again, so the run leaves no residue
//
// Run:  node test.mjs     (cwd must be the workspace)

import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readDoc, writeDoc, listActive, CONFIG } from './store.mjs';
import { appendCodingFact, appendDiffEntry } from './chain-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = process.cwd();
const CLIENT = 'test-harness';

// T-293: the core-memory tests must never touch the REAL CORE.md — every client
// auto-loads it, so a selftest write is visible to the whole session mid-run
// (observed: the system prompt briefly showed "# selftest core"). The server is
// spawned with TITAN_CORE_DIR pointed at a scratch dir instead, and the run ends
// by asserting the real file is byte-identical.
const CORE_DIR = path.join(WS, 'titan-memory', 'core');
const REAL_CORE_FILE = path.join(CORE_DIR, 'CORE.md');
const SCRATCH_CORE_DIR = path.join(os.tmpdir(), `titan-memory-core-${process.pid}-${Date.now()}`);
function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
let realCoreSha = null;
try { realCoreSha = sha256(fs.readFileSync(REAL_CORE_FILE, 'utf8')); } catch { /* absent */ }
if (path.resolve(WS) !== path.resolve(HERE)) {
	process.stderr.write(`[warn] suite cwd is ${WS}, not ${HERE}; core tests use a scratch dir (real CORE.md sha=${realCoreSha === null ? 'absent' : realCoreSha.slice(0, 8)})\n`);
}

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
	checks += 1;
	if (condition) {
		process.stdout.write(`  ok    ${label}\n`);
	} else {
		failures += 1;
		process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}\n`);
	}
}

class Client {
	constructor(child) {
		this.child = child;
		this.pending = new Map();
		this.nextId = 1;
		this.stderr = '';
		let buffer = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			buffer += chunk;
			let nl;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line.length === 0) continue;
				let message;
				try { message = JSON.parse(line); } catch { continue; }
				const waiter = this.pending.get(message.id);
				if (waiter) {
					this.pending.delete(message.id);
					waiter(message);
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => { this.stderr += chunk; });
	}

	request(method, params) {
		const id = this.nextId++;
		const payload = { jsonrpc: '2.0', id, method };
		if (params !== undefined) payload.params = params;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for ${method}`));
			}, 60_000);
			this.pending.set(id, (message) => {
				clearTimeout(timer);
				if (message.error) reject(new Error(`${method}: ${message.error.message}`));
				else resolve(message.result);
			});
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	notify(method, params) {
		const payload = { jsonrpc: '2.0', method };
		if (params !== undefined) payload.params = params;
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	async stop() {
		this.child.stdin.end();
		await new Promise((resolve) => {
			this.child.once('exit', resolve);
			setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 3000);
		});
	}
}

async function main() {
	const before = readDoc();
	const beforeActive = listActive(WS).length;
	const beforeIds = new Set(Object.keys(before.tables.facts));
	process.stdout.write(`store: active facts before = ${beforeActive}\n\n`);

	// Self-heal: an interrupted run (Ctrl-C, a closed stdout pipe, a crash before
	// the finally block) can leave `titan-mcp-selftest` facts behind. That tag is
	// only ever written by this suite, so clearing it at startup is safe and keeps
	// repeated runs from inflating the shared store.
	{
		const stale = Object.values(before.tables.facts)
			.filter((fact) => (fact.tags ?? []).includes('titan-mcp-selftest'))
			.map((fact) => fact.id);
		if (stale.length > 0) {
			const doc = readDoc();
			for (const id of stale) delete doc.tables.facts[id];
			writeDoc(memoryFileOf(), doc);
			beforeIds.clear();
			const refreshed = readDoc();
			for (const id of Object.keys(refreshed.tables.facts)) beforeIds.add(id);
			process.stdout.write(`removed ${stale.length} stale selftest fact(s) from a previous interrupted run\n\n`);
		}
	}
	const beforeActiveNow = listActive(WS).length;

	const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
		env: { ...process.env, TITAN_WORKSPACE: WS, TITAN_CLIENT: CLIENT, TITAN_CORE_DIR: SCRATCH_CORE_DIR },
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true
	});
	const client = new Client(child);
	let testFactId;

	try {
		process.stdout.write('protocol\n');
		const init = await client.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: CLIENT, version: '1.0.0' }
		});
		ok('initialize returns serverInfo', init?.serverInfo?.name === 'titan-memory');
		ok('initialize advertises tools capability', typeof init?.capabilities?.tools === 'object');
		client.notify('notifications/initialized');

		const ping = await client.request('ping');
		ok('ping responds', ping !== undefined);

		process.stdout.write('\ntools/list\n');
		const listed = await client.request('tools/list');
		const names = (listed.tools ?? []).map((t) => t.name).sort();
		ok('exposes exactly 16 tools',
			JSON.stringify(names) === JSON.stringify(['memory_candidates', 'memory_coding_recall', 'memory_consolidate', 'memory_core_recall', 'memory_core_remember', 'memory_edit', 'memory_explain', 'memory_forget', 'memory_import', 'memory_pin', 'memory_profile', 'memory_recall', 'memory_remember', 'memory_restore', 'memory_search', 'memory_undo']),
			JSON.stringify(names));
		for (const tool of listed.tools ?? []) {
			ok(`  ${tool.name} has description`, typeof tool.description === 'string' && tool.description.length > 40);
			ok(`  ${tool.name} inputSchema is a JSON object`, tool.inputSchema?.type === 'object');
		}

		process.stdout.write('\nremember -> recall round trip\n');
		const text = `titan-memory-mcp selftest t${Date.now().toString(36)} — verify shared store write path`;
		const rememberResult = await client.request('tools/call', {
			name: 'memory_remember',
			arguments: { text, kind: 'fact', tags: ['titan-mcp-selftest', 'verification'] }
		});
		ok('remember not an error', rememberResult.isError !== true, JSON.stringify(rememberResult));
		const stored = rememberResult.content?.[0]?.text ?? '';
		const idMatch = stored.match(/fact ([0-9a-f-]{36})/);
		testFactId = idMatch?.[1];
		ok('remember returns a fact id', Boolean(testFactId), stored.slice(0, 200));

		// The write must have landed in the real file, shape-valid for DSH.
		const after = readDoc();
		ok('fact persisted to dsh_memory.json', testFactId !== undefined && after.tables.facts[testFactId] !== undefined);
		const storedFact = after.tables.facts[testFactId];
		ok('fact has DSH FactSchema fields',
			storedFact?.workspacePath === WS && storedFact?.state === 'active'
			&& storedFact?.sessionId === `mcp:${CLIENT}`
			&& Number.isInteger(storedFact?.seq) && Number.isInteger(storedFact?.updatedAt));
		ok('pre-existing facts untouched',
			[...beforeIds].every((id) => after.tables.facts[id] !== undefined));
		ok('unit/global preserved',
			JSON.stringify(after.unit) === JSON.stringify(before.unit) && JSON.stringify(after.global) === JSON.stringify(before.global));

		const recallResult = await client.request('tools/call', {
			name: 'memory_recall',
			arguments: { query: 'titan-memory-mcp selftest', limit: 5 }
		});
		ok('recall not an error', recallResult.isError !== true, JSON.stringify(recallResult));
		const recallText = recallResult.content?.[0]?.text ?? '';
		ok('recall finds the new fact', recallText.includes('titan-memory-mcp selftest'), recallText.slice(0, 300));
		ok('recall returns the id', recallText.includes(testFactId ?? 'none'));

		process.stdout.write('\nrecall ranking parity\n');
		const tagHits = await client.request('tools/call', {
			name: 'memory_recall',
			arguments: { query: 'titan-mcp-selftest' }
		});
		ok('tag query ranks the fact first',
			(tagHits.content?.[0]?.text ?? '').trim().split('\n')[1]?.includes(testFactId ?? 'none'));

		process.stdout.write('\nerror paths\n');
		const empty = await client.request('tools/call', { name: 'memory_remember', arguments: { text: '   ' } });
		ok('empty text reported as isError', empty.isError === true && /empty/i.test(empty.content?.[0]?.text ?? ''),
			JSON.stringify(empty));
		const missing = await client.request('tools/call', { name: 'memory_remember', arguments: { text: 'x', id: 'no-such-id' } });
		ok('unknown id reported as isError', missing.isError === true && /MEMORY_NOT_FOUND/.test(missing.content?.[0]?.text ?? ''));
		const missingRecall = await client.request('tools/call', { name: 'memory_recall', arguments: { query: 'zzz_no_such_token_zzz' } });
		// cwd-agnostic: from a foreign cwd the garbage query may legitimately
		// hit real in-scope facts (token tag of T-65); inventing is what fails.
		ok('miss reports no match or only real facts (never invents)',
			/no active facts match|\d+ fact\(s\) in /.test(missingRecall.content?.[0]?.text ?? ''));
		const unknown = await client.request('tools/call', { name: 'not_a_tool', arguments: {} });
		ok('unknown tool reported as isError', unknown.isError === true);

		process.stdout.write('\nsearch\n');
		const search = await client.request('tools/call', {
			name: 'memory_search',
			arguments: { query: 'titan-memory-mcp selftest', limit: 3 }
		});
		ok('search not an error', search.isError !== true, JSON.stringify(search).slice(0, 300));
		process.stdout.write(`    search: ${(search.content?.[0]?.text ?? '').split('\n')[0].slice(0, 160)}\n`);

		process.stdout.write('\nconsolidate\n');
		const consol = await client.request('tools/call', { name: 'memory_consolidate', arguments: {} });
		ok('consolidate not an error', consol.isError !== true);
		const consolText = consol.content?.[0]?.text ?? '';
    ok('consolidate reports budget', /budget remaining: \d+ of 1000/.test(consolText), consolText.slice(0, 120));

		process.stdout.write('\ncore memory (dsh-core-memory style)\n');
		const coreWrite = await client.request('tools/call', {
			name: 'memory_core_remember',
			arguments: { text: '# selftest core\n\nM1 开工前三步 pull rebase 读台账 认领提交' }
		});
		ok('core remember not an error', coreWrite.isError !== true, JSON.stringify(coreWrite).slice(0, 200));
		const coreText = coreWrite.content?.[0]?.text ?? '';
		ok('core remember reports chars', /chars/.test(coreText), coreText.slice(0, 160));
		const noteWrite = await client.request('tools/call', {
			name: 'memory_core_remember',
			arguments: { text: '# selftest note\n\n10810 代理切换备忘', note: 'selftest-proxy' }
		});
		ok('note remember not an error', noteWrite.isError !== true, JSON.stringify(noteWrite).slice(0, 200));
		ok('note remember reports note id', /selftest-proxy/.test(noteWrite.content?.[0]?.text ?? ''));
		const coreHit = await client.request('tools/call', {
			name: 'memory_core_recall',
			arguments: { query: '认领提交', limit: 5 }
		});
		ok('core recall not an error', coreHit.isError !== true);
		const coreHitText = coreHit.content?.[0]?.text ?? '';
		ok('core recall finds CORE.md hit', /CORE\.md/.test(coreHitText), coreHitText.slice(0, 200));
		const noteHit = await client.request('tools/call', {
			name: 'memory_core_recall',
			arguments: { query: '10810', limit: 5 }
		});
		const noteHitText = noteHit.content?.[0]?.text ?? '';
		ok('note recall finds selftest-proxy', /selftest-proxy/.test(noteHitText), noteHitText.slice(0, 200));
		const miss = await client.request('tools/call', {
			name: 'memory_core_recall',
			arguments: { query: 'zzz_nothing_matches_xyz', limit: 5 }
		});
		ok('note recall misses on gibberish', /no hits|no notes/.test(miss.content?.[0]?.text ?? ''), (miss.content?.[0]?.text ?? '').slice(0, 200));

		process.stdout.write('\nunknown method\n');
		await client.request('resources/list').then(
			() => ok('unknown method rejected', false, 'resolved instead of rejecting'),
			() => ok('unknown method rejected', true)
		);

		// T-150 coding chain: the fact carries coordinates only; the diff body
		// lives in the content-addressed chain store and is returned only when
		// the caller explicitly asks for it.
		process.stdout.write('\ncoding memory chain (T-150)\n');
		const chainFact = appendCodingFact(
			{ file: 'src/selftest.ts', function: 'runSelftest', branch: 'main' },
			{ summary: 'selftest coding fact', ws: WS }
		);
		const chainDiff = appendDiffEntry(
			'--- a/src/selftest.ts\n+++ b/src/selftest.ts\n@@\n-old\n+new\n',
			{ file: 'src/selftest.ts', function: 'runSelftest', branch: 'main' },
			{ summary: 'selftest diff', ref: 'git:selftest' },
			{ ws: WS }
		);
		const chainHit = await client.request('tools/call', {
			name: 'memory_coding_recall',
			arguments: { fact_id: chainFact.id }
		});
		ok('coding recall not an error', chainHit.isError !== true, JSON.stringify(chainHit).slice(0, 200));
		const chainText = chainHit.content?.[0]?.text ?? '';
		let chainBlockJson = {};
		try { chainBlockJson = JSON.parse(chainText); } catch { /* keep empty */ }
		ok('coding recall returns coordinates', chainBlockJson?.fact?.coordinates?.file === 'src/selftest.ts', chainText.slice(0, 200));
		ok('coding recall returns diff reference', chainBlockJson?.diffs?.[0]?.hash === chainDiff.hash, chainText.slice(0, 200));
		ok('coding recall hides diff body by default',
			!chainText.includes('@@') && chainBlockJson?.bodies === undefined, chainText.slice(0, 200));
		const chainBodies = await client.request('tools/call', {
			name: 'memory_coding_recall',
			arguments: { fact_id: chainFact.id, include_bodies: true }
		});
		const bodiesText = chainBodies.content?.[0]?.text ?? '';
		ok('coding recall returns body only when asked', bodiesText.includes('@@'), bodiesText.slice(0, 200));
		const chainMiss = await client.request('tools/call', {
			name: 'memory_coding_recall',
			arguments: { fact_id: 'no-such-coding-fact' }
		});
		ok('coding recall missing fact is an error result (not a crash)',
			chainMiss.isError === true && /not found|MEMORY_NOT_FOUND/i.test(chainMiss.content?.[0]?.text ?? ''),
			JSON.stringify(chainMiss).slice(0, 200));
		// T-293 extras run against a SCRATCH copy of the store. The shared store is
		// the live memory of all four clients — a destructive test there once
		// archived four real facts (see archive/evidence/T-293/).
		process.stdout.write('\ntitan extras (T-293, scratch store)\n');
		const scratchFile = path.join(os.tmpdir(), `titan-memory-t293-${process.pid}-${Date.now()}.json`);
		fs.copyFileSync(memoryFileOf(), scratchFile);
		const scratchChild = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
			env: { ...process.env, TITAN_WORKSPACE: WS, TITAN_CLIENT: CLIENT, TITAN_MEMORY_FILE: scratchFile },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		});
		const scratch = new Client(scratchChild);
		const readScratch = () => readDoc(scratchFile);
		try {
			const scratchInit = await scratch.request('initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: CLIENT, version: '1.0.0' }
			});
			ok('scratch server initialized', scratchInit?.serverInfo?.name === 'titan-memory');
			scratch.notify('notifications/initialized');

			const mkFact = async (body) => {
				const created = await scratch.request('tools/call', {
					name: 'memory_remember',
					arguments: { text: body, kind: 'fact', tags: ['T293-selftest', 'titan-mcp-selftest'] }
				});
				const createdText = created.content?.[0]?.text ?? '';
				const idMatch = createdText.match(/fact ([0-9a-f-]{36})/);
				return { res: created, id: idMatch?.[1], text: createdText };
			};

			const rejected = await scratch.request('tools/call', {
				name: 'memory_remember',
				arguments: { text: 'selftest password: hunter2 supersecret', kind: 'fact' }
			});
			ok('privacy: password-like text rejected', rejected.isError === true && /MEMORY_PRIVACY_REJECTED/.test(rejected.content?.[0]?.text ?? ''), JSON.stringify(rejected).slice(0, 200));
			const rejectedCard = await scratch.request('tools/call', {
				name: 'memory_remember',
				arguments: { text: 'selftest card 4111111111111111 registered', kind: 'fact' }
			});
			ok('privacy: card-like text rejected', rejectedCard.isError === true && /MEMORY_PRIVACY_REJECTED/.test(rejectedCard.content?.[0]?.text ?? ''));

			const factA = await mkFact(`T293 selftest alpha bravo charlie delta echo foxtrot golf ${Date.now()} one`);
			ok('T293 factA created', Boolean(factA.id), factA.text.slice(0, 120));
			const explained = await scratch.request('tools/call', { name: 'memory_explain', arguments: { id: factA.id } });
			const explainText = explained.content?.[0]?.text ?? '';
			ok('explain not an error', explained.isError !== true);
			ok('explain shows provenance', /"provenance"/.test(explainText) && /"sessionId"/.test(explainText) && /mcp:test-harness/.test(explainText), explainText.slice(0, 300));

			const pinA = await scratch.request('tools/call', { name: 'memory_pin', arguments: { id: factA.id } });
			ok('pin works', /pinned/.test(pinA.content?.[0]?.text ?? ''));
			const unpinA = await scratch.request('tools/call', { name: 'memory_pin', arguments: { id: factA.id, unpin: true } });
			ok('unpin works', /unpinned/.test(unpinA.content?.[0]?.text ?? ''));
			await scratch.request('tools/call', { name: 'memory_pin', arguments: { id: factA.id } });

			await mkFact('T293 selftest dup-pair alpha bravo charlie delta echo foxtrot golf hotel india pairmarker');
			await mkFact('T293 selftest dup-pair alpha bravo charlie delta echo foxtrot golf hotel zulu pairmarker');
			const applied = await scratch.request('tools/call', { name: 'memory_consolidate', arguments: { apply: true } });
			ok('consolidate apply not an error', applied.isError !== true, JSON.stringify(applied).slice(0, 200));
			const applyText = applied.content?.[0]?.text ?? '';
			ok('consolidate apply reports what it archived',
				/archived \d+ older member|nothing needed archiving/.test(applyText), applyText.slice(0, 200));
			ok('pinned fact survives consolidation apply', readScratch().tables.facts[factA.id]?.state === 'active');

			const undoOnce = await scratch.request('tools/call', { name: 'memory_undo', arguments: {} });
			const undoText = undoOnce.content?.[0]?.text ?? '';
			ok('undo not an error', undoOnce.isError !== true, undoText.slice(0, 120));
			ok('undo reverses the last action', /undone (archive|create|pin|unpin|restore|update)/.test(undoText), undoText.slice(0, 120));

			const factZ = await mkFact('T293 selftest undo-create-target zulu yankee xray whiskey victor uniform tango sierra romeo');
			ok('T293 factZ created', Boolean(factZ.id));
			const undoZ = await scratch.request('tools/call', { name: 'memory_undo', arguments: {} });
			ok('undo removes the just-created fact', /undone create/.test(undoZ.content?.[0]?.text ?? ''), undoZ.content?.[0]?.text ?? '');
			ok('undone fact is gone from the scratch store', factZ.id !== undefined && readScratch().tables.facts[factZ.id] === undefined);

			const factD = await mkFact('T293 selftest forget-target marker parrot mango mango-lone-marker');
			ok('T293 factD created', Boolean(factD.id));
			const forgetDryRun = await scratch.request('tools/call', { name: 'memory_forget', arguments: { id: factD.id } });
			const dryText = forgetDryRun.content?.[0]?.text ?? '';
			ok('forget defaults to dry-run', /DRY RUN/.test(dryText) && /nothing deleted/.test(dryText), dryText.slice(0, 120));
			ok('dry-run leaves the fact in place', readScratch().tables.facts[factD.id] !== undefined);
			const forgetReal = await scratch.request('tools/call', { name: 'memory_forget', arguments: { id: factD.id, confirm: true } });
			ok('forget with confirm deletes', /^deleted/.test(forgetReal.content?.[0]?.text ?? ''), JSON.stringify(forgetReal).slice(0, 200));
			ok('forgotten fact absent from store', factD.id !== undefined && readScratch().tables.facts[factD.id] === undefined);

			const pinnedForget = await scratch.request('tools/call', { name: 'memory_forget', arguments: { id: factA.id, confirm: true } });
			ok('forget refuses a pinned fact', pinnedForget.isError === true && /MEMORY_PINNED/.test(pinnedForget.content?.[0]?.text ?? ''), JSON.stringify(pinnedForget).slice(0, 200));

			// memory_edit: replace text + kind of an existing fact via scratch server.
			const editTarget = await scratch.request('tools/call', { name: 'memory_remember', arguments: { text: 'editable target for edit test', kind: 'fact', tags: ['edit-me'] } });
			const editId = editTarget.content?.[0]?.text.match(/stored \w+ fact ([0-9a-f-]{36})/)?.[1];
			ok('edit target created', Boolean(editId));
			const edited = await scratch.request('tools/call', { name: 'memory_edit', arguments: { id: editId, text: 'edited text with new kind and tags', kind: 'decision', tags: ['edited'] } });
			const editText = edited.content?.[0]?.text ?? '';
			ok('edit returns ok', edited.isError !== true && /edited fact/.test(editText), JSON.stringify(edited).slice(0, 200));
			const afterEdit = readScratch().tables.facts[editId];
			ok('edit persists text/kind/tags', afterEdit?.text === 'edited text with new kind and tags' && afterEdit?.kind === 'decision' && JSON.stringify(afterEdit.tags) === JSON.stringify(['edited']));

			// memory_edit with only kind: keep text unchanged.
			const kindOnly = await scratch.request('tools/call', { name: 'memory_edit', arguments: { id: editId, kind: 'convention' } });
			ok('kind-only edit ok', kindOnly.isError !== true);
			ok('text unchanged after kind-only edit', readScratch().tables.facts[editId]?.kind === 'convention' && readScratch().tables.facts[editId]?.text === 'edited text with new kind and tags');

			// memory_edit: MEMORY_NOT_FOUND for unknown id.
			const editMissing = await scratch.request('tools/call', { name: 'memory_edit', arguments: { id: 'no-such-edit-id', text: 'x' } });
			ok('edit rejects unknown id', editMissing.isError === true && /MEMORY_NOT_FOUND/.test(editMissing.content?.[0]?.text ?? ''));
			// memory_edit: MEMORY_INVALID_ARGS when nothing supplied.
			const editEmpty = await scratch.request('tools/call', { name: 'memory_edit', arguments: { id: editId } });
			ok('edit rejects empty payload', editEmpty.isError === true && /MEMORY_INVALID_ARGS/.test(editEmpty.content?.[0]?.text ?? ''));

			// memory_profile: read empty profile.
			const profileRead1 = await scratch.request('tools/call', { name: 'memory_profile', arguments: {} });
			const prof1 = profileRead1.content?.[0]?.text ?? '';
			ok('profile read returns count', /workspace profile:\s*\d+\/8 entries/.test(prof1));

			// memory_profile: write (replace all).
			const profileWrite = await scratch.request('tools/call', { name: 'memory_profile', arguments: { target: 'profile', entries: ['profile entry alpha', 'profile entry beta'] } });
			const profWriteText = profileWrite.content?.[0]?.text ?? '';
			ok('profile write returns ok', profileWrite.isError !== true && /workspace profile updated: 2 entries/.test(profWriteText), JSON.stringify(profileWrite).slice(0, 200));

			// memory_profile: read back what was written.
			const profileRead2 = await scratch.request('tools/call', { name: 'memory_profile', arguments: {} });
			const prof2 = profileRead2.content?.[0]?.text ?? '';
			ok('profile read back entries', /0\. profile entry alpha/.test(prof2) && /1\. profile entry beta/.test(prof2));

			// memory_import: dry-run preview (default confirm=false) writes nothing
			const beforeFactCount = Object.values(readScratch().tables.facts).length;
			const importDry = await scratch.request('tools/call', { name: 'memory_import', arguments: { limit: 5 } });
			const importDryText = importDry.content?.[0]?.text ?? '';
			ok('import dry-run not an error', importDry.isError !== true, JSON.stringify(importDry).slice(0, 200));
			ok('import dry-run is preview only', /DRY RUN/.test(importDryText) && /would import/.test(importDryText));
			ok('import dry-run wrote nothing', Object.values(readScratch().tables.facts).length === beforeFactCount);

			// memory_import: confirm=true imports matching session-log lines (may be 0 if none match)
			const importReal = await scratch.request('tools/call', { name: 'memory_import', arguments: { limit: 3, confirm: true } });
			const realText = importReal.content?.[0]?.text ?? '';
			ok('import confirm not an error', importReal.isError !== true, JSON.stringify(importReal).slice(0, 200));
			const importedMatch = realText.match(/imported (\d+) fact/);
			const importedN = importedMatch ? parseInt(importedMatch[1], 10) : -1;
			ok('import confirm reports a count', importedN >= 0);
			if (importedN > 0) {
				ok('imported facts carry imported tag', Object.values(readScratch().tables.facts).some(f => (f.tags ?? []).includes('imported')));
				ok('imported facts carry sessionId provenance', Object.values(readScratch().tables.facts).some(f => (f.tags ?? []).includes('imported') && typeof f.sessionId === 'string' && f.sessionId.length > 0));
			}
			ok('active facts grew by imported count', Object.values(readScratch().tables.facts).length === beforeFactCount + importedN);

			// Archive -> restore round trip on the scratch store.
			const archivedNow = { ...readScratch() };
			archivedNow.tables.facts[factA.id] = { ...archivedNow.tables.facts[factA.id], state: 'archived' };
			writeDoc(scratchFile, archivedNow);
			const restored = await scratch.request('tools/call', { name: 'memory_restore', arguments: { id: factA.id } });
			ok('restore revives an archived fact', /restored/.test(restored.content?.[0]?.text ?? '') && readScratch().tables.facts[factA.id]?.state === 'active', JSON.stringify(restored).slice(0, 200));

			const unpinA2 = await scratch.request('tools/call', { name: 'memory_pin', arguments: { id: factA.id, unpin: true } });
			ok('cleanup unpin factA', unpinA2.isError !== true);
		} finally {
			await scratch.stop();
			if (scratch.stderr.trim().length > 0) {
				process.stdout.write(`\nscratch server stderr:\n${scratch.stderr.trim().split('\n').slice(0, 6).map((l) => `  ${l}`).join('\n')}\n`);
			}
			for (const suffix of ['', '.bak', '.titan-journal.jsonl', '.titan-pins.json', '.titan.tmp', '.bak.titan.tmp']) {
				fs.rmSync(`${scratchFile}${suffix}`, { force: true });
			}
			ok('scratch store files removed', !fs.existsSync(scratchFile) && !fs.existsSync(`${scratchFile}.titan-journal.jsonl`));
		}

		// The shared store is checked after cleanup below (the main suite's own
		// self-test fact is still present at this point).
	} finally {
		await client.stop();
		if (client.stderr.trim().length > 0) {
			process.stdout.write(`\nserver stderr:\n${client.stderr.trim().split('\n').slice(0, 6).map((l) => `  ${l}`).join('\n')}\n`);
		}
	}

	// Cleanup: the tool set deliberately has no delete, so unwind the test fact
	// through the same shape-checked writer the server uses.
	process.stdout.write('\ncleanup\n');
	if (testFactId !== undefined) {
		const doc = readDoc();
		if (doc.tables.facts[testFactId]) delete doc.tables.facts[testFactId];
		writeDoc(memoryFileOf(), doc);
		const gone = readDoc().tables.facts[testFactId] === undefined;
		ok('test fact removed', gone);
	}
	const finalActive = listActive(WS).length;
	ok(`active facts restored (${finalActive} of ${beforeActiveNow})`, finalActive === beforeActiveNow);
	const afterShared = readDoc();
	const leaked = Object.values(afterShared.tables.facts).filter((fact) => (fact.tags ?? []).includes('T293-selftest'));
	ok('shared store untouched by the T-293 suite', leaked.length === 0 && Object.keys(afterShared.tables.facts).length === beforeIds.size,
		`leaked=${leaked.length} facts=${Object.keys(afterShared.tables.facts).length}/${beforeIds.size}`);

	// Core tests ran entirely inside SCRATCH_CORE_DIR (TITAN_CORE_DIR). Assert
	// two things: the scratch tree is gone, and the REAL CORE.md is bit-identical
	// to its pre-run hash — the file every client auto-loads must never be
	// transiently rewritten by a test run.
	fs.rmSync(SCRATCH_CORE_DIR, { recursive: true, force: true });
	ok('scratch core tree removed', !fs.existsSync(SCRATCH_CORE_DIR));
	const nowRealCoreSha = fs.existsSync(REAL_CORE_FILE)
		? sha256(fs.readFileSync(REAL_CORE_FILE, 'utf8'))
		: null;
	ok('suite did not touch the real CORE.md',
		nowRealCoreSha === realCoreSha,
		`before=${realCoreSha === null ? 'absent' : realCoreSha.slice(0, 8)} after=${nowRealCoreSha === null ? 'absent' : nowRealCoreSha.slice(0, 8)}`);
	ok('real core notes dir has no selftest residue',
		!fs.existsSync(path.join(CORE_DIR, 'notes', 'selftest-proxy.md')));

	// A partial/legacy fact row must be repaired on read, never block writers.
	// T-285: three hand-written facts missing sessionId/seq/updatedAt/state made
	// assertShape reject EVERY write on this shared store. See archive/evidence/T-285/.
	process.stdout.write('\nlegacy-fact repair\n');
	{
		const tmp = path.join(WS, '.titan-legacy-test.json');
		const legacy = {
			unit: 'dsh_memory',
			global: {},
			tables: {
				facts: {
					a1: { id: 'a1', workspacePath: WS, kind: 'fact', text: 'legacy row without provenance', tags: ['t'], createdAt: '2026-11-05T17:30:00.000Z' },
					a2: { id: 'a2', workspacePath: WS, kind: 'nonsense', text: 'bad kind, bad tags, bad state', tags: 'oops', createdAt: 1, state: 'bogus' },
					a3: { id: 'a3', workspacePath: '', kind: 'fact', text: 'no workspace' }
				},
				profiles: {}
			}
		};
		fs.writeFileSync(tmp, JSON.stringify(legacy, null, 2), 'utf8');
		const doc = readDoc(tmp);
		const f1 = doc.tables.facts.a1;
		const f2 = doc.tables.facts.a2;
		ok('legacy row gains sessionId', typeof f1?.sessionId === 'string' && f1.sessionId.length > 0, JSON.stringify(f1));
		ok('legacy ISO createdAt coerced to integer epoch', Number.isInteger(f1?.createdAt) && f1.createdAt > 0, JSON.stringify(f1?.createdAt));
		ok('legacy row gains updatedAt + seq + state', Number.isInteger(f1?.updatedAt) && Number.isInteger(f1?.seq) && f1?.state === 'active', JSON.stringify(f1));
		ok('bad kind coerced to fact, bad tags coerced to array', f2?.kind === 'fact' && Array.isArray(f2.tags), JSON.stringify(f2));
		ok('bad state coerced to active', f2?.state === 'active', JSON.stringify(f2?.state));
		ok('unusable row (no workspacePath) dropped', doc.tables.facts.a3 === undefined);
		let threw = null;
		try { writeDoc(tmp, doc); } catch (error) { threw = error; }
		ok('writeDoc accepts the repaired doc (no MEMORY_UNAVAILABLE)', threw === null, String(threw));
		fs.rmSync(tmp, { force: true });
		fs.rmSync(`${tmp}.bak`, { force: true });
	}

	process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
	process.exit(failures === 0 ? 0 : 1);
}

function memoryFileOf() {
	return process.env.TITAN_MEMORY_FILE
		|| path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'storages', 'dsh_memory.json');
}

main().catch((error) => {
	process.stderr.write(`\nFATAL ${error?.stack ?? error}\n`);
	process.exit(1);
});
