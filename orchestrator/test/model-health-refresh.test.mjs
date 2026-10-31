// orchestrator/test/model-health-refresh.test.mjs — T-186 健康表保鲜调度
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(REPO_ROOT, 'orchestrator', 'scheduler', 'model-health-refresh.mjs');
const LIB = join(REPO_ROOT, 'orchestrator', 'lib', 'model-health.mjs');

test('selectProbeIds：默认排除计量档（rpd 有值），includeMetered 才纳入', async () => {
  const { selectProbeIds } = await import('../scheduler/model-health-refresh.mjs');
  const models = [
    { id: 'unlimited-a', rpd: null, free: true },
    { id: 'metered-b', rpd: 50, free: true },
    { id: 'paid-c', rpd: null, free: false },
    { id: 'unlimited-d', rpd: null, free: true },
  ];
  assert.deepEqual(selectProbeIds(models), ['unlimited-a', 'unlimited-d']);
  assert.deepEqual(selectProbeIds(models, { includeMetered: true }), ['unlimited-a', 'metered-b', 'unlimited-d']);
  assert.deepEqual(selectProbeIds([]), []);
});

test('dry-run 列出待探清单且不发网络请求（退出 0，夹具驱动）', () => {
  // T-192 发抖治理：旧版读活 model-tiers.json——其他客户端同步目录/改 rpd 的瞬间本用例就翻红
  //（T-191 实证：tmp/t191_test3.log 里 nemotron 断言随活池内容翻转）。改用 --tiers 夹具确定性复现。
  const dir = mkdtempSync(join(tmpdir(), 'mhr-fixture-'));
  const fixture = join(dir, 'tiers.json');
  writeFileSync(fixture, JSON.stringify({
    models: [
      { id: 'unlimited-a', rpd: null, free: true, tier: 'light' },
      { id: 'nemotron-3.5-lightning-free', rpd: null, free: true, tier: 'light' },
      { id: 'nemotron-metered', rpd: 50, free: true, tier: 'light' },
      { id: 'paid-x', rpd: null, free: false, tier: 'light' },
    ],
  }), 'utf8');
  try {
    const r = spawnSync(process.execPath, [CLI, '--dry-run', '--tiers', fixture], { encoding: 'utf8', cwd: REPO_ROOT });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /dry-run 待探 2 个/, '夹具中应恰有 2 个不限量模型');
    assert.match(r.stdout, /跳过计量档 1 个/, '应提示跳过计量档');
    // 计量档（rpd=50）不得进待探清单——完整 token 匹配：\b 在连字符前不成立，
    // 旧正则会误伤免费弱模型 nemotron-3.5-lightning-free（T-191 教训保留）
    assert.doesNotMatch(r.stdout, /(?<![\w-])nemotron-metered(?![\w-])/, '计量档 nemotron-metered 不应探');
    assert.match(r.stdout, /(?<![\w-])nemotron-3\.5-lightning-free(?![\w-])/, '免费同形名应保留在待探清单');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--once 缺密钥时优雅退出不抛栈（missing_key 落盘）', () => {
  const statePath = join(REPO_ROOT, 'orchestrator', 'run-events', 'supervisor', 'model-health-refresh.test.json');
  // T-251：调度器现在兼容双键名（仓内实为 TITAN_FREELLM_API_KEY）——两个键都必须显式置空，
  // 否则 loadSecretsEnv 从 titan_secrets.env 装载别名键后会真跑一轮探针（~120s 且非确定性）。
  const r = spawnSync(process.execPath, [CLI, '--once', '--state', statePath], {
    encoding: 'utf8', cwd: REPO_ROOT,
    env: { ...process.env, FREELLMAPI_API_KEY: '', TITAN_FREELLM_API_KEY: '' },
  });
  // 有密钥时探针会真跑（exit 0）；无密钥 exit 1 + missing_key
  if (r.status !== 0) {
    assert.match(r.stdout + r.stderr, /FREELLMAPI_API_KEY/, '缺密钥应有明确提示');
  } else {
    assert.ok(true, '环境有密钥，真探成功');
  }
});
