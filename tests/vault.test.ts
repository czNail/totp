import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVault, ITERATIONS, openVault, parseBackup, sealVault, validateData, validateEnvelope, type VaultData } from '../src/vault.ts';

const data: VaultData = { version: 1, accounts: [{ id: 'ad180843-ff41-4534-a319-145a631a696e', name: 'work@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60 }] };

test('vault round trip: only ciphertext is serialized; AES key is nonextractable', async () => {
  const created = await createVault('123456', data);
  const serialized = JSON.stringify(created.envelope);
  for (const secret of ['123456', 'work@example.com', 'GitHub', data.accounts[0].secret]) assert.ok(!serialized.includes(secret));
  assert.equal(created.key.extractable, false);
  assert.equal(created.envelope.kdf.iterations, ITERATIONS);
  const opened = await openVault('123456', parseBackup(serialized));
  assert.deepEqual(opened.data, data);
  assert.equal(opened.key.extractable, false);
});
test('wrong PIN and modified ciphertext/IV/metadata never decrypt', async () => {
  const { envelope } = await createVault('123456', data);
  await assert.rejects(openVault('654321', envelope), /PIN 不正确/);
  const ciphertext = structuredClone(envelope);
  ciphertext.ciphertext = (ciphertext.ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.ciphertext.slice(1);
  await assert.rejects(openVault('123456', ciphertext), /PIN 不正确/);
  const iv = structuredClone(envelope);
  iv.cipher.iv = (iv.cipher.iv[0] === 'A' ? 'B' : 'A') + iv.cipher.iv.slice(1);
  await assert.rejects(openVault('123456', iv), /PIN 不正确/);
  const metadata = structuredClone(envelope);
  metadata.kdf.iterations++;
  await assert.rejects(openVault('123456', metadata), /PIN 不正确/);
});
test('every save has a fresh IV; restore and PIN change use fresh salts', async () => {
  const first = await createVault('123456', data);
  const saved = await sealVault(data, first.key, first.envelope.kdf);
  assert.notEqual(saved.cipher.iv, first.envelope.cipher.iv);
  assert.notEqual(saved.ciphertext, first.envelope.ciphertext);
  assert.deepEqual((await openVault('123456', saved)).data, data);
  const restored = await createVault('123456', data);
  assert.notEqual(restored.envelope.kdf.salt, first.envelope.kdf.salt);
  const changed = await createVault('987654', data);
  await assert.rejects(openVault('123456', changed.envelope));
  assert.deepEqual((await openVault('987654', changed.envelope)).data, data);
});
test('reject malformed backups and unbounded KDF work before attempting decryption', async () => {
  const { envelope } = await createVault('123456');
  for (const invalid of [null, {}, { ...envelope, version: 9 }, { ...envelope, cipher: { name: 'AES-CBC', iv: envelope.cipher.iv } }, { ...envelope, kdf: { ...envelope.kdf, iterations: 1 } }, { ...envelope, kdf: { ...envelope.kdf, iterations: 1000000000 } }, { ...envelope, kdf: { ...envelope.kdf, salt: '!!!!' } }]) assert.throws(() => validateEnvelope(invalid));
  assert.throws(() => parseBackup('{broken'));
  assert.throws(() => parseBackup(' '.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(createVault('12345'));
  await assert.rejects(createVault('abcdef'));
});
test('reject corrupted account data, duplicate IDs and unsupported OTP parameters', () => {
  assert.throws(() => validateData({ version: 2, accounts: [] }));
  assert.throws(() => validateData({ ...data, accounts: [data.accounts[0], data.accounts[0]] }));
  for (const patch of [{ name: '' }, { issuer: 'x'.repeat(129) }, { secret: 'NOT1BASE32' }, { digits: 7 }, { period: 0 }, { id: '<script>' }]) {
    assert.throws(() => validateData({ ...data, accounts: [{ ...data.accounts[0], ...patch }] }));
  }
});
