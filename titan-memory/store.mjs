// Shared long-term-memory store for TITAN (OpenCode / Cline / Harness).
//
// Reads and writes the SAME file DSH's own dsh-native-memory plugin uses:
//   ~/.dsh/storages/dsh_memory.json
// so all three clients share one memory. The recall scoring below is a faithful
// port of dsh-native-memory's pure functions (MIT) so that Harness and the MCP
// clients return identical rankings for the same query.
//
// TITAN-only extras (never touch DSH-owned shape):
//   - pins: sidecar file `<store>.titan-pins.json` = {"<id>": true}
//   - journal: append-only `<store>.titan-journal.jsonl` (before/after of every
//     write, plus undo markers) — enables memory_undo and forensic audit
//   - privacy filter rejects credential-like facts at write time
//   - forget physically removes the fact (store + *.bak backups + journal
//     redaction) with an explicit dry-run/confirm contract

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------- config

export const CONFIG = {
	maxFactsPerWorkspace: 1000,
	maxFactChars: 2000,
	lockStaleMs: 10_000,
	lockTimeoutMs: 5_000,
	lockRetryMs: 15
};

export const KINDS = ['preference', 'fact', 'convention', 'decision'];

export function memoryFile() {
	return process.env.TITAN_MEMORY_FILE
		|| path.join(os.homedir(), '.dsh', 'storages', 'dsh_memory.json');
}

// Deterministic write-time privacy filter. Rejects credential-like text; never
// echoes the matched content. Better to reject a borderline fact than to persist it.
function luhnValid(digits) {
	let sum = 0;
	let alternate = false;
	for (let i = digits.length - 1; i >= 0; i -= 1) {
		let digit = digits.charCodeAt(i) - 48;
		if (alternate) { digit *= 2; if (digit > 9) digit -= 9; }
		sum += digit;
		alternate = !alternate;
	}
	return sum % 10 === 0;
}

function cardLike(match) {
	const grouped = /[\s-]/.test(match);
	const digits = match.replace(/[\s-]/g, '');
	if (!/^\d+$/.test(digits)) return false;
	// A bare 13-digit run starting with 1 is almost always an epoch-millis
	// timestamp (2001–2286), not a card. Requiring 16+ digits unless the run is
	// visibly grouped keeps `remember` from rejecting ordinary notes that quote
	// Date.now().
	if (digits.length < 16 && !(grouped && digits.length >= 13)) return false;
	if (digits.length === 13 && digits.startsWith('1')) return false;
	return digits.length <= 19 && luhnValid(digits);
}

