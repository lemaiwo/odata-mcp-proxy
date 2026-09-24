// Unit tests for response body decoding: raw bytes from the backend become
// parsed JSON, text, or a lossless base64 envelope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeResponseBody } from '../src/client/odata-client.js';

test('JSON content types (with parameters and +json suffixes) are parsed', () => {
  const body = Buffer.from('{"d":{"Name":"Grüße"}}', 'utf8');
  assert.deepEqual(decodeResponseBody(body, 'application/json;charset=utf-8'), { d: { Name: 'Grüße' } });
  assert.deepEqual(decodeResponseBody(body, 'application/scim+json'), { d: { Name: 'Grüße' } });
});

test('malformed JSON falls back to the raw text', () => {
  assert.equal(decodeResponseBody(Buffer.from('not json'), 'application/json'), 'not json');
});

test('valid UTF-8 is returned as text whatever the content type', () => {
  const xml = '<?xml version="1.0"?><root>ü</root>';
  assert.equal(decodeResponseBody(Buffer.from(xml, 'utf8'), 'application/xml'), xml);
  assert.equal(decodeResponseBody(Buffer.from('a=b'), 'application/octet-stream'), 'a=b');
  assert.equal(decodeResponseBody(Buffer.alloc(0), ''), '');
});

test('non-UTF-8 bodies become a base64 envelope that round-trips', () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x89, 0xff, 0x00, 0xc3]);
  const envelope = decodeResponseBody(bytes, 'application/zip') as Record<string, unknown>;
  assert.deepEqual(envelope, {
    contentType: 'application/zip',
    encoding: 'base64',
    size: bytes.length,
    data: bytes.toString('base64'),
  });
  assert.ok(Buffer.from(envelope.data as string, 'base64').equals(bytes));

  const untyped = decodeResponseBody(bytes, '') as Record<string, unknown>;
  assert.equal(untyped.contentType, 'application/octet-stream');
});

test('ArrayBuffer and typed-array bodies are decoded; other values pass through', () => {
  const view = new Uint8Array([0x00, 0x7b, 0x7d, 0x00]).subarray(1, 3);
  assert.deepEqual(decodeResponseBody(view, 'application/json'), {});
  assert.deepEqual(decodeResponseBody(view.slice().buffer, 'application/json'), {});
  assert.deepEqual(decodeResponseBody({ already: 'parsed' }, 'application/json'), { already: 'parsed' });
});
