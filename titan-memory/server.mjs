#!/usr/bin/env node
// Zero-dependency MCP stdio server for the shared TITAN long-term memory.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
// transport). No SDK — @modelcontextprotocol/sdk is not installed on this box
// and M7 says install nothing we do not need. stdout carries ONLY protocol
// frames; every diagnostic goes to stderr.
//
// Tools:
//   memory_remember / memory_recall / memory_search / memory_consolidate
//   memory_core_recall / memory_core_remember / memory_coding_recall
//   memory_explain / memory_pin / memory_restore / memory_undo / memory_forget
//   memory_edit / memory_profile
// Harness keeps its own native eight-tool set; all three clients read and
// write the same ~/.dsh/storages/dsh_memory.json. TITAN-only extras are
// additive (sidecar pins file + journal) and never change DSH-owned shape.

import process from 'node:process';
import { remember, recall, consolidate, applyConsolidations, pinFact, unpinFact, forgetFact, restoreFact, undoLast, explainFact, readPins, editFact, readProfile, writeProfile, importFacts, MemoryError, workspacePath, memoryFile, factLine, iso } from './store.mjs';
import { searchSessions } from './search.mjs';
import { recallFresh } from './freshness.mjs';
import {
	recallCore,
	recallNotes,
	rememberCore,
	rememberNote,
	renderHits,
	coreFilePath,
	notesDirPath
} from './core-store.mjs';
import { recallCodingFact } from './chain-store.mjs';
import { extractCandidates, renderCandidates } from './candidates.mjs';

const SERVER_NAME = 'titan-memory';
const SERVER_VERSION = '1.2.0';
const SUPPORTED_PROTOCOL = '2025-06-18';

const log = (...args) => process.stderr.write(`${args.join(' ')}\n`);

const TEXT_OUTPUT = { type: 'text' };

// --------------------------------------------------------------- tool defs