const PRIVACY_PATTERNS = [
	['cn-id-card', /\b\d{15}\b|\b\d{17}[\dXx]\b/],
	['cn-mobile', /\b1[3-9]\d{9}\b/],
	['password', /(password|passwd|pwd|口令|密码)\s*[:：=]\s*["']?[^\s"']{6,}/i],
	['api-secret', /\b(sk|pk|api[-_]?key|access[-_]?token|secret[-_]?key)[-_][A-Za-z0-9_\-]{12,}\b/i]
];

export function privacyViolation(text) {
	const cardRuns = text.match(/(?:\d[\s-]?){13,19}\d/g) ?? [];
	for (const run of cardRuns) {
		if (cardLike(run)) return 'bank-card';
	}
	for (const [name, pattern] of PRIVACY_PATTERNS) {
		if (pattern.test(text)) return name;
	}
	return null;
}

export function journalFile(file = memoryFile()) {
	return `${file}.titan-journal.jsonl`;
}

/** Append-only audit/undo trail. One JSON object per line. `undone` entries
 *  are folded in-line so a single pass can compute the undoable set. */
export function readJournal(file = journalFile()) {
	let raw = '';
	try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
	const entries = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try { entries.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
	}
	return entries;
}

function appendJournal(entry, file = journalFile()) {
	try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8'); } catch (error) {
		process.stderr.write(`[titan-memory] journal append failed: ${error?.message ?? error}\n`);
	}
}

export function readPins(file = memoryFile()) {
	try {
		const parsed = JSON.parse(fs.readFileSync(pinsFile(file), 'utf8'));
		if (parsed && typeof parsed === 'object') return new Set(Object.keys(parsed));
		return new Set();
	} catch { return new Set(); }
}

function writePins(pins, file = memoryFile()) {
	const tmp = pinsFile(file) + '.titan.tmp';
	fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries([...pins].map((id) => [id, true])), null, 0)}\n`, 'utf8');
	fs.renameSync(tmp, pinsFile(file));
}

export function pinsFile(file = memoryFile()) {
	return `${file}.titan-pins.json`;
}

/** Canonical workspace-path form. The fact table joins on an EXACT string
 *  match, DSH writes the native spelling (the native local spelling), while the
 *  MCP configs spell it `<workspace>`. Without normalising, a
 *  forward-slash TITAN_WORKSPACE silently returns zero active facts — this
 *  bug shipped in the first wiring and was caught by the Cline cross-check. */
export function normalizeWorkspacePath(input) {
	let value = String(input ?? '').trim();
	while (value.length > 1 && (value.endsWith('/') || value.endsWith('\\'))) value = value.slice(0, -1);
	if (process.platform === 'win32') value = value.split('/').join('\\');
	return value;
}

/** Workspace this client is bound to. Explicit env beats cwd: MCP servers can
 *  be launched with an arbitrary cwd, and the fact table is workspace-scoped. */
export function workspacePath() {
	return normalizeWorkspacePath(process.env.TITAN_WORKSPACE || process.cwd());
}

/** Provenance stamped on facts we write, so a reader can tell MCP writes from
 *  Harness writes. Set TITAN_CLIENT=opencode / cline in each client's config. */
function originSession() {
	return `mcp:${process.env.TITAN_CLIENT || 'unknown'}`;
}

// ------------------------------------------------- dsh-native-memory port
// Source: node_modules/dsh-native-memory/lib/index.mjs (MIT, highland0971)

export function tokenize(query) {
	const tokens = new Set();
	for (const word of query.toLowerCase().split(/\s+/)) {
		const runs = word.match(/[㐀-鿿]+|[^㐀-鿿]+/g) ?? [];
		for (const run of runs) {
			tokens.add(run);
			if (/^[㐀-鿿]+$/.test(run) && run.length >= 2) {
				for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
			}
		}
	}
	return [...tokens].filter((token) => token.length > 0);
}

export function factTokens(text) {
	const tokens = new Set();
	const runs = text.toLowerCase().match(/[㐀-鿿]+|[^㐀-鿿]+/g) ?? [];
	for (const run of runs) {
		if (/^[㐀-鿿]+$/.test(run)) {
			tokens.add(run);
			for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
		} else {
			for (const word of run.split(/[^a-z0-9]+/)) if (word.length > 0) tokens.add(word);
		}
	}
	return tokens;
}

/** Three tiers: exact tag +3, fuzzy tag +1, case-insensitive text substring +2,
 *  whole multi-word phrase +4. */
export function scoreFact(fact, tokens, fullQuery, phraseBoost) {
	const text = fact.text.toLowerCase();
	const tags = (fact.tags ?? []).map((tag) => tag.toLowerCase());
	let score = 0;
	for (const token of tokens) {
		if (tags.includes(token)) score += 3;
		else if (tags.some((tag) => tag.includes(token) || token.includes(tag))) score += 1;
		if (text.includes(token)) score += 2;
	}
	if (phraseBoost && fullQuery.length > 1 && text.includes(fullQuery)) score += 4;
	return score;
}

export function compareRecency(left, right) {
	return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

const CONSOLIDATION_SIMILARITY = 0.55;
const CONSOLIDATION_MAX_PAIRS = 5;

export function suggestConsolidations(facts) {
	const tokenSets = facts.map((fact) => ({ fact, tokens: factTokens(fact.text) }));
	const candidates = [];
	for (let i = 0; i < tokenSets.length; i += 1) {
		for (let j = i + 1; j < tokenSets.length; j += 1) {
			const left = tokenSets[i];
			const right = tokenSets[j];
			const intersection = [...left.tokens].filter((token) => right.tokens.has(token)).length;
			const union = new Set([...left.tokens, ...right.tokens]).size;
			if (union === 0) continue;
			const similarity = intersection / union;
			if (similarity < CONSOLIDATION_SIMILARITY) continue;
			candidates.push({
				a: left.fact,
				b: right.fact,
				similarity,
				suggestedText: `${left.fact.text} ${right.fact.text}`.slice(0, 600)
			});
		}
	}
	return candidates
		.sort((x, y) => y.similarity - x.similarity || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id))
		.slice(0, CONSOLIDATION_MAX_PAIRS);
}

export function truncate(text, max) {
	return [...text].length <= max ? text : `${[...text].slice(0, max).join('')}…`;
}

export function iso(millis) {
	return new Date(millis).toISOString();
}

export function factLine(fact, { pinned = false } = {}) {
	const tags = (fact.tags ?? []).length > 0 ? ` (tags: ${fact.tags.join(', ')})` : '';
	const pin = pinned ? ' · pinned' : '';
	const src = typeof fact.sessionId === 'string' ? ` · src ${fact.sessionId}#${fact.seq ?? 0}` : '';
	return `- ${fact.id} [${fact.kind}] ${truncate(fact.text, 400)}${tags} — updated ${iso(fact.updatedAt)}${src}${pin}`;
}

// ------------------------------------------------------------ file access

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MemoryError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = 'MemoryError';
	}
}

/** Serialise our own writers (OpenCode + Cline can hit the file at once).
 *  DSH does not take this lock — it writes on demand only (verified: the file
 *  sat untouched for 6h while dsh was running), so the window stays tiny. */
async function withLock(file, fn) {
	const lock = `${file}.titanlock`;
	const deadline = Date.now() + CONFIG.lockTimeoutMs;
	for (;;) {
		try {
			fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
			break;
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > CONFIG.lockStaleMs) {
					fs.rmSync(lock, { force: true });
					continue;
				}
			} catch { /* lock vanished; retry */ }
			if (Date.now() > deadline) {
				fs.rmSync(lock, { force: true });
				continue;
			}
			await sleep(CONFIG.lockRetryMs);
		}
	}
	try {
		return await fn();
	} finally {
		fs.rmSync(lock, { force: true });
	}
}

