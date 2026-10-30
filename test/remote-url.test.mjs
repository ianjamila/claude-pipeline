import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemote } from '../pipeline/lib/remote-url.mjs';

test('repo identity is owner/name from the local origin URL in every common form', () => {
  for (const url of ['git@github.com:acme/widgets.git', 'https://github.com/acme/widgets', 'https://github.com/acme/widgets.git', 'ssh://git@github.com/acme/widgets.git', 'https://x-access-token:t@github.com/acme/widgets.git/']) {
    assert.equal(parseRemote(url)?.slug, 'acme/widgets', url);
  }
  assert.equal(parseRemote(''), null);
  assert.equal(parseRemote('garbage'), null);
});

test('parseRemote returns the host, owner and name as well as the slug', () => {
  assert.deepEqual(parseRemote('git@github.com:acme/widgets.git'), { host: 'github.com', owner: 'acme', name: 'widgets', slug: 'acme/widgets' });
  assert.equal(parseRemote('https://ghe.example.com/acme/widgets')?.host, 'ghe.example.com');
  assert.equal(parseRemote('https://github.com/widgets'), null);
});