const TOOLS = [
	{
		name: 'memory_remember',
		description: 'Add or update one fact in this workspace\'s shared long-term memory (the same store Harness\'s memory_remember writes). text <= 2000 chars, <= 1000 active facts per workspace. Omit id to add; pass a recalled id to update. Workspace is fixed by TITAN_WORKSPACE.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Information-dense fact text; must not be empty.' },
				kind: { type: 'string', enum: ['preference', 'fact', 'convention', 'decision'], description: 'Fact category (default: fact).' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Free-form routing tags; exact tag hits rank first on recall.' },
				id: { type: 'string', description: 'Update the existing fact with this id instead of adding a new one.' }
			},
			required: ['text']
		}
	},
	{
		name: 'memory_recall',
		description: 'Deterministic keyword scan over this workspace\'s active shared facts: exact tag matches rank first, case-insensitive text substring next, recency breaks ties. Literal not semantic — query with words the fact actually contains. Omit query to list the newest facts. Set decay=true for freshness-weighted ranking (same as CLI); explain=true adds the raw score. Returns the fact id, which memory_remember can take to update.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Words to match against fact text and tags.' },
				limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum facts to return (default 20).' },
				decay: { type: 'boolean', description: 'T-400: rank by freshness half-life (30d) instead of plain recency; matches `cli.mjs recall --decay`.' },
				explain: { type: 'boolean', description: 'T-400: with decay=true, include raw match score in each line.' }
			}
		}
	},
	{
		name: 'memory_search',
		description: 'Literal full-text scan over PAST session logs of this workspace (durable zstd JSONL under ~/.dsh/sessions), newest session first, strongest excerpt per session. Covers raw conversation that was never promoted to a fact. Slower than memory_recall (decompresses logs); prefer memory_recall for curated facts. Returns null when nothing matches — never invents content.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Full-text query, interpreted literally.' },
				limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum sessions to return (default 5).' }
			},
			required: ['query']
		}
	},
	{
		name: 'memory_candidates',
		description: 'P3 curation helper (read-only): scans the newest durable session logs of this workspace and returns lines that look like durable rules/lessons (裁定/以后/必须/不许/教训/根因 …), each with provenance (sessionId#seq/time/role) and a guessed kind. Nothing is written — promote one with memory_remember. Skips privacy hits and facts that already exist. Deterministic, no LLM.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum candidates to return (default 10).' },
				sessions: { type: 'integer', minimum: 1, maximum: 10, description: 'How many newest session logs to scan (default 3).' },
				query: { type: 'string', description: 'Optional literal filter applied to candidate lines.' }
			}
		}
	},
	{
		name: 'memory_consolidate',
		description: 'Report: how many active facts remain against the 1000 cap, plus deterministic near-duplicate merge candidates (Jaccard >= 0.55 over fact tokens). Pass {"apply": true} to archive the older member of each pair (pinned facts are skipped; archives are undoable via memory_undo). Nothing is deleted by this tool.',
		inputSchema: {
			type: 'object',
			properties: {
				apply: { type: 'boolean', description: 'When true, archive (not delete) the older member of each merge pair. Default false = read-only report.' }
			}
		}
	},
	{
		name: 'memory_explain',
		description: 'Read-only provenance + lifecycle for one fact by id: kind, state, pinned, provenance (sessionId/seq/timestamps) and how many backup copies of the store exist. Refuses facts outside this workspace.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Fact id to inspect.' }
			},
			required: ['id']
		}
	},
	{
		name: 'memory_pin',
		description: 'Pin a fact: memory_consolidate {"apply": true} and memory_forget refuse to touch it. Pass {"unpin": true} to unpin instead. Pins live in a TITAN-only sidecar file (DSH\'s FactSchema strips unknown keys), so pinning never changes the shared fact shape.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Fact id to pin or unpin.' },
				unpin: { type: 'boolean', description: 'When true, remove the pin instead of adding it. Default false = pin.' }
			},
			required: ['id']
		}
	},
	{
		name: 'memory_restore',
		description: 'Revive an archived fact to active. Hard-deleted facts cannot be restored. Archives made by memory_consolidate {"apply": true} or pre-existing Harness archives can be restored this way.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Archived fact id to revive.' }
			},
			required: ['id']
		}
	},
	{
		name: 'memory_undo',
		description: 'Undo the most recent titan-journal write for this workspace (remember create/update, consolidate archives, pin/unpin, restore). Not for memory_forget (it purges content by design) and not for Harness-native edits.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'memory_forget',
		description: 'IRREVERSIBLE hard delete of one fact: removes it from the shared store AND from every *.bak backup next to it, then redacts journal entries that carried its content. Default is a dry-run preview — nothing is deleted until you pass {"confirm": true}. Pinned facts are refused (unpin first). No undo.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Fact id to forget.' },
				confirm: { type: 'boolean', description: 'Must be exactly true to actually delete; omitted/false = dry-run preview only.' }
			},
			required: ['id']
		}
	},
	{
		name: 'memory_import',
		description: 'T-296: import durable session-log lines as facts into this workspace\'s shared memory (no DSH session-query handle needed). Scans the newest zstd session logs, extracts lines that look like durable rules/lessons (each with provenance sessionId#seq/time/role), and writes them as facts via memory_remember semantics. Default is dry-run (preview only); pass {"confirm": true} to actually import. Privacy filter, 2000-char cap and the 1000-fact workspace cap apply; imported facts are tagged candidate+imported and are undoable via memory_undo.',
		inputSchema: {
			type: 'object',
			properties: {
				sessionId: { type: 'string', description: 'Only import from this session id (as seen in memory_search / memory_candidates output).' },
				limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum facts to import (default 10).' },
				confirm: { type: 'boolean', description: 'Must be exactly true to actually import; omitted/false = dry-run preview only.' },
				query: { type: 'string', description: 'Optional literal filter applied to candidate lines.' }
			}
		}
	},
	{
		name: 'memory_edit',
		description: 'Replace text/kind/tags of one existing fact by id (workspace-scoped; needs the fact id from memory_recall). At least one of text/kind/tags must be supplied; omitted fields keep their value. Privacy filter and 2000-char cap apply.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Fact id to edit' },
				text: { type: 'string', description: 'Replacement text (≤2000 chars)' },
				kind: { type: 'string', enum: ['preference', 'fact', 'convention', 'decision'], description: 'Fact category (default: keep current)' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags array (default: keep current)' }
			},
			required: ['id']
		}
	},
	{
		name: 'memory_profile',
		description: 'Read or replace this workspace\'s always-injected profile (the bounded notes block DSH injects into every session prompt). Without target:\"profile\" returns current entries; with target:\"profile\" replaces all entries (max 8, ≤240 chars each) via memory_remember target:"profile" semantics.',
		inputSchema: {
			type: 'object',
			properties: {
				target: { type: 'string', enum: ['profile'], description: 'Pass "profile" to replace all entries; omit to read current profile' },
				entries: { type: 'array', items: { type: 'string' }, description: 'Profile entries to store (replaces all). Omit to read.' }
			}
		}
	},
	{
		name: 'memory_core_recall',
		description: 'dsh-core-memory style local retrieval over plain markdown files (coexists with the DSH fact store): reads <ws>/titan-memory/core/CORE.md (core memory, <= 3000 chars, resident per round) and keyword-scores long-tail notes under <ws>/titan-memory/core/notes/*.md. Zero network; keyword not semantic — a paraphrase may miss.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Keywords to match against CORE.md and notes/ bodies.' },
				limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum notes to return (default 5).' }
			}
		}
	},
	{
		name: 'memory_core_remember',
		description: 'Write the core memory markdown file (<ws>/titan-memory/core/CORE.md, max 3000 chars) — the resident-per-round snapshot. Pass note=<id> to write a long-tail note under notes/ instead (max 8000 chars per note). Files are git-versionable.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Markdown content to write.' },
				note: { type: 'string', description: 'Optional note id (a-zA-Z0-9._-). When set, writes notes/<id>.md instead of CORE.md.' }
			},
			required: ['text']
		}
	},
	{
		name: 'memory_coding_recall',
		description: 'T-150 coding memory chain (read-only): look up one coding fact by id and return its chain_block — the fact with coordinates + summary, the matched diff references (hash/summary/ref), and optionally the raw diff bodies. Coordinates match a diff entry so the chain connects code location to its diffs.',
		inputSchema: {
			type: 'object',
			properties: {
				fact_id: { type: 'string', description: 'Id of the coding fact to recall.' },
				include_bodies: { type: 'boolean', description: 'When true, also include the raw diff body text for each diff entry (default false).' }
			},
			required: ['fact_id']
		}
	}
];

