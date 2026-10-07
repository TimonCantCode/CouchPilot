import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const c = await import('./crypto.ts');

test('encrypt/decrypt roundtrip, tampering and wrong owner are detected', () => {
  const blob = c.encrypt('sk-secret', 'secrets:a');
  assert.equal(c.decrypt(blob, 'secrets:a'), 'sk-secret');
  assert.notEqual(c.encrypt('sk-secret', 'secrets:a'), blob); // random IV
  assert.throws(() => c.decrypt(blob, 'secrets:b')); // swapped between users
  const bad = Buffer.from(blob.slice(3), 'base64');
  bad[bad.length - 1] ^= 1;
  assert.throws(() => c.decrypt('v2:' + bad.toString('base64'), 'secrets:a'));
});

test('password hash', async () => {
  const h = await c.hashPassword('correct-long-123');
  assert.ok(await c.verifyPassword('correct-long-123', h));
  assert.ok(!(await c.verifyPassword('wrong', h)));
  assert.ok(!(await c.verifyPassword('x', 'broken')));
});
