// Core memory + long-tail notes for TITAN (dsh-core-memory style, zero-dep).
//
// Coexists with the dsh-native-memory store (store.mjs / dsh_memory.json): that
// file stays the DSH-owned fact table; this module manages plain markdown files
// that are git-versionable and human-readable:
//
//   <ws>/titan-memory/core/CORE.md      — core memory snapshot (<= 3000 chars,
//                                         resident per round; constant cost)
//   <ws>/titan-memory/core/notes/*.md   — long-tail facts, retrieved on demand
//
// Retrieval is scored locally, keyword-based (tags first, then substring),
// no network requests. Trade-off is stated on purpose: keyword retrieval is not
// semantic retrieval — a paraphrase may miss. That is accepted (dsh-core-memory
// design decision).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG = {
	maxCoreChars: 3000,
	notesDir: 'notes',
	coreFile: 'CORE.md',
	maxNoteChars: 8000
};

export function coreRoot() {
	// Tests point this at a scratch directory. Without the override the core
	// tests would rewrite the REAL CORE.md that every client auto-loads (T-293:
	// a selftest write was visible to the whole session mid-run).
	if (process.env.TITAN_CORE_DIR) return process.env.TITAN_CORE_DIR.split('/').join('\\');
	const ws = (process.env.TITAN_WORKSPACE || process.cwd()).split('/').join('\\');
	return path.join(ws, 'titan-memory', 'core');
}

export function coreFilePath() {
	return path.join(coreRoot(), CONFIG.coreFile);
}

export function notesDirPath() {
	return path.join(coreRoot(), CONFIG.notesDir);
}

function ensureDirs() {
	fs.mkdirSync(notesDirPath(), { recursive: true });
}

/** A note id derived from the file name (stable across sessions). */
function noteIdFrom(file) {
	return path.basename(file, '.md');
}

/** Escape a text fragment for use inside a fenced code block. */
function fence(text) {
	return text.replace(/```/g, '\\`\\`\\`');
}

// ------------------------------------------------------------- core memory

export function readCore(file = coreFilePath()) {
	try {
		const raw = fs.readFileSync(file, 'utf8');
		return { text: raw, exists: true, bytes: Buffer.byteLength(raw) };
	} catch {
		return { text: '', exists: false, bytes: 0 };
	}
}

export function writeCore(text, file = coreFilePath()) {
	const length = [...text].length;
	if (length > CONFIG.maxCoreChars) {
		throw new Error(`CORE.md is ${length} characters, over the cap of ${CONFIG.maxCoreChars}; overflow long-tail facts to notes/`);
	}
	ensureDirs();
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, text, 'utf8');
	fs.renameSync(tmp, file);
	return { bytes: Buffer.byteLength(text), chars: length };
}

// ------------------------------------------------------------- long-tail notes

export function listNotes(dir = notesDirPath()) {
	ensureDirs();
	return fs.readdirSync(dir)
		.filter((name) => name.endsWith('.md'))
		.map((name) => ({
			id: noteIdFrom(name),
			file: path.join(dir, name)
		}));
}

export function readNote(id, dir = notesDirPath()) {
	const safe = path.basename(String(id).replace(/\.md$/i, '')) + '.md';
	const file = path.join(dir, safe);
	try {
		return { id: noteIdFrom(file), text: fs.readFileSync(file, 'utf8'), exists: true };
	} catch {
		return { id: noteIdFrom(file), text: '', exists: false };
	}
}

export function writeNote(id, text, dir = notesDirPath()) {
	const length = [...text].length;
	if (length > CONFIG.maxNoteChars) {
		throw new Error(`note ${id} is ${length} characters, over the cap of ${CONFIG.maxNoteChars}`);
	}
	ensureDirs();
	const safe = path.basename(String(id).replace(/\.md$/i, '')) + '.md';
	if (!/^[A-Za-z0-9._-]+$/.test(safe.replace(/\.md$/, ''))) {
		throw new Error(`note id must be [A-Za-z0-9._-], got ${JSON.stringify(id)}`);
	}
	const file = path.join(dir, safe);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, text, 'utf8');
	fs.renameSync(tmp, file);
	return { id: noteIdFrom(file), bytes: Buffer.byteLength(text) };
}

// --------------------------------------------------------------- retrieval

function tokenize(query) {
	const tokens = new Set();
	for (const word of String(query).toLowerCase().split(/\s+/)) {
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

/** Score a markdown body: per-token substring hits; whole-phrase hits add a
 *  bonus. Headings count only as a tie-break on top of real token hits — a
 *  heading alone must never make an unrelated note a "hit". */
function scoreBody(body, tokens, phrase) {
	const lower = body.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		const count = lower.split(token).length - 1;
		if (count > 0) score += 2 + Math.min(2, count);
	}
	if (score === 0) return 0;
	if (phrase.length > 1 && lower.includes(phrase.toLowerCase())) score += 4;
	const headingBonus = (lower.match(/^#{1,3} .*$/gm) ?? []).length;
	if (headingBonus > 0) score += headingBonus;
	return score;
}

export function recallCore({ query, limit = 5 } = {}) {
	const core = readCore();
	if (!core.exists) return { source: 'CORE.md', hits: [], note: 'no CORE.md yet — write core memory with memory_core_remember' };
	const tokens = tokenize(query ?? '');
	if (tokens.length === 0) {
		return { source: 'CORE.md', hits: [{ id: 'CORE.md', file: coreFilePath(), score: 1, snippet: core.text.slice(0, 400) }], note: undefined };
	}
	const score = scoreBody(core.text, tokens, String(query ?? '').trim());
	if (score <= 0) return { source: 'CORE.md', hits: [], note: undefined };
	return { source: 'CORE.md', hits: [{ id: 'CORE.md', file: coreFilePath(), score, snippet: core.text.slice(0, 400) }], note: undefined };
}

export function recallNotes({ query, limit = 5 } = {}) {
	const bounded = Math.max(1, Math.min(20, Math.trunc(limit) || 5));
	const tokens = tokenize(query ?? '');
	const notes = listNotes();
	if (notes.length === 0) return { source: `notes/ (${notes.length} files)`, hits: [], note: 'no notes yet' };
	if (tokens.length === 0) {
		return {
			source: `notes/ (${notes.length} files)`,
			hits: notes.map((note) => ({
				id: note.id,
				file: note.file,
				score: 1,
				snippet: ''
			})).slice(0, bounded),
			note: undefined
		};
	}
	const phrase = String(query ?? '').trim();
	const hits = [];
	for (const note of notes) {
		const body = readNote(note.id).text;
		const score = scoreBody(body, tokens, phrase);
		if (score > 0) hits.push({ id: note.id, file: note.file, score, snippet: body.slice(0, 300) });
	}
	hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	return { source: `notes/ (${notes.length} files)`, hits: hits.slice(0, bounded), note: undefined };
}

export function rememberCore(text, file = coreFilePath()) {
	return writeCore(text, file);
}

export function rememberNote(id, text, dir = notesDirPath()) {
	return writeNote(id, text, dir);
}

export function renderHits(result) {
	if (result.hits.length === 0) {
		return result.note ?? `no hits in ${result.source}`;
	}
	const lines = result.hits.map((hit, index) => {
		const snippet = hit.snippet && hit.snippet.length > 0 ? `\n   ${hit.snippet.replace(/\n/g, '\n   ')}` : '';
		return `${index + 1}. ${hit.id} (score ${hit.score}, ${hit.file})${snippet}`;
	});
	return `${result.source}:\n${lines.join('\n')}`;
}

export { crypto as _crypto };