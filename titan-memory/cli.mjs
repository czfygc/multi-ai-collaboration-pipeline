#!/usr/bin/env node
// CLI fallback for the shared TITAN memory store — for any client that can
// only reach a shell. Same store, same semantics as server.mjs.
//
//   node cli.mjs recall  '{"query":"10810","limit":5}'
//   node cli.mjs recall  "{\"query\":\"foo\"}"          # PowerShell/cmd 友好（不要求外层引号）
//   cli.mjs recall "$('{\"query\":\"foo\"}')"            # PowerShell 里变量插值也可
//   echo '{"query":"foo","limit":5}' | node cli.mjs recall -   # 走 stdin，免引号嵌套（推荐）
//   node cli.mjs remember '{"text":"...","kind":"decision","tags":["x"]}'
//   node cli.mjs search  '{"query":"proxy"}'
//   node cli.mjs consolidate
//   node cli.mjs candidates '{"limit":5,"sessions":2}'
//   node cli.mjs edit '{"id":"...","text":"new text","tags":["a"]}'
//   node cli.mjs profile               # read current profile entries
//   node cli.mjs profile '{"target":"profile","entries":["..."]}'  # replace all
//   node cli.mjs import '{"sessionId":"...","limit":10,"confirm":true}'   # import session-log lines as facts (dry-run unless confirm)
//
// JSON args on argv (all remaining tokens are joined, outer quotes are optional),
// or on stdin via `-`. Human-readable text on stdout; exit code 1 on error.

import process from 'node:process';
import { remember, recall, consolidate, editFact, readProfile, writeProfile, importFacts, MemoryError, workspacePath, memoryFile, factLine } from './store.mjs';
import { searchSessions } from './search.mjs';
import { extractCandidates, renderCandidates } from './candidates.mjs';
import { recallFresh, explainFactMatch, staleCandidates } from './freshness.mjs';

function parseArgsRaw(raw) {
	if (raw === undefined || raw === null || String(raw).trim() === '') return {};
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new MemoryError('MEMORY_INVALID_ARGS', `argument must be JSON: ${error.message}`);
	}
}