/** Accept epoch millis or a parseable date string; else undefined. */
function epochMillis(value) {
	if (Number.isInteger(value) && value >= 0) return value;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

/** Repair one fact row that was written by a path which skipped the FactSchema
 *  (an older writer, a hand-edited file, or another memory tool): fill the
 *  provenance and lifecycle fields assertShape requires and coerce obviously
 *  bad values. Returns null for an unusable row (missing id/workspacePath/text)
 *  so the caller drops it instead of letting it block every future write.
 *  Idempotent: a conforming fact passes through unchanged. */
function coerceFact(key, fact) {
	if (fact === null || typeof fact !== 'object') return null;
	const id = typeof fact.id === 'string' && fact.id.length > 0 ? fact.id : key;
	if (typeof id !== 'string' || id.length === 0) return null;
	if (typeof fact.workspacePath !== 'string' || fact.workspacePath.length === 0) return null;
	if (typeof fact.text !== 'string' || fact.text.length === 0) return null;
	const out = { ...fact, id };
	out.kind = KINDS.includes(out.kind) ? out.kind : 'fact';
	out.tags = Array.isArray(out.tags) ? out.tags.filter((tag) => typeof tag === 'string') : [];
	out.sessionId = typeof out.sessionId === 'string' && out.sessionId.length > 0 ? out.sessionId : 'legacy:unattributed';
	out.seq = Number.isInteger(out.seq) && out.seq >= 0 ? out.seq : 0;
	out.createdAt = epochMillis(out.createdAt) ?? Date.now();
	out.updatedAt = epochMillis(out.updatedAt) ?? out.createdAt;
	out.state = out.state === 'archived' ? 'archived' : 'active';
	return out;
}

function normalise(doc) {
	if (doc === null || typeof doc !== 'object') throw new MemoryError('MEMORY_UNAVAILABLE', 'memory file is not a JSON object');
	doc.tables = doc.tables ?? {};
	doc.tables.facts = doc.tables.facts ?? {};
	doc.tables.profiles = doc.tables.profiles ?? {};
	for (const [key, fact] of Object.entries(doc.tables.facts)) {
		const repaired = coerceFact(key, fact);
		if (repaired === null) delete doc.tables.facts[key];
		else doc.tables.facts[key] = repaired;
	}
	return doc;
}

export function readDoc(file = memoryFile()) {
	const raw = fs.readFileSync(file, 'utf8');
	return normalise(JSON.parse(raw));
}

/** Atomic replace. Keeps a rolling .bak of the previous bytes so a bad write is
 *  always recoverable, and refuses to persist a doc whose facts fail the DSH
 *  FactSchema shape (a malformed row would make the Harness plugin refuse to
 *  open the domain at all). Exported so tests can clean up after themselves. */
export function writeDoc(file, doc) {
	assertShape(doc);
	const backup = `${file}.bak`;
	try { fs.copyFileSync(file, backup); } catch { /* first run */ }
	const tmp = `${file}.titan.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
}

function assertShape(doc) {
	for (const [id, fact] of Object.entries(doc.tables.facts)) {
		const problems = [];
		if (typeof fact?.id !== 'string' || fact.id.length === 0) problems.push('id');
		if (typeof fact?.workspacePath !== 'string' || fact.workspacePath.length === 0) problems.push('workspacePath');
		if (!KINDS.includes(fact?.kind)) problems.push(`kind(${fact?.kind})`);
		if (typeof fact?.text !== 'string' || fact.text.length === 0) problems.push('text');
		if (!Array.isArray(fact?.tags) || fact.tags.some((t) => typeof t !== 'string')) problems.push('tags');
		if (typeof fact?.sessionId !== 'string' || fact.sessionId.length === 0) problems.push('sessionId');
		if (!Number.isInteger(fact?.seq) || fact.seq < 0) problems.push('seq');
		if (!Number.isInteger(fact?.createdAt) || fact.createdAt < 0) problems.push('createdAt');
		if (!Number.isInteger(fact?.updatedAt) || fact.updatedAt < 0) problems.push('updatedAt');
		if (fact?.state !== 'active' && fact?.state !== 'archived') problems.push(`state(${fact?.state})`);
		if (problems.length > 0) {
			throw new MemoryError('MEMORY_UNAVAILABLE', `refusing to write: fact ${id} fails the DSH FactSchema (${problems.join(', ')})`);
		}
	}
}

// ------------------------------------------------------------- operations

const activeIn = (doc, ws) =>
	Object.values(doc.tables.facts).filter((fact) => fact.workspacePath === ws && fact.state === 'active');

export function listActive(ws, file = memoryFile()) {
	return activeIn(readDoc(file), ws).sort(compareRecency);
}

/** Workspace profile (the always-injected notes block). Same shape and caps as
 *  dsh-native-memory's ProfileSchema / config so DSH and the MCP clients see one
 *  profile. Stored in the SAME doc, under doc.tables.profiles[workspacePath]. */
export const PROFILE = { maxEntries: 8, maxEntryChars: 240 };

export function readProfile({ ws = workspacePath(), file = memoryFile() } = {}) {
	const doc = readDoc(file);
	const stored = doc.tables.profiles?.[ws];
	if (stored && Array.isArray(stored.entries)) {
		return {
			workspacePath: ws,
			entries: stored.entries.filter((entry) => typeof entry === 'string' && entry.trim().length > 0),
			updatedAt: Number.isInteger(stored.updatedAt) ? stored.updatedAt : 0
		};
	}
	return { workspacePath: ws, entries: [], updatedAt: 0 };
}

/** Replace the whole profile entry list (memory_remember target:"profile").
 *  Enforces the same caps DSH's putProfile does and journals before/after so
 *  memory_undo can roll a profile back. */
export async function writeProfile(entries, { ws = workspacePath(), file = memoryFile() } = {}) {
	const kept = (entries ?? []).filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
	if (kept.length > PROFILE.maxEntries) {
		throw new MemoryError('MEMORY_CAP_EXCEEDED', `workspace profile would hold ${kept.length} entries, over the cap of ${PROFILE.maxEntries}; consolidate entries (replace one at its profile_index, or drop it with empty text)`);
	}
	for (const entry of kept) {
		if ([...entry].length > PROFILE.maxEntryChars) {
			throw new MemoryError('MEMORY_CAP_EXCEEDED', `a profile entry is ${[...entry].length} characters, over the cap of ${PROFILE.maxEntryChars}; shorten it`);
		}
		const violation = privacyViolation(entry);
		if (violation) {
			throw new MemoryError('MEMORY_PRIVACY_REJECTED', `memory_remember: profile entry rejected by the privacy filter (looks like ${violation}); TITAN does not store credentials or identity numbers`);
		}
	}
	return withLock(file, () => {
		const doc = readDoc(file);
		const before = doc.tables.profiles?.[ws] ?? null;
		const now = Date.now();
		doc.tables.profiles = doc.tables.profiles ?? {};
		doc.tables.profiles[ws] = { workspacePath: ws, entries: kept, updatedAt: now };
		writeDoc(file, doc);
		appendJournal({ id: `profile:${ws}`, action: 'profile', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: now, before, after: doc.tables.profiles[ws] }, journalFile(file));
		return doc.tables.profiles[ws];
	});
}

/** memory_remember {target:"profile"}: append (no profile_index), replace one
 *  entry (profile_index), or drop it (empty text). Mirrors DSH's behaviour so
 *  both sides maintain the same always-injected block. */
function rememberProfile(args, { ws, file }) {
	const text = typeof args.text === 'string' ? args.text : '';
	const profile = readProfile({ ws, file });
	const entries = [...profile.entries];
	const index = Number.isInteger(args.profile_index) ? args.profile_index : entries.length;
	if (index < 0 || index > entries.length) {
		throw new MemoryError('MEMORY_INVALID_ARGS', `memory_remember: profile_index ${index} is beyond the ${entries.length} profile entries`);
	}
	if (text.trim().length === 0) {
		if (index === entries.length) {
			throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_remember: no profile entry at the append position to drop');
		}
		entries.splice(index, 1);
	} else {
		entries[index] = text.trim();
	}
	return writeProfile(entries, { ws, file }).then((next) => ({ kind: 'profile', workspacePath: next.workspacePath, entries: next.entries, updatedAt: next.updatedAt }));
}

/** harness-parity memory_edit: replace text / kind / tags of one existing fact.
 *  At least one field must be supplied; omitted fields keep their value. */
export function editFact(args, { ws = workspacePath(), file = memoryFile() } = {}) {
	const id = String(args.id ?? '').trim();
	if (id.length === 0) {
		throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_edit: id must not be empty');
	}
	if (args.text === undefined && args.kind === undefined && args.tags === undefined) {
		throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_edit: provide at least one of text, kind, or tags');
	}
	if (args.kind !== undefined && !KINDS.includes(args.kind)) {
		throw new MemoryError('MEMORY_INVALID_ARGS', `memory_edit: kind must be one of ${KINDS.join('|')}`);
	}
	if (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.some((tag) => typeof tag !== 'string'))) {
		throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_edit: tags must be an array of strings');
	}
	if (args.text !== undefined && typeof args.text !== 'string') {
		throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_edit: text must be a string');
	}
	if (args.text !== undefined) {
		const violation = privacyViolation(args.text);
		if (violation) {
			throw new MemoryError('MEMORY_PRIVACY_REJECTED', `memory_edit: rejected by the privacy filter (looks like ${violation}); TITAN does not store credentials or identity numbers`);
		}
		if ([...args.text].length > CONFIG.maxFactChars) {
			throw new MemoryError('MEMORY_CAP_EXCEEDED', `fact text is ${[...args.text].length} characters, over the cap of ${CONFIG.maxFactChars}; shorten it`);
		}
	}
	if (args.tags !== undefined && args.tags.length > 0) {
		const tagViolation = privacyViolation(args.tags.join(' '));
		if (tagViolation) {
			throw new MemoryError('MEMORY_PRIVACY_REJECTED', `memory_edit: tag rejected by the privacy filter (looks like ${tagViolation}); TITAN does not store credentials or identity numbers`);
		}
	}
	return withLock(file, () => {
		const doc = readDoc(file);
		const existing = doc.tables.facts[id];
		if (existing === undefined || existing.workspacePath !== ws) {
			throw new MemoryError('MEMORY_NOT_FOUND', `memory_edit: no fact '${id}' in this workspace`);
		}
		const now = Date.now();
		const seq = doc.tables.facts && Object.values(doc.tables.facts)
			.reduce((max, f) => Math.max(max, Number.isInteger(f.seq) ? f.seq : 0), 0);
		const next = {
			...existing,
			text: args.text ?? existing.text,
			kind: args.kind ?? existing.kind,
			tags: args.tags ?? existing.tags,
			sessionId: originSession(),
			seq: seq + 1,
			updatedAt: now
		};
		doc.tables.facts[id] = next;
		writeDoc(file, doc);
		appendJournal({ id, action: 'update', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: now, before: existing, after: next }, journalFile(file));
		return next;
	});
}

export async function remember(args, { ws = workspacePath(), file = memoryFile(), provenance = null } = {}) {
	if (args.target === 'profile') return rememberProfile(args, { ws, file });
	const text = args.text;
	if (typeof text !== 'string' || text.trim().length === 0) {
		throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_remember: fact text must not be empty');
	}
	const kind = args.kind ?? 'fact';
	if (!KINDS.includes(kind)) {
		throw new MemoryError('MEMORY_INVALID_ARGS', `memory_remember: kind must be one of ${KINDS.join('|')}`);
	}
	const tags = args.tags ?? [];
	if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
		throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_remember: tags must be an array of strings');
	}
	const violation = privacyViolation(text);
	if (violation) {
		throw new MemoryError('MEMORY_PRIVACY_REJECTED', `memory_remember: rejected by the privacy filter (looks like ${violation}); TITAN does not store credentials or identity numbers`);
	}
	const tagViolation = tags.length > 0 ? privacyViolation(tags.join(' ')) : null;
	if (tagViolation) {
		throw new MemoryError('MEMORY_PRIVACY_REJECTED', `memory_remember: tag rejected by the privacy filter (looks like ${tagViolation}); TITAN does not store credentials or identity numbers`);
	}
	if ([...text].length > CONFIG.maxFactChars) {
		throw new MemoryError('MEMORY_CAP_EXCEEDED', `fact text is ${[...text].length} characters, over the cap of ${CONFIG.maxFactChars}; split the fact or consolidate with memory_consolidate`);
	}

	return withLock(file, () => {
		const doc = readDoc(file);
		const now = Date.now();
		const active = activeIn(doc, ws);
		let fact;
		let beforeFact = null;

		if (args.id !== undefined) {
			const existing = doc.tables.facts[args.id];
			if (existing === undefined || existing.workspacePath !== ws) {
				throw new MemoryError('MEMORY_NOT_FOUND', `memory_remember: no fact '${args.id}' in this workspace`);
			}
			beforeFact = existing;
			fact = { ...existing, kind, text, tags, updatedAt: now, state: 'active' };
		} else {
			const occupied = active.filter((f) => f.id !== undefined).length;
			if (occupied >= CONFIG.maxFactsPerWorkspace) {
				throw new MemoryError('MEMORY_CAP_EXCEEDED', `workspace already holds ${CONFIG.maxFactsPerWorkspace} active facts (the cap); run memory_consolidate and drop stale ones first`);
			}
			const seq = doc.tables.facts && Object.values(doc.tables.facts)
				.reduce((max, f) => Math.max(max, Number.isInteger(f.seq) ? f.seq : 0), 0);
			fact = {
				id: crypto.randomUUID(),
				workspacePath: ws,
				kind,
				text,
				tags,
				sessionId: provenance?.sessionId ?? originSession(),
				seq: Number.isInteger(provenance?.seq) ? provenance.seq : seq + 1,
				createdAt: now,
				updatedAt: now,
				state: 'active'
			};
		}

		doc.tables.facts[fact.id] = fact;
		writeDoc(file, doc);
		appendJournal({
			id: fact.id,
			action: beforeFact ? 'update' : 'create',
			ws,
			actor: process.env.TITAN_CLIENT || 'titan',
			ts: now,
			before: beforeFact,
			after: fact
		}, journalFile(file));
		return fact;
	});
}

export function recall({ query, limit = 20 }, { ws = workspacePath(), file = memoryFile() } = {}) {
	const bounded = Math.max(1, Math.min(50, Math.trunc(limit) || 20));
	const active = activeIn(readDoc(file), ws);
	if (query === undefined || query === null || String(query).trim().length === 0) {
		return active.sort(compareRecency).slice(0, bounded);
	}
	const tokens = tokenize(String(query));
	if (tokens.length === 0) return active.sort(compareRecency).slice(0, bounded);
	const folded = String(query).trim().toLowerCase();
	const phraseBoost = /\s/.test(String(query).trim());
	return active
		.map((fact) => ({ fact, score: scoreFact(fact, tokens, folded, phraseBoost) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || compareRecency(left.fact, right.fact))
		.slice(0, bounded)
		.map((entry) => entry.fact);
}

export function consolidate({ ws = workspacePath(), file = memoryFile() } = {}) {
	const facts = listActive(ws, file);
	const budget = CONFIG.maxFactsPerWorkspace - facts.length;
	const header = `${facts.length} active facts; budget remaining: ${Math.max(0, budget)} of ${CONFIG.maxFactsPerWorkspace}`;
	const candidates = suggestConsolidations(facts);
	if (candidates.length === 0) return `${header}\nno consolidation candidates — the active facts look distinct`;
	const lines = candidates.map((candidate, index) =>
		`${index + 1}. ${candidate.a.id} + ${candidate.b.id} (${Math.round(candidate.similarity * 100)}%): ${truncate(candidate.suggestedText, 300)}`);
	return `${header}\n\nMerge candidates (near-duplicate text):\n${lines.join('\n')}\n\nApply with memory_consolidate {"apply": true} (archives the older member of each pair, pinned facts are skipped, everything is undoable via memory_undo), or memory_remember to rewrite one by hand.`;
}

/** Archive the older member of each near-duplicate pair. Pinned facts are
 *  never archived. Archives are reversible via memory_undo (journaled). */
export function applyConsolidations({ ws = workspacePath(), file = memoryFile() } = {}) {
	return withLock(file, () => {
		const doc = readDoc(file);
		const active = Object.values(doc.tables.facts)
			.filter((fact) => fact.workspacePath === ws && fact.state === 'active')
			.sort(compareRecency);
		const pins = readPins(file);
		const candidates = suggestConsolidations(active);
		const archived = [];
		const pinnedSkipped = [];
		for (const candidate of candidates) {
			const loser = candidate.a.updatedAt <= candidate.b.updatedAt ? candidate.a : candidate.b;
			if (pins.has(loser.id)) {
				pinnedSkipped.push(loser.id);
				continue;
			}
			const current = doc.tables.facts[loser.id];
			if (!current || current.state !== 'active') continue;
			const archivedFact = { ...current, state: 'archived', updatedAt: Date.now() };
			doc.tables.facts[loser.id] = archivedFact;
			archived.push({ id: loser.id, kept: (loser === candidate.a ? candidate.b : candidate.a).id });
			appendJournal({
				id: loser.id, action: 'archive', ws, actor: process.env.TITAN_CLIENT || 'titan',
				ts: archivedFact.updatedAt, before: current, after: archivedFact
			}, journalFile(file));
		}
		if (archived.length > 0) writeDoc(file, doc);
		return { candidates: candidates.length, archived, pinnedSkipped };
	});
}

/** Pin a fact: consolidation and forget refuse to touch it. Pins live in a
 *  sidecar file because DSH's zod FactSchema strips unknown keys. */
export function pinFact(id, { ws = workspacePath(), file = memoryFile() } = {}) {
	const doc = readDoc(file);
	const fact = doc.tables.facts[id];
	if (!fact || fact.workspacePath !== ws) {
		throw new MemoryError('MEMORY_NOT_FOUND', `memory_pin: no fact '${id}' in this workspace`);
	}
	return withLock(file, () => {
		const pins = readPins(file);
		if (pins.has(id)) return { id, pinned: true, already: true };
		pins.add(id);
		writePins(pins, file);
		appendJournal({ id, action: 'pin', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: Date.now(), before: null, after: null }, journalFile(file));
		return { id, pinned: true, already: false };
	});
}

export function unpinFact(id, { ws = workspacePath(), file = memoryFile() } = {}) {
	const doc = readDoc(file);
	const fact = doc.tables.facts[id];
	if (!fact || fact.workspacePath !== ws) {
		throw new MemoryError('MEMORY_NOT_FOUND', `memory_unpin: no fact '${id}' in this workspace`);
	}
	return withLock(file, () => {
		const pins = readPins(file);
		if (!pins.has(id)) return { id, pinned: false, already: true };
		pins.delete(id);
		writePins(pins, file);
		appendJournal({ id, action: 'unpin', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: Date.now(), before: null, after: null }, journalFile(file));
		return { id, pinned: false, already: false };
	});
}

function candidateBackups(file) {
	const dir = path.dirname(file);
	const base = path.basename(file);
	const found = [];
	for (const name of fs.readdirSync(dir)) {
		if (name === base || name.startsWith(`${base}.bak`)) found.push(path.join(dir, name));
	}
	return found;
}

/** Physically remove the fact from the store and from every \*.bak backup
 *  next to it, then redact journal entries that carry its content. */
export function forgetFact(id, { ws = workspacePath(), file = memoryFile(), confirm = false } = {}) {
	return withLock(file, () => {
		const doc = readDoc(file);
		const fact = doc.tables.facts[id];
		if (!fact || fact.workspacePath !== ws) {
			throw new MemoryError('MEMORY_NOT_FOUND', `memory_forget: no fact '${id}' in this workspace`);
		}
		const pins = readPins(file);
		if (pins.has(id)) {
			throw new MemoryError('MEMORY_PINNED', 'memory_forget: fact is pinned; unpin it first (memory_unpin)');
		}
		const backups = candidateBackups(file);
		if (!confirm) {
			return {
				dryRun: true,
				id,
				kept: `fact ${id} [${fact.kind}, src ${fact.sessionId}#${fact.seq}, updated ${iso(fact.updatedAt)}]: ${truncate(fact.text, 140)}`,
				purges: `store + ${backups.length} backup file(s) + journal redaction; NOT undoable`
			};
		}
		delete doc.tables.facts[id];
		writeDoc(file, doc);
		const purged = [];
		for (const backup of backups) {
			let parsed;
			try { parsed = JSON.parse(fs.readFileSync(backup, 'utf8')); } catch { continue; }
			if (parsed?.tables?.facts?.[id]) {
				delete parsed.tables.facts[id];
				fs.writeFileSync(backup, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
				purged.push(backup);
			}
		}
		redactJournal(file, id);
		appendJournal({ id, action: 'forget', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: Date.now(), before: null, after: null }, journalFile(file));
		return { dryRun: false, id, purgedBackups: purged };
	});
}

