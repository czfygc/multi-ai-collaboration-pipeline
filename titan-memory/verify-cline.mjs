// Cline-side cross-validation for T-34 (M4: 修的人不许自己验收).
//
// Cline on this box is the desktop app (no headless CLI, bin/ holds only Linux
// remote-helpers). So we reproduce what Cline itself does:
//   1. read BOTH config files Cline reads (project .cline/mcp.json and the
//      shared ~/.cline/data/settings/cline_mcp_settings.json),
//   2. validate them against Cline's published McpSettingsSchema shape
//      (z.object({ mcpServers: z.record(ServerConfigSchema) }), local type =
//      command + args, plus env / disabled / autoApprove / timeout),
//   3. spawn the server with EXACTLY that command/args/env and speak MCP to it.
// If step 3 answers, the entry point Cline will launch is alive.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKSPACE = process.env.TITAN_WORKSPACE
  || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT = path.join(WORKSPACE, '.cline/mcp.json');
const GLOBAL = path.join(process.env.USERPROFILE, '.cline/data/settings/cline_mcp_settings.json');

let fails = 0;
let checks = 0;
const ok = (label, cond, detail = '') => {
	checks += 1;
	if (cond) process.stdout.write(`  ok    ${label}\n`);
	else { fails += 1; process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}\n`); }
};

// ---- 1. Cline's documented schema -----------------------------------------
function validate(raw, source) {
	const problems = [];
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		problems.push('top level must be a JSON object');
		return problems;
	}
	if (raw.mcpServers === undefined) problems.push('missing mcpServers');
	if (raw.mcpServers && (typeof raw.mcpServers !== 'object' || Array.isArray(raw.mcpServers))) {
		problems.push('mcpServers must be an object');
		return problems;
	}
	for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
		if (!cfg || typeof cfg !== 'object') { problems.push(`${name}: server config must be an object`); continue; }
		if (cfg.type !== undefined && !['stdio', 'sse', 'streamableHttp'].includes(cfg.type)) {
			problems.push(`${name}: unknown type ${cfg.type}`);
		}
		const isLocal = cfg.type === undefined || cfg.type === 'stdio';
		if (isLocal) {
			if (typeof cfg.command !== 'string' || cfg.command.length === 0) problems.push(`${name}: local server needs a string command`);
			if (cfg.args !== undefined && !Array.isArray(cfg.args)) problems.push(`${name}: args must be an array`);
			if (cfg.env !== undefined && (typeof cfg.env !== 'object' || Array.isArray(cfg.env))) problems.push(`${name}: env must be an object`);
		}
		if (cfg.disabled !== undefined && typeof cfg.disabled !== 'boolean') problems.push(`${name}: disabled must be boolean`);
		if (cfg.autoApprove !== undefined && !Array.isArray(cfg.autoApprove)) problems.push(`${name}: autoApprove must be an array`);
		if (cfg.timeout !== undefined && (typeof cfg.timeout !== 'number' || cfg.timeout <= 0)) problems.push(`${name}: timeout must be a positive number`);
	}
	void source;
	return problems;
}

process.stdout.write('Cline config validation\n');
const projectCfg = JSON.parse(fs.readFileSync(PROJECT, 'utf8'));
const globalCfg = JSON.parse(fs.readFileSync(GLOBAL, 'utf8'));

const pProblems = validate(projectCfg, PROJECT);
const gProblems = validate(globalCfg, GLOBAL);
ok(`project ${PROJECT} passes Cline schema`, pProblems.length === 0, pProblems.join('; '));
ok(`global ${path.basename(GLOBAL)} passes Cline schema`, gProblems.length === 0, gProblems.join('; '));

const name = 'titan';
const a = projectCfg.mcpServers[name];
const b = globalCfg.mcpServers[name];
ok('both files declare the same server name "titan"', Boolean(a) && Boolean(b));
ok('both files point at the same entry', a?.command === b?.command && JSON.stringify(a?.args) === JSON.stringify(b?.args));
ok('server not disabled', a?.disabled === false && b?.disabled === false);
ok('TITAN_WORKSPACE pinned in env', a?.env?.TITAN_WORKSPACE === WORKSPACE.replace(/\\/g, '/'), JSON.stringify(a?.env));

// ---- 2. spawn exactly as Cline would ---------------------------------------
const ws = a.env.TITAN_WORKSPACE;
const child = spawn(a.command, a.args, {
	env: { ...process.env, ...a.env },
	cwd: ws,
	stdio: ['pipe', 'pipe', 'pipe'],
	windowsHide: true
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const pending = new Map();
let nextId = 1;
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		const waiter = pending.get(msg.id);
		if (waiter) { pending.delete(msg.id); waiter(msg); }
	}
});

const request = (method, params) => new Promise((resolve, reject) => {
	const id = nextId++;
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout on ${method}`)); }, 60_000);
	pending.set(id, (msg) => {
		clearTimeout(timer);
		if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
		else resolve(msg.result);
	});
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

try {
	process.stdout.write('\nspawned from Cline config, MCP handshake\n');
	const init = await request('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'cline-cross-validator', version: '1.0.0' }
	});
	ok('server answers initialize', init?.serverInfo?.name === 'titan-memory', JSON.stringify(init?.serverInfo));
	ok('server advertises tools', typeof init?.capabilities?.tools === 'object');
	notify('notifications/initialized');

	const listed = await request('tools/list');
	const names = (listed.tools ?? []).map((t) => t.name).sort();
	ok('16 tools exposed', names.length === 16, JSON.stringify(names));
	ok('tool names are unprefixed (Cline prefixes with server name)', names.every((n) => n.startsWith('memory_')), JSON.stringify(names));
	process.stdout.write(`  -> Cline will show these as: ${names.map((n) => `${name}_${n}`).join(', ')}\n`);

	const recall = await request('tools/call', { name: 'memory_recall', arguments: { query: '10810', limit: 3 } });
	const recallText = recall.content?.[0]?.text ?? '';
	ok('memory_recall finds real facts via the Cline-spawned server',
		recall.isError !== true && /\d+ fact\(s\)/.test(recallText) && /10810|sing_box/.test(recallText),
		JSON.stringify(recall).slice(0, 300));
	process.stdout.write(`  -> ${recallText.split('\n')[0].slice(0, 120)}\n`);
	ok('workspace resolved to the pinned workspace (forward-slash env normalised)',
		/no active facts/.test(recallText) === false);

	const search = await request('tools/call', { name: 'memory_search', arguments: { query: '10810', limit: 2 } });
	ok('memory_search works through the Cline-spawned server', search.isError !== true && /session /.test(search.content?.[0]?.text ?? ''),
		JSON.stringify(search).slice(0, 300));

	// The server is SUPPOSED to log its banner to stderr (stdout is protocol-only).
	// Anything error-shaped there is a real problem.
	ok('stderr has no error-shaped lines', !/(error|Error|ERR_|failed|FAIL|undefined)/.test(stderr), stderr.trim().slice(0, 240));
} catch (error) {
	fails += 1;
	checks += 1;
	process.stdout.write(`  FAIL  handshake — ${error.message}\n`);
	if (stderr.trim()) process.stdout.write(`  stderr: ${stderr.trim().slice(0, 400)}\n`);
} finally {
	child.stdin.end();
	await new Promise((resolve) => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); });
}

process.stdout.write(`\n${checks - fails}/${checks} checks passed\n`);
process.exit(fails === 0 ? 0 : 1);