// 常见失败模式：PowerShell/cmd 把 '{"query":"foo"}' 当整体 token 切碎（argv 被拆成多个 token）
// → 拼回原串再解析；智能引号/全角引号先归一化；纯单引号 JSON（Python 习惯）转双引号。
function joinArgv(rest) {
	const joined = rest.join(' ').trim();
	const smart = joined.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
	const candidates = [joined];
	if (smart !== joined) candidates.push(smart);
	const quoteSwap = smart.replace(/'/g, '"');
	if (quoteSwap !== smart) candidates.push(quoteSwap);
	for (const c of candidates) {
		try { return JSON.parse(c); } catch { /* next */ }
	}
	// 再不行就按 key=value 兜底（'t=foo' → {query:'foo'}）——只用于 recall/search
	const m = joined.match(/^([A-Za-z_][A-Za-z0-9_-]*)=(.+)$/);
	if (m) return { query: m[2] };
	// 最后兜底：裸词（无 JSON 特殊字符、不含空格）直接当查询词，省掉引号（常见 CLI 用法）
	if (!/[{}[\]"'\s]/.test(joined) && joined.length > 0 && joined.length <= 32) {
		return { query: joined };
	}
	throw new MemoryError('MEMORY_INVALID_ARGS',
		`argument must be JSON (got: ${joined.slice(0, 120)}). 用法: cli.mjs recall '{"query":"foo","limit":5}' ；或者 stdin 模式: cli.mjs recall - < file.json`);
}

async function readStdinIfRequested(rest) {
	if (rest.length === 1 && rest[0] === '-') {
		return new Promise((resolve) => {
			let buf = '';
			process.stdin.on('data', (c) => { buf += c; });
			process.stdin.on('end', () => resolve(buf));
			process.stdin.setEncoding('utf8');
			process.stdin.resume();
		});
	}
	return undefined;
}

async function main() {
	const [, , command, ...rest] = process.argv;
	const stdinPayload = await readStdinIfRequested(rest);
	// 显式 - 走 stdin（免引号嵌套），否则 argv 全部 join 起来再解析
	const args = stdinPayload !== undefined ? parseArgsRaw(stdinPayload) : joinArgv(rest);
	const ws = workspacePath();
	const file = memoryFile();

	let out;
	switch (command) {
		case 'remember': {
			const fact = await remember(args, { ws, file });
			out = `stored ${fact.kind} fact ${fact.id}\n${factLine(fact)}`;
			break;
		}
		case 'recall': {
			if (args.decay === true) {
				const rows = recallFresh({ query: args.query, limit: args.limit }, { ws, file });
				if (rows.length === 0) {
					out = args.query === undefined ? 'no active facts in this workspace yet'
						: `no active facts match ${JSON.stringify(String(args.query))} in this workspace`;
				} else {
					const line = args.explain === true
						? (r) => `[${r.band} mult=${r.mult.toFixed(2)} score=${r.score ?? '-'}] ${r.fact.id}: ${(r.fact.text || '').slice(0, 120)}`
						: (r) => `[${r.band} mult=${r.mult.toFixed(2)}] ${r.fact.id}: ${(r.fact.text || '').slice(0, 120)}`;
					out = rows.map(line).join('\n');
				}
				break;
			}
			const facts = recall({ query: args.query, limit: args.limit }, { ws, file });
			if (facts.length === 0) {
				out = args.query === undefined ? 'no active facts in this workspace yet'
					: `no active facts match ${JSON.stringify(String(args.query))} in this workspace`;
			} else {
				out = `${facts.length} fact(s) in ${ws}:\n${facts.map(factLine).join('\n')}`;
			}
			break;
		}
		case 'search': {
			const result = searchSessions({ query: args.query, limit: args.limit }, { ws });
			out = result.hits.length === 0
				? (result.note ?? 'no matches')
				: `${result.hits.map((hit, i) => `${i + 1}. session ${hit.sessionId}: ${hit.snippet}`).join('\n')}\n\nscanned ${result.scanned} session(s)`;
			break;
		}
		case 'consolidate':
			out = consolidate({ ws, file });
			break;
		case 'candidates': {
			const result = extractCandidates({ limit: args.limit, sessions: args.sessions, query: args.query }, { ws, file });
			out = renderCandidates(result);
			break;
		}
		case 'edit': {
			const result = editFact(args, { ws, file });
			out = `edited ${result.id}: ${result.text.slice(0, 200)}`;
			break;
		}
		case 'profile': {
			if (args.target === 'profile' && Array.isArray(args.entries)) {
				const updated = await writeProfile(args.entries, { ws, file });
				out = `profile updated: ${updated.entries.length}/8 entries`;
			} else {
				const current = readProfile({ ws, file });
				out = current.entries.length === 0
					? 'profile: empty'
					: `profile ${current.entries.length}/8:\n${current.entries.map((e, i) => `${i}. ${e}`).join('\n')}`;
			}
			break;
		}
		case 'import': {
			const result = await importFacts(
				{ sessionId: args.sessionId, limit: args.limit, confirm: args.confirm === true, query: args.query },
				{ ws, file }
			);
			out = JSON.stringify(result, null, 2);
			break;
		}
		case 'stale': {
			const stale = staleCandidates({ ws, file });
			out = stale.length === 0
				? 'no stale (below-threshold) active facts — everything is reasonably fresh'
				: `${stale.length} stale candidate(s) (list-only, nothing deleted):\n${stale.map((s) => `${s.id}: mult=${s.mult} age=${s.ageDays}d`).join('\n')}`;
			break;
		}
		default:
			process.stderr.write('usage: cli.mjs <remember|recall|search|consolidate|candidates|edit|profile|import|stale> [json-args]\n');
			process.exit(2);
	}
	process.stdout.write(`${out}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}\n`);
	process.exit(1);
});