// T-152 工具预算：core 档只暴露只读查询（recall / search / core_recall），
// 隐藏写工具（memory_remember / memory_core_remember）与非常驻的 consolidate。
// 档位由 env TITAN_TOOL_PROFILE 选择（core | full），默认 full = 行为完全不变。
// 依据与清单见 config/tool-exposure.json；审计脚本 mcp-bridges/tools-audit.mjs。
const TOOL_PROFILE = String(process.env.TITAN_TOOL_PROFILE || 'full').toLowerCase();
const CORE_TOOLS = new Set(['memory_recall', 'memory_search', 'memory_core_recall', 'memory_explain']);
const VISIBLE_TOOLS = TOOL_PROFILE === 'core'
	? TOOLS.filter((tool) => CORE_TOOLS.has(tool.name))
	: TOOLS;

// ------------------------------------------------------------ tool execute

async function callTool(name, args) {
	const ws = workspacePath();
	const file = memoryFile();

	if (name === 'memory_remember') {
		const fact = await remember(args ?? {}, { ws, file });
		const pins = readPins(file);
		return `stored ${fact.kind} fact ${fact.id}\n${factLine(fact, { pinned: pins.has(fact.id) })}`;
	}

	if (name === 'memory_recall') {
		const input = args ?? {};
		// T-400: MCP 走与 CLI 相同的 freshness 衰减通道；默认分支保持旧行为字节不变。
		if (input.decay === true) {
			const rows = recallFresh({ query: input.query, limit: input.limit }, { ws, file });
			if (rows.length === 0) {
				return input.query === undefined || input.query === null || String(input.query).trim() === ''
					? 'no active facts in this workspace yet'
					: `no active facts match ${JSON.stringify(String(input.query))} in this workspace`;
			}
			return rows.map((r) => input.explain === true
				? `[${r.band} mult=${r.mult.toFixed(2)} score=${r.score ?? '-'}] ${r.fact.id}: ${(r.fact.text || '').slice(0, 120)}`
				: `[${r.band} mult=${r.mult.toFixed(2)}] ${r.fact.id}: ${(r.fact.text || '').slice(0, 120)}`
			).join('\n');
		}
		const facts = recall({ query: input.query, limit: input.limit }, { ws, file });
		if (facts.length === 0) {
			return input.query === undefined || input.query === null || String(input.query).trim() === ''
				? 'no active facts in this workspace yet'
				: `no active facts match ${JSON.stringify(String(input.query))} in this workspace`;
		}
		const pins = readPins(file);
		const header = `${facts.length} fact(s) in ${ws}:`;
		return `${header}\n${facts.map((fact) => factLine(fact, { pinned: pins.has(fact.id) })).join('\n')}`;
	}

	if (name === 'memory_search') {
		const input = args ?? {};
		const result = searchSessions({ query: input.query, limit: input.limit }, { ws });
		if (result.hits.length === 0) return result.note ?? 'no matches';
		const lines = result.hits.map((hit, index) => {
			const when = hit.createdAt === undefined ? '' : `, ${iso(hit.createdAt)}`;
			return `${index + 1}. session ${hit.sessionId}${when}: ${hit.snippet}`;
		});
		const footer = `scanned ${result.scanned} session(s)${result.truncated ? ' (stopped at scan budget)' : ''}`;
		return `${lines.join('\n')}\n\n${footer}`;
	}

	if (name === 'memory_candidates') {
		const input = args ?? {};
		const result = extractCandidates(
			{ limit: input.limit, sessions: input.sessions, query: input.query },
			{ ws, file }
		);
		return renderCandidates(result);
	}

	if (name === 'memory_consolidate') {
		const input = args ?? {};
		if (input.apply === true) {
			const result = await applyConsolidations({ ws, file });
			const lines = [`scanned candidates: ${result.candidates}`];
			if (result.archived.length > 0) lines.push(`archived ${result.archived.length} older member(s): ${result.archived.map((item) => `${item.id} (kept ${item.kept})`).join(', ')}`);
			if (result.pinnedSkipped.length > 0) lines.push(`pinned, skipped: ${result.pinnedSkipped.join(', ')}`);
			if (result.archived.length === 0 && result.pinnedSkipped.length === 0) lines.push('nothing needed archiving');
			return lines.join('\n');
		}
		return consolidate({ ws, file });
	}

	if (name === 'memory_explain') {
		const input = args ?? {};
		const factId = String(input.id ?? '').trim();
		if (factId.length === 0) {
			throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_explain: id must not be empty');
		}
		return JSON.stringify(await explainFact(factId, { ws, file }), null, 2);
	}

	if (name === 'memory_pin') {
		const input = args ?? {};
		const factId = String(input.id ?? '').trim();
		if (factId.length === 0) {
			throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_pin: id must not be empty');
		}
		const result = input.unpin === true ? await unpinFact(factId, { ws, file }) : await pinFact(factId, { ws, file });
		return `${result.pinned ? 'pinned' : 'unpinned'} ${result.id}${result.already ? ' (already)' : ''}`;
	}

	if (name === 'memory_restore') {
		const input = args ?? {};
		const factId = String(input.id ?? '').trim();
		if (factId.length === 0) {
			throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_restore: id must not be empty');
		}
		const result = await restoreFact(factId, { ws, file });
		return `restored ${result.id} to active${result.already ? ' (already active)' : ''}`;
	}

	if (name === 'memory_undo') {
		const result = await undoLast({ ws, file });
		if (!result.undone) return result.reason;
		return `undone ${result.undone.action} ${result.undone.id}`;
	}

	if (name === 'memory_forget') {
		const input = args ?? {};
		const factId = String(input.id ?? '').trim();
		if (factId.length === 0) {
			throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_forget: id must not be empty');
		}
		const result = await forgetFact(factId, { ws, file, confirm: input.confirm === true });
		if (result.dryRun) {
			return `DRY RUN — nothing deleted.\n${result.kept}\npurges: ${result.purges}\nRe-run with {"id": "${result.id}", "confirm": true} to actually delete.`;
		}
		return `deleted ${result.id}; purged ${result.purgedBackups.length} backup file(s); journal entries redacted`;
	}

	if (name === 'memory_import') {
		const input = args ?? {};
		const result = await importFacts(
			{
				sessionId: input.sessionId ?? undefined,
				limit: input.limit ?? 10,
				confirm: input.confirm === true,
				query: input.query ?? undefined
			},
			{ ws, file }
		);
		if (result.dryRun) {
			const lines = [
				`DRY RUN — nothing written. would import ${result.wouldImport} fact(s) from ${result.scannedSessions} session(s) (scanned ${result.scannedMessages} messages; skipped privacy=${result.skippedPrivacy}, already-known=${result.skippedKnown}).`
			];
			for (const p of result.preview) {
				lines.push(`  - [${p.kind}] ${p.src}: ${p.text.slice(0, 140)}`);
			}
			lines.push('Re-run with {"confirm": true} to actually import.');
			return lines.join('\n');
		}
		const lines = [
			`imported ${result.imported} fact(s); skipped ${result.skipped}; active facts ${result.activeBefore} → ${result.activeAfter}`
		];
		for (const item of result.items) {
			lines.push(`  + ${item.id} [${item.kind}] ${item.src}: ${item.text.slice(0, 140)}`);
		}
		if (result.skippedDetail.length > 0) {
			lines.push('skipped:');
			for (const s of result.skippedDetail) {
				lines.push(`  - ${s.reason}: ${s.text.slice(0, 120)}`);
			}
		}
		return lines.join('\n');
	}

	if (name === 'memory_edit') {
		const input = args ?? {};
		const result = await editFact(input, { ws, file });
		const pins = readPins(file);
		return `edited fact ${result.id}\n${factLine(result, { pinned: pins.has(result.id) })}`;
	}

	if (name === 'memory_profile') {
		const input = args ?? {};
		if (input.target === 'profile') {
			const updated = await writeProfile(input.entries ?? [], { ws, file });
			return `workspace profile updated: ${updated.entries.length} entries (${updated.updatedAt})`;
		}
		const current = readProfile({ ws, file });
		if (current.entries.length === 0) return `workspace profile: 0/8 entries (empty)`;
		return `workspace profile: ${current.entries.length}/8 entries\n${current.entries.map((entry, index) => `${index}. ${entry}`).join('\n')}`;
	}

	if (name === 'memory_core_recall') {
		const input = args ?? {};
		const query = input.query ?? '';
		const core = recallCore({ query, limit: input.limit });
		const notes = recallNotes({ query, limit: input.limit });
		const sections = [renderHits(core), '', renderHits(notes)];
		return `CORE.md + notes/ local keyword recall for ${JSON.stringify(String(query))}:\n\n${sections.join('\n')}`;
	}

	// T-150 coding memory chain (read-only): look up one coding fact and hand
	// back its chain_block. The prototype store is a PRIVATE tree under
	// <ws>/titan-memory/chain-data/ — it never touches the shared fact store.
	if (name === 'memory_coding_recall') {
		const input = args ?? {};
		const factId = String(input.fact_id ?? '').trim();
		if (factId.length === 0) {
			throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_coding_recall: fact_id must not be empty');
		}
		const withBodies = input.include_bodies === true;
		let block;
		try {
			block = recallCodingFact(factId, { ws, withBodies });
		} catch (error) {
			// Same convention as every other missing fact in this server: a
			// MEMORY_NOT_FOUND tool result, never a protocol-level failure.
			if (!/no coding fact with id/.test(String(error?.message ?? ''))) throw error;
			throw new MemoryError('MEMORY_NOT_FOUND', `memory_coding_recall: coding fact '${factId}' not found in this workspace`);
		}
		return JSON.stringify(chainBlock(block, withBodies), null, 2);
	}

	if (name === 'memory_core_remember') {
		const input = args ?? {};
		const text = String(input.text ?? '');
		if (text.trim().length === 0) {
			throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_core_remember: text must not be empty');
		}
		if (input.note !== undefined && String(input.note).length > 0) {
			const note = rememberNote(String(input.note), text);
			return `stored long-tail note ${note.id} (${note.bytes} bytes) under ${notesDirPath()}`;
		}
		const core = rememberCore(text);
		return `stored core memory (${core.chars} chars, ${core.bytes} bytes) at ${coreFilePath()}`;
	}

	throw new MemoryError('MEMORY_INVALID_ARGS', `unknown tool ${JSON.stringify(name)}`);
}