/** Replace every journal entry mentioning <id> with a content-free marker. */
function redactJournal(file, id) {
	const journal = journalFile(file);
	let raw;
	try { raw = fs.readFileSync(journal, 'utf8'); } catch { return 0; }
	const lines = raw.split(/\r?\n/);
	let touched = 0;
	const out = [];
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { out.push(line); continue; }
		if (entry && entry.id === id && (entry.before || entry.after)) {
			entry.before = entry.before ? { ...entry.before, text: '[redacted by memory_forget]', tags: [] } : null;
			entry.after = entry.after ? { ...entry.after, text: '[redacted by memory_forget]', tags: [] } : null;
			touched += 1;
			out.push(JSON.stringify(entry));
		} else {
			out.push(line);
		}
	}
	const tmp = `${journal}.titan.tmp`;
	fs.writeFileSync(tmp, `${out.join('\n')}\n`, 'utf8');
	fs.renameSync(tmp, journal);
	return touched;
}

/** Revive an archived fact. Hard-deleted facts cannot be restored. */
export function restoreFact(id, { ws = workspacePath(), file = memoryFile() } = {}) {
	return withLock(file, () => {
		const doc = readDoc(file);
		const fact = doc.tables.facts[id];
		if (!fact || fact.workspacePath !== ws) {
			throw new MemoryError('MEMORY_NOT_FOUND', `memory_restore: no fact '${id}' in this workspace (hard-deleted facts cannot be restored)`);
		}
		if (fact.state === 'active') return { id, state: 'active', already: true };
		const restored = { ...fact, state: 'active', updatedAt: Date.now() };
		doc.tables.facts[id] = restored;
		writeDoc(file, doc);
		appendJournal({ id, action: 'restore', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: restored.updatedAt, before: fact, after: restored }, journalFile(file));
		return { id, state: 'active', already: false };
	});
}

