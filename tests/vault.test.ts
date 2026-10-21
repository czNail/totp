import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changePin, createVault, hasPattern, ITERATIONS, openVault, parseBackup, sealVault, setPattern, validateData, validateEnvelope, type VaultData } from '../src/vault.ts';

const data: VaultData = { version: 1, accounts: [{ id: 'ad180843-ff41-4534-a319-145a631a696e', name: 'work@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60 }] };
const pattern = '14789';

test('v2 vault round trip persists only ciphertext and a wrapped random data key', async () => {
  const created = await createVault('123456', data);
  const serialized = JSON.stringify(created.envelope);
  for (const secret of ['123456', 'work@example.com', 'GitHub', data.accounts[0].secret]) assert.ok(!serialized.includes(secret));
  assert.equal(created.envelope.version, 2);
  assert.equal(created.envelope.unlocks.pin.kdf.iterations, ITERATIONS);
  assert.equal(Buffer.from(created.envelope.unlocks.pin.ciphertext, 'base64').length, 48);
  assert.deepEqual((await openVault('123456', parseBackup(serialized))).data, data);
});
test('wrong PIN and modified ciphertext, IV, wrapping metadata or slots never decrypt', async () => {
  const created = await createVault('123456', data);
  const envelope = await setPattern(data, created.key, created.envelope, pattern);
  await assert.rejects(openVault('654321', envelope), /PIN 不正确/);
  await assert.rejects(openVault('12369', envelope, 'pattern'), /手势不正确/);
  const ciphertext = structuredClone(envelope);
  ciphertext.ciphertext = (ciphertext.ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.ciphertext.slice(1);
  await assert.rejects(openVault('123456', ciphertext));
  const iv = structuredClone(envelope);
  iv.cipher.iv = (iv.cipher.iv[0] === 'A' ? 'B' : 'A') + iv.cipher.iv.slice(1);
  await assert.rejects(openVault('123456', iv));
  const metadata = structuredClone(envelope);
  metadata.unlocks.pin.kdf.iterations++;
  await assert.rejects(openVault('123456', metadata));
  const removed = structuredClone(envelope);
  delete removed.unlocks.pattern;
  await assert.rejects(openVault('123456', removed), /PIN 不正确/);
  const swapped = structuredClone(envelope);
  swapped.unlocks.pin = envelope.unlocks.pattern!;
  await assert.rejects(openVault(pattern, swapped));
});
test('either credential opens exactly the same random data key and account data', async () => {
  const created = await createVault('123456', data);
  const envelope = await setPattern(data, created.key, created.envelope, pattern);
  assert.ok(hasPattern(envelope));
  assert.notEqual(envelope.unlocks.pin.kdf.salt, envelope.unlocks.pattern!.kdf.salt);
  const pinOpen = await openVault('123456', envelope);
  const patternOpen = await openVault(pattern, envelope, 'pattern');
  assert.deepEqual(pinOpen.data, data);
  assert.deepEqual(patternOpen.data, data);
  assert.deepEqual(await crypto.subtle.exportKey('raw', pinOpen.key), await crypto.subtle.exportKey('raw', patternOpen.key));
  const updated: VaultData = { version: 1, accounts: [{ ...data.accounts[0], name: 'renamed' }] };
  const saved = await sealVault(updated, patternOpen.key, patternOpen.envelope);
  assert.notEqual(saved.cipher.iv, envelope.cipher.iv);
  assert.deepEqual(saved.unlocks, envelope.unlocks);
  assert.deepEqual((await openVault('123456', saved)).data, updated);
  assert.deepEqual((await openVault(pattern, saved, 'pattern')).data, updated);
});
test('changing PIN preserves pattern; changing or disabling pattern preserves PIN', async () => {
  const created = await createVault('123456', data);
  const dual = await setPattern(data, created.key, created.envelope, pattern);
  const pinChanged = await changePin(data, created.key, dual, '987654');
  assert.notEqual(pinChanged.unlocks.pin.kdf.salt, dual.unlocks.pin.kdf.salt);
  assert.deepEqual(pinChanged.unlocks.pattern, dual.unlocks.pattern);
  await assert.rejects(openVault('123456', pinChanged));
  assert.deepEqual((await openVault('987654', pinChanged)).data, data);
  assert.deepEqual((await openVault(pattern, pinChanged, 'pattern')).data, data);
  const patternChanged = await setPattern(data, created.key, pinChanged, '12369');
  await assert.rejects(openVault(pattern, patternChanged, 'pattern'));
  assert.deepEqual((await openVault('12369', patternChanged, 'pattern')).data, data);
  assert.deepEqual((await openVault('987654', patternChanged)).data, data);
  const disabled = await setPattern(data, created.key, patternChanged, null);
  assert.equal(hasPattern(disabled), false);
  await assert.rejects(openVault('12369', disabled, 'pattern'), /尚未设置/);
  assert.deepEqual((await openVault('987654', disabled)).data, data);
});
test('backups restore with either credential, preserve slots and authenticate normalized metadata', async () => {
  const created = await createVault('123456', data);
  const dual = await setPattern(data, created.key, created.envelope, pattern);
  const backup = parseBackup(JSON.stringify(dual));
  for (const [credential, method] of [['123456', 'pin'], [pattern, 'pattern']] as const) {
    const opened = await openVault(credential, backup, method);
    const restored = await sealVault(opened.data, opened.key, opened.envelope);
    assert.notEqual(restored.cipher.iv, dual.cipher.iv);
    assert.deepEqual(restored.unlocks, dual.unlocks);
    assert.deepEqual((await openVault('123456', restored)).data, data);
    assert.deepEqual((await openVault(pattern, restored, 'pattern')).data, data);
  }
  const reordered = { ...dual, unlocks: { pattern: dual.unlocks.pattern, pin: dual.unlocks.pin } };
  assert.deepEqual((await openVault('123456', JSON.parse(JSON.stringify(reordered)))).data, data);
});
test('existing v1 ciphertext and backups migrate without modifying their original bytes', async () => {
  const text = readFileSync(new URL('./fixtures/vault-v1.json', import.meta.url), 'utf8');
  const legacy = parseBackup(text);
  assert.equal(legacy.version, 1);
  const original = JSON.stringify(legacy);
  await assert.rejects(openVault('999999', legacy));
  await assert.rejects(openVault(pattern, legacy, 'pattern'), /旧版/);
  const opened = await openVault('123456', legacy);
  assert.equal(opened.envelope.version, 2);
  assert.equal(opened.data.accounts[0].name, 'legacy@example.com');
  assert.equal(JSON.stringify(legacy), original);
  assert.deepEqual((await openVault('123456', opened.envelope)).data, opened.data);
  const dual = await setPattern(opened.data, opened.key, opened.envelope, pattern);
  assert.deepEqual((await openVault(pattern, dual, 'pattern')).data, opened.data);
});
test('malformed backups and unbounded KDF work fail before attempting decryption', async () => {
  const { envelope } = await createVault('123456');
  const slot = envelope.unlocks.pin;
  for (const invalid of [null, {}, { ...envelope, version: 9 }, { ...envelope, cipher: { name: 'AES-CBC', iv: envelope.cipher.iv } }, { ...envelope, unlocks: {} }, ...[1, 1000000000].map(iterations => ({ ...envelope, unlocks: { pin: { ...slot, kdf: { ...slot.kdf, iterations } } } })), { ...envelope, unlocks: { pin: { ...slot, ciphertext: 'AAAA' } } }]) assert.throws(() => validateEnvelope(invalid));
  assert.throws(() => parseBackup('{broken'));
  assert.throws(() => parseBackup(' '.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(createVault('12345'));
  await assert.rejects(createVault('abcdef'));
});
test('reject corrupted account data, duplicate IDs and unsupported OTP parameters', () => {
  assert.throws(() => validateData({ version: 2, accounts: [] }));
  assert.throws(() => validateData({ ...data, accounts: [data.accounts[0], data.accounts[0]] }));
  for (const patch of [{ name: '' }, { issuer: 'x'.repeat(129) }, { secret: 'NOT1BASE32' }, { digits: 7 }, { period: 0 }, { id: '<script>' }]) assert.throws(() => validateData({ ...data, accounts: [{ ...data.accounts[0], ...patch }] }));
});
