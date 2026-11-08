/**
 * End-to-end check against a running API + worker using the mock provider.
 *   npm run smoke
 * Requires MOCK_PROVIDER_ENABLED=true on the worker and API.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.SMOKE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const ADMIN = process.env.ADMIN_TOKEN!;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function api<T = any>(method: string, path: string, body?: unknown, auth?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: `Bearer ${auth}` } : { 'x-admin-token': ADMIN }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as T };
}

async function newUser(tokens: number) {
  const r = await api('POST', '/admin/users', { email: `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`, initialTokens: tokens });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json as { userId: string; apiKey: string };
}

async function waitDone(id: string, key: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api('GET', `/v1/videos/${id}`, undefined, key);
    if (['completed', 'failed', 'canceled'].includes(r.json.status)) return r.json;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${JSON.stringify(r.json)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function ledgerConsistent(userId: string) {
  const r = await db.query(
    `SELECT u.token_balance, COALESCE(SUM(t.amount), 0)::bigint AS ledger FROM users u
     LEFT JOIN token_transactions t ON t.user_id = u.id WHERE u.id = $1 GROUP BY u.token_balance`,
    [userId],
  );
  assert.equal(Number(r.rows[0].token_balance), Number(r.rows[0].ledger), 'balance must equal ledger sum');
  return Number(r.rows[0].token_balance);
}

const base = { provider: 'mock', resolution: '360p', segmentSeconds: 5 };

async function main() {
  // 1. Fixed duration: 18 s -> segments of 5,5,5,3 = 18 tokens (1 token/s).
  {
    const u = await newUser(100);
    const c = await api('POST', '/v1/videos', { ...base, prompt: 'a red fox running through snow', targetSeconds: 18 }, u.apiKey);
    assert.equal(c.status, 202, JSON.stringify(c.json));
    const v = await waitDone(c.json.id, u.apiKey);
    assert.equal(v.status, 'completed', JSON.stringify(v));
    assert.equal(v.stopReason, 'target_reached');
    assert.deepEqual(v.segments.map((s: any) => s.seconds), [5, 5, 5, 3]);
    assert.equal(v.tokensSpent, 18);
    assert.equal(await ledgerConsistent(u.userId), 82);
    const file = await fetch(v.url);
    assert.equal(file.status, 200);
    assert.ok(Number(file.headers.get('content-length') ?? (await file.arrayBuffer()).byteLength) > 10_000);
    console.log(`✓ duration mode: ${v.finalDurationSeconds}s final video, 18 tokens charged`);
  }

  // 2. Until balance exhausted: 12 tokens at 5/segment -> 2 segments, then stops; 2 tokens left.
  {
    const u = await newUser(12);
    const c = await api('POST', '/v1/videos', { ...base, prompt: 'ocean waves at dusk', untilBalanceExhausted: true }, u.apiKey);
    const v = await waitDone(c.json.id, u.apiKey);
    assert.equal(v.status, 'completed', JSON.stringify(v));
    assert.equal(v.stopReason, 'insufficient_balance');
    assert.deepEqual(v.segments.map((s: any) => s.status), ['completed', 'completed', 'skipped']);
    assert.equal(await ledgerConsistent(u.userId), 2);
    console.log(`✓ until-balance mode: stopped after 2 segments, ${v.finalDurationSeconds}s, 2 tokens left`);
  }

  // 3. Provider keeps rejecting segment 2 -> retried, then refunded; partial video delivered.
  {
    const u = await newUser(100);
    const c = await api('POST', '/v1/videos', { ...base, prompt: 'x', segmentPrompts: ['a city at night', 'FAIL this one'], targetSeconds: 15 }, u.apiKey);
    const v = await waitDone(c.json.id, u.apiKey);
    assert.equal(v.status, 'completed', JSON.stringify(v));
    assert.equal(v.stopReason, 'segment_failed');
    assert.deepEqual(v.segments.map((s: any) => s.status), ['completed', 'failed']);
    assert.equal(v.tokensSpent, 5);
    assert.equal(await ledgerConsistent(u.userId), 95);
    console.log(`✓ failed segment refunded after ${v.segments[1].retries} retries; partial video delivered`);
  }

  // 4. Race: 3 videos start at once but the balance only covers 2 first segments.
  {
    const u = await newUser(10);
    const created = await Promise.all(
      [1, 2, 3].map((i) => api('POST', '/v1/videos', { ...base, prompt: `race ${i}`, targetSeconds: 5 }, u.apiKey)),
    );
    created.forEach((c) => assert.equal(c.status, 202, JSON.stringify(c.json)));
    const done = await Promise.all(created.map((c) => waitDone(c.json.id, u.apiKey)));
    const statuses = done.map((d) => d.status).sort();
    assert.deepEqual(statuses, ['completed', 'completed', 'failed']);
    assert.equal(await ledgerConsistent(u.userId), 0);
    console.log('✓ concurrent videos never overdraw: 2 completed, 1 failed for balance, balance 0');
  }

  // 5. Cancel mid-way: in-flight segment finishes, nothing further is charged.
  {
    const u = await newUser(100);
    const c = await api('POST', '/v1/videos', { ...base, prompt: 'a long journey', targetSeconds: 50 }, u.apiKey);
    await new Promise((r) => setTimeout(r, 400));
    const x = await api('POST', `/v1/videos/${c.json.id}/cancel`, {}, u.apiKey);
    assert.equal(x.status, 202);
    const v = await waitDone(c.json.id, u.apiKey);
    assert.equal(v.stopReason, 'canceled');
    const charged = v.segments.filter((s: any) => s.status === 'completed').length * 5;
    assert.equal(v.tokensSpent, charged);
    assert.equal(await ledgerConsistent(u.userId), 100 - charged);
    console.log(`✓ cancel: stopped after ${charged / 5} segment(s), only those charged`);
  }

  // 6. Validation & auth.
  {
    const u = await newUser(1);
    assert.equal((await api('POST', '/v1/videos', { ...base, prompt: 'p', targetSeconds: 10 }, u.apiKey)).status, 402);
    assert.equal((await api('POST', '/v1/videos', { ...base, prompt: 'p' }, u.apiKey)).status, 400);
    assert.equal((await api('GET', '/v1/me', undefined, 'vk_wrong')).status, 401);
    console.log('✓ 402 on low balance, 400 on bad body, 401 on bad key');
  }

  await db.end();
  console.log('\nall smoke checks passed');
}

main().catch(async (err) => {
  console.error('SMOKE FAILED:', err);
  await db.end();
  process.exit(1);
});