/** Undo the most recent un-undone titan-journal write for this workspace. */
export function undoLast({ ws = workspacePath(), file = memoryFile() } = {}) {
	return withLock(file, () => {
		const entries = readJournal(journalFile(file));
		const undoneIndexes = new Set(entries.filter((entry) => entry.action === 'undo' && Number.isInteger(entry.undone)).map((entry) => entry.undone));
		let targetIndex = -1;
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry.ws !== ws) continue;
			if (entry.action === 'undo') continue;
			if (undoneIndexes.has(i)) continue;
			targetIndex = i;
			break;
		}
		if (targetIndex === -1) {
			return { undone: null, reason: 'nothing to undo (no titan-journal entries for this workspace)' };
		}
		const entry = entries[targetIndex];
		const doc = readDoc(file);
		if (entry.action === 'create' || entry.action === 'pin' || entry.action === 'unpin') {
			if (entry.action === 'create') {
				if (doc.tables.facts[entry.id]) {
					delete doc.tables.facts[entry.id];
					writeDoc(file, doc);
					appendJournal({ id: entry.id, action: 'undo', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: Date.now(), undone: targetIndex, before: entry.after, after: null }, journalFile(file));
					return { undone: { action: entry.action, id: entry.id } };
				}
				return { undone: { action: entry.action, id: entry.id }, reason: 'fact already gone' };
			}
			// unpin of a pin / pin of a pin — flip the pin state back
			const pins = readPins(file);
			if (entry.action === 'pin') pins.delete(entry.id); else pins.add(entry.id);
			writePins(pins, file);
			appendJournal({ id: entry.id, action: 'undo', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: Date.now(), undone: targetIndex, before: null, after: null }, journalFile(file));
			return { undone: { action: entry.action, id: entry.id } };
		}
		if (entry.action === 'forget') {
			return { undone: null, reason: 'memory_forget purges content; there is nothing to undo' };
		}
		// update / archive / restore — exact before-image restore
		if (entry.before) {
			doc.tables.facts[entry.id] = entry.before;
			writeDoc(file, doc);
			appendJournal({ id: entry.id, action: 'undo', ws, actor: process.env.TITAN_CLIENT || 'titan', ts: Date.now(), undone: targetIndex, before: entry.after, after: entry.before }, journalFile(file));
			return { undone: { action: entry.action, id: entry.id } };
		}
		return { undone: null, reason: 'no before-image in journal entry; cannot undo' };
	});
}