// Project the prototype's chain_block onto the wire shape: the fact with its
// coordinates + summary, the diff references matched by coordinate, and — only
// when the caller explicitly asked — the raw diff bodies. The body never
// rides along with the fact; it is fetched by hash on request.
function chainBlock(block, withBodies) {
	const fact = block?.fact ?? {};
	const out = {
		fact: {
			id: fact.id ?? '',
			coordinates: {
				file: fact.coordinates?.file ?? '',
				function: fact.coordinates?.function ?? '',
				branch: fact.coordinates?.branch ?? ''
			},
			summary: fact.summary ?? '',
			createdAt: fact.createdAt ?? null
		},
		diffs: (block?.diffs ?? []).map((diff) => ({
			hash: diff.hash,
			summary: diff.summary,
			ref: diff.ref
		}))
	};
	if (withBodies) {
		out.bodies = (block?.bodies ?? []).map((body) => ({
			hash: body.hash,
			body: body.body
		}));
	}
	return out;
}

function toolResult(text, isError = false) {
	return { content: [{ ...TEXT_OUTPUT, text }], isError };
}

function errorText(error) {
	const code = error?.code ? `${error.code}: ` : '';
	return `${code}${error?.message ?? String(error)}`;
}

// ------------------------------------------------------------ jsonrpc loop

