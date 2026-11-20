// Cross-session full-text scan for the shared TITAN memory MCP server.
//
// Harness's own memory_search goes through dsh's session-query FTS service
// (a 200MB sqlite we have no handle on). This is the standalone equivalent:
// scan the durable session logs directly.
//
// Log layout:  ~/.dsh/sessions/<encoded-workspace>/session-<uuid>/session.v3.jsonl.zstd
// The file is a CONCATENATION of thousands of independent zstd frames (one per
// append), and neither zstdDecompressSync nor the streaming decoder walks past
// the first frame — so we locate frame boundaries by magic and decode each one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { normalizeWorkspacePath } from './store.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = 'session.v3.jsonl.zstd';

/** How many sessions to scan, newest first, before giving up. */
const MAX_SESSIONS = 40;
/** Hard wall-clock budget so a tool call can never hang the client. */
const TIME_BUDGET_MS = 20_000;
const SNIPPET_CHARS = 400;

export function sessionsRoot() {
	return process.env.TITAN_SESSIONS_DIR || path.join(os.homedir(), '.dsh', 'sessions');
}

/** dsh encodes a workspace path as `--D-FOO--`: strip the drive colon, turn
 *  path separators into `-`, wrap in `--`. Verified against
 *  `--D-TITAN_ARCHAEOLOGY--`, `--D-V8--`, `--E-TITAN_RESEARCH--`. */
export function encodeWorkspace(ws) {
	const trimmed = String(ws).replace(/[\\/]+$/, '');
	return `--${trimmed.replace(/:/g, '').replace(/[\\/]/g, '-')}--`;
}

function frameOffsets(buf) {
	const offsets = [];
	let i = 0;
	while (i <= buf.length - 4) {
		if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
			offsets.push(i);
			i += 4;
		} else {
			i += 1;
		}
	}
	return offsets;
}

/** Decode a session file's zstd frames. Node >= 22 decodes concatenated
 *  frames in one call; the per-frame fallback only runs for older runtimes or
 *  a corrupt tail. maxOutputLength guards a bogus frame header. */
function decodeFrames(buf) {
	try {
		const text = zlib.zstdDecompressSync(buf, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8');
		if (text.length > 0) return [text];
	} catch { /* fall through to frame walking */ }
	const texts = [];
	for (const offset of frameOffsets(buf)) {
		try {
			const text = zlib.zstdDecompressSync(buf.subarray(offset), { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8');
			if (text.startsWith('{') || text.startsWith('[')) texts.push(text);
		} catch { /* not a frame start */ }
	}
	return texts;
}

function textBlocks(content) {
	if (!Array.isArray(content)) return [];
	return content
		.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text);
}

/** Decode one session file into ordered conversation messages. Only text blocks
 *  are kept (tool calls/results are not memory candidates). */
export function loadSession(file) {
	let decoded;
	try { decoded = decodeFrames(fs.readFileSync(file)); } catch { return null; }
	if (decoded.length === 0) return null;
	let header;
	try { header = JSON.parse(decoded[0].split('\n')[0]); } catch { header = {}; }
	const sessionId = header.id ?? path.basename(path.dirname(file));
	const messages = [];
	for (const frame of decoded) {
		for (const line of frame.split('\n')) {
			if (!line.startsWith('{')) continue;
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			let role;
			let blocks;
			if (event.type === 'user/message') { role = 'user'; blocks = textBlocks(event.data?.content); }
			else if (event.type === 'assistant/message') { role = 'assistant'; blocks = textBlocks(event.data?.message?.content); }
			else continue;
			const text = blocks.join('\n').trim();
			if (text.length === 0) continue;
			messages.push({ seq: event.seq, time: event.time, role, text });
		}
	}
	return { sessionId, file, messages };
}

/** Layout is two levels deep: <root>/<workspace>/<session-id>/<file>. */
function sessionFilesUnder(wsDir) {
	let subdirs;
	try {
		subdirs = fs.readdirSync(wsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	} catch { return []; }
	const files = [];
	for (const sub of subdirs) {
		const file = path.join(wsDir, sub.name, SESSION_FILE);
		if (fs.existsSync(file)) files.push(file);
	}
	return files;
}

/** All session files for this workspace, newest first.
 *  Name encoding is the fast path; the header `cwd` is the authority and we
 *  fall back to decoding headers when the fast path misses. */
export function listWorkspaceSessions(ws, root = sessionsRoot()) {
	if (!fs.existsSync(root)) return [];
	const workspace = normalizeWorkspacePath(ws);
	const wanted = encodeWorkspace(workspace);
	const dirs = fs.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(root, entry.name));

	const fast = dirs.filter((dir) => path.basename(dir) === wanted);
	const pool = fast.length > 0 ? fast : dirs;

	const candidates = [];
	for (const dir of pool) {
		for (const file of sessionFilesUnder(dir)) {
			if (fast.length === 0) {
				// No name match: confirm by reading the session header's cwd.
				try {
					const header = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
					if (normalizeWorkspacePath(JSON.parse(header.split('\n')[0]).cwd) !== workspace) continue;
				} catch { continue; }
			}
			let stat;
			try { stat = fs.statSync(file); } catch { continue; }
			if (stat.size === 0) continue;
			candidates.push({ file, mtime: stat.mtimeMs, size: stat.size });
		}
	}

	return candidates.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file);
}

/** Collect the human-readable strings of a decoded event so the query can be
 *  located without depending on one particular event schema. */
function stringValues(value, out = [], depth = 0) {
	if (depth > 8 || out.length > 500) return out;
	if (typeof value === 'string') { out.push(value); return out; }
	if (Array.isArray(value)) { for (const item of value) stringValues(item, out, depth + 1); }
	else if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) stringValues(item, out, depth + 1); }
	return out;
}