/** Human-readable provenance + lifecycle for one fact. */
export function explainFact(id, { ws = workspacePath(), file = memoryFile() } = {}) {
	const doc = readDoc(file);
	const fact = doc.tables.facts[id];
	if (!fact || fact.workspacePath !== ws) {
		throw new MemoryError('MEMORY_NOT_FOUND', `memory_explain: no fact '${id}' in this workspace`);
	}
	const pins = readPins(file);
	const backups = candidateBackups(file).length;
	return {
		id: fact.id,
		kind: fact.kind,
		state: fact.state,
		pinned: pins.has(id),
		wrapped: truncate(fact.text, 400),
		tags: fact.tags,
		provenance: { sessionId: fact.sessionId, seq: fact.seq, createdAt: iso(fact.createdAt), updatedAt: iso(fact.updatedAt) },
		backupCopies: backups
	};
}

/** memory_import 等价版：把耐久 session 日志里看似值得记住的行导入为 fact。
 *
 * 不依赖 DSH 的 session-query FTS 句柄：扫描本工作区的 zstd session 日志
 *（复用 search.mjs listWorkspaceSessions/loadSession），抽取候选（复用
 * candidates.mjs extractCandidates，已做隐私过滤、已知去重、评分排序），
 * 再逐条通过 remember() 写入共享 fact 表，provenance 带 sessionId#seq/time/role。
 *
 * 默认 dry-run：只预览不写入。传 confirm:true 才真写入。写入前走 remember 的
 * 隐私过滤 + 2000 字符上限 + 300 条容量检查；每条写入都进 titan-journal，
 * 可 memory_undo 回退。导入的 fact 打 tags ['candidate','imported']，便于日后
 * 通过 memory_recall query='imported' 或 tag 过滤出来。
 *
 * 为避免与 candidates.mjs 的顶层 import 形成循环依赖（candidates.mjs 已 import
 * 本模块），extractCandidates 在函数内动态 import。 */
