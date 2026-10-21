import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeAt, decodeBase32, normalizeSecret, parseInput, prepareKey, remaining, type Algorithm } from '../src/totp.ts';

function encodeAscii(input: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of new TextEncoder().encode(input)) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) output += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return output;
}
const vectors = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
] as const;
for (const [index, algorithm] of (['SHA1', 'SHA256', 'SHA512'] as Algorithm[]).entries()) {
  test(`RFC 6238 Appendix B: all ${algorithm} vectors, including times after 2038`, async () => {
    const ascii = '1234567890123456789012345678901234567890123456789012345678901234'.slice(0, [20, 32, 64][index]);
    const parameters = { secret: encodeAscii(ascii), algorithm, digits: 8 as const, period: 30 };
    const key = await prepareKey(parameters);
    for (const vector of vectors) assert.equal(await codeAt(key, parameters, vector[0] * 1000), vector[index + 1]);
  });
}
test('RFC 4226 six-digit counter sequence and exact time boundaries', async () => {
  const parameters = { secret: encodeAscii('12345678901234567890'), algorithm: 'SHA1' as const, digits: 6 as const, period: 30 };
  const key = await prepareKey(parameters);
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let i = 0; i < expected.length; i++) assert.equal(await codeAt(key, parameters, i * 30000), expected[i]);
  assert.equal(await codeAt(key, parameters, 29999), expected[0]);
  assert.equal(await codeAt(key, parameters, 30000), expected[1]);
  assert.equal(remaining(30, 29999), 1);
  assert.equal(remaining(30, 30000), 30);
  await assert.rejects(codeAt(key, parameters, -1));
});
test('Base32 is case-insensitive, supports padding and rejects ambiguous/truncated keys', () => {
  assert.equal(normalizeSecret(' jbsw y3dp-ehpk3pxp\n'), 'JBSWY3DPEHPK3PXP');
  assert.equal(new TextDecoder().decode(decodeBase32('MZXW6===')), 'foo');
  assert.equal(normalizeSecret('MY======'), 'MY');
  for (const bad of ['', 'A', 'AAA', 'AAAAAA', 'JBSWY3DP0HPK3PXP', 'MZ', 'MY=', 'MY=======', 'M=Y', '你好']) assert.throws(() => normalizeSecret(bad), bad);
});
test('otpauth URI preserves label, issuer and non-default parameters', () => {
  const parsed = parseInput('otpauth://totp/Example%3Awork%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60');
  assert.deepEqual(parsed, { secret: 'JBSWY3DPEHPK3PXP', issuer: 'Example', name: 'work@example.com', algorithm: 'SHA256', digits: 8, period: 60 });
  assert.equal(parseInput('otpauth://totp/GitHub:alice?secret=MY').issuer, 'GitHub');
  assert.equal(parseInput('JBSWY3DPEHPK3PXP').period, 30);
});
test('unsupported or ambiguous URI parameters fail rather than silently generating incorrect codes', () => {
  for (const uri of [
    'otpauth://hotp/a?secret=MY&counter=0',
    'otpauth://totp/a?secret=MY&digits=7',
    'otpauth://totp/a?secret=MY&algorithm=MD5',
    'otpauth://totp/a?secret=MY&period=0',
    'otpauth://totp/a?secret=MY&period=1.5',
    'otpauth://totp/a?secret=MY&secret=MA',
    'otpauth://totp/a?secret=MY&digits=6&digits=8',
    'otpauth://totp/%ZZ?secret=MY',
    'otpauth://totp/a?secret=MY#extra',
    'otpauth://totp/a?issuer=Example',
  ]) assert.throws(() => parseInput(uri), uri);
});
