import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, parsePicks } from './ai.ts';

test('private IPs are detected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
    assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['1.1.1.1', '172.32.0.1', '8.8.8.8', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
});

test('parse AI reply', () => {
  assert.deepEqual(parsePicks('Sure! ```json\n{"picks":[3,1,3,99,"2",-1]}\n```', 10), [{ i: 3 }, { i: 1 }, { i: 2 }]);
  assert.deepEqual(parsePicks('{"picks":[{"i":4,"why":"Because\\nDark"},{"i":4}]}', 10), [{ i: 4, why: 'Because Dark' }]);
  assert.deepEqual(parsePicks('no json', 10), []);
  assert.deepEqual(parsePicks('{"picks": "x"}', 10), []);
});