export async function importFacts(
	{ sessionId, limit = 10, confirm = false, query } = {},
	{ ws = workspacePath(), file = memoryFile(), now = Date.now() } = {}
) {
	const wanted = Math.max(1, Math.min(100, Math.trunc(limit) || 10));
	// 多扫几个 session，以便按 sessionId 定位较旧的会话；extractCandidates 会按分数排序。
	const { extractCandidates } = await import('./candidates.mjs');
	const result = extractCandidates(
		{ limit: wanted * 3, sessions: 40, query },
		{ ws, file, now }
	);
	let candidates = result.candidates;
	if (sessionId) {
		candidates = candidates.filter((c) => c.sessionId === sessionId);
	}
	candidates = candidates.slice(0, wanted);

	const activeBefore = listActive(ws, file).length;

	if (!confirm) {
		return {
			dryRun: true,
			confirm: false,
			wouldImport: candidates.length,
			scannedSessions: result.scannedSessions,
			scannedMessages: result.scannedMessages,
			skippedPrivacy: result.skippedPrivacy,
			skippedKnown: result.skippedKnown,
			preview: candidates.map((c) => ({
				id: c.id,
				text: c.text,
				kind: c.kind,
				tags: c.tags,
				src: `${c.sessionId}#${c.seq ?? '?'}`,
				role: c.role,
				score: c.score,
				time: c.time
			}))
		};
	}

	const imported = [];
	const skipped = [];
	for (const candidate of candidates) {
		try {
			const fact = await remember(
				{
					text: candidate.text,
					kind: candidate.kind,
					tags: [...new Set([...(candidate.tags ?? []), 'candidate', 'imported'])],
					provenance: {
						sessionId: candidate.sessionId,
						seq: Number.isInteger(candidate.seq) ? candidate.seq : undefined
					}
				},
				{ ws, file }
			);
			imported.push({
				id: fact.id,
				text: fact.text,
				kind: fact.kind,
				src: `${candidate.sessionId}#${candidate.seq ?? '?'}`
			});
		} catch (error) {
			skipped.push({ text: candidate.text, reason: error.code ?? String(error) });
			if (error && error.code === 'MEMORY_CAP_EXCEEDED') {
				break;
			}
		}
	}

	return {
		dryRun: false,
		confirm: true,
		imported: imported.length,
		skipped: skipped.length,
		activeBefore,
		activeAfter: listActive(ws, file).length,
		items: imported,
		skippedDetail: skipped
	};
}