function excerptFor(line, query, folded) {
	let haystack = line;
	try { haystack = stringValues(JSON.parse(line)).join('  '); }
	catch { /* raw line already holds the text */ }
	const at = haystack.toLowerCase().indexOf(folded);
	if (at < 0) return null;
	const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
	const end = Math.min(haystack.length, at + query.length + SNIPPET_CHARS);
	let snippet = haystack.slice(start, end).replace(/\s+/g, ' ').trim();
	if (start > 0) snippet = `…${snippet}`;
	if (end < haystack.length) snippet = `${snippet}…`;
	return snippet.slice(0, SNIPPET_CHARS);
}

/**
 * Deterministic literal scan over past sessions of this workspace, newest
 * session first, first matching event per session, stopping once `limit`
 * sessions have matched or the budget runs out.
 */
export function searchSessions({ query, limit = 5 }, { ws, now = Date.now() } = {}) {
	const q = String(query).trim();
	if (q.length === 0) throw new Error('memory_search: query must not be empty');
	const folded = q.toLowerCase();
	const wanted = Math.max(1, Math.min(20, Math.trunc(limit) || 5));
	const deadline = now + TIME_BUDGET_MS;

	const files = listWorkspaceSessions(ws).slice(0, MAX_SESSIONS);
	if (files.length === 0) return { hits: [], scanned: 0, note: 'no session logs found for this workspace' };

	const hits = [];
	let scanned = 0;
	let truncated = false;

	for (const file of files) {
		if (Date.now() > deadline) { truncated = true; break; }
		scanned += 1;
		let sessionId;
		let frames;
		try {
			const buf = fs.readFileSync(file);
			const decoded = decodeFrames(buf);
			if (decoded.length === 0) continue;
			const header = JSON.parse(decoded[0].split('\n')[0]);
			sessionId = header.id ?? path.basename(path.dirname(file));
			frames = decoded;
		} catch { continue; }

		let eventTime;
		let snippet;
		for (const frame of frames) {
			for (const line of frame.split('\n')) {
				if (line.length === 0 || line.toLowerCase().indexOf(folded) < 0) continue;
				const found = excerptFor(line, q, folded);
				if (found === null) continue;
				snippet = found;
				try { eventTime = JSON.parse(line).time; } catch { eventTime = undefined; }
				break;
			}
			if (snippet !== undefined) break;
		}
		if (snippet === undefined) continue;

		hits.push({
			sessionId,
			createdAt: eventTime,
			snippet
		});
		if (hits.length >= wanted) break;
	}

	if (hits.length === 0) {
		return { hits, scanned, note: truncated ? `no matches in the ${scanned} newest sessions (scan budget hit)` : `no prior-session matches for ${JSON.stringify(q)} in this workspace` };
	}
	return { hits, scanned, truncated };
}