function reply(id, result) {
	send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
	send({ jsonrpc: '2.0', id, error: { code, message } });
}

function send(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function dispatch(message) {
	const { id, method, params } = message;
	const isRequest = id !== undefined && id !== null;

	if (!isRequest) {
		// Notifications (initialized, cancelled, ...) need no response.
		return;
	}

	switch (method) {
		case 'initialize': {
			const requested = params?.protocolVersion;
			reply(id, {
				protocolVersion: typeof requested === 'string' ? requested : SUPPORTED_PROTOCOL,
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				instructions: 'Shared TITAN long-term memory. Workspace is fixed by TITAN_WORKSPACE; facts are shared with the DeepSeek Harness client, which owns the full eight-tool set (memory_edit / memory_forget / memory_profile / memory_import live there). Writes are literal and durable — never invent fact ids or contents.'
			});
			return;
		}
		case 'ping':
			reply(id, {});
			return;
		case 'tools/list':
			reply(id, { tools: VISIBLE_TOOLS });
			return;
		case 'tools/call': {
			const name = params?.name;
			try {
				const text = await callTool(name, params?.arguments ?? {});
				reply(id, toolResult(text, false));
			} catch (error) {
				// Per spec, tool-level failures surface as isError content so the
				// model sees the reason instead of a bare protocol error.
				log(`tool ${name} failed: ${error?.stack ?? error}`);
				reply(id, toolResult(errorText(error), true));
			}
			return;
		}
		default:
			replyError(id, -32601, `method not found: ${String(method)}`);
	}
}

function main() {
	log(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio (workspace=${workspacePath()}, client=${process.env.TITAN_CLIENT || 'unknown'}, store=${memoryFile()})`);

	let buffer = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length === 0) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch (error) {
				log(`dropping malformed frame: ${error.message}`);
				continue;
			}
			dispatch(message).catch((error) => {
				log(`dispatch failed: ${error?.stack ?? error}`);
				if (message.id !== undefined && message.id !== null) replyError(message.id, -32603, errorText(error));
			});
		}
	});
	process.stdin.on('end', () => process.exit(0));
	process.stdin.on('close', () => process.exit(0));
	process.on('SIGINT', () => process.exit(0));
	process.on('SIGTERM', () => process.exit(0));
}

main();
