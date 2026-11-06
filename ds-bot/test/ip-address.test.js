import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeIpAddress } from '../src/shared/ip-address.js'

test('contact addresses canonicalize literal IPv4/IPv6 and valid ports without guessing IPv6 ports or resolving hostnames', () => {
  for (const [input, output] of [
    [' 192.0.2.1 ', '192.0.2.1'], ['192.0.2.1:3190', '192.0.2.1'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'], ['[2001:db8::1]:65535', '2001:db8::1'], ['[::1]', '::1'],
    ['2001:db8::1:3190', '2001:db8::1:3190'], ['::ffff:192.0.2.1', '192.0.2.1'], ['[::ffff:c000:201]:80', '192.0.2.1'],
  ]) assert.equal(normalizeIpAddress(input), output, input)
  for (const input of [undefined, {}, '', 'localhost', 'example.com:80', 'https://192.0.2.1', '127.1', '0x7f000001', '192.000.2.1',
    '192.0.2.256', '192.0.2.1:0', '192.0.2.1:65536', '[::1]:-1', '[::1]:abc', '[192.0.2.1]:80', 'fe80::1%eth0', ':::', '192.0.2.1\nother']) {
    assert.equal(normalizeIpAddress(input), null, String(input))
  }
})
