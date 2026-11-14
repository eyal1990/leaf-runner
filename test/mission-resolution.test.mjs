import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, ApiError } from '../prove2me.mjs';
import { findTarget } from '../work-selection.mjs';

// Synthetic mission data; keep Unicode, spaces, and parentheses for URL coverage.
const mission = { id: '11111111-1111-4111-8111-111111111111',
  name: 'Example π mission (demo)', main_theorem: { theorem_id: 'root' } };
const slug = 'Example_π_mission_(demo)';
const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function clientFor(fetcher) {
  const client = new Client('test-key', fetcher);
  client.token = 'test-token'; client.expiry = Date.now() + 3600000;
  return client;
}

test('plain and encoded mission names and URLs resolve through one filtered GET', async t => {
  for (const input of [mission.name, mission.name.replace('π', '%CF%80'), encodeURIComponent(mission.name),
    'https://prove2.me/missions/' + slug,
    'https://prove2.me/missions/' + encodeURIComponent(slug),
    'https://prove2.me/missions/' + encodeURIComponent(slug) + '/?view=graph#theorem',
    encodeURIComponent('https://prove2.me/missions/' + slug)]) {
    await t.test(input, async () => {
      const calls = [];
      const client = clientFor(async url => {
        calls.push(url.href);
        assert.equal(url.pathname, '/api/v1/missions');
        assert.equal(url.searchParams.get('name'), mission.name);
        assert.equal(url.searchParams.get('limit'), '1');
        assert.equal(url.searchParams.get('offset'), '0');
        return response({ missions: [mission], total: 1 });
      });
      const found = await findTarget(client, input);
      assert.equal(found.mission.id, mission.id);
      assert.equal(found.root, 'root');
      assert.equal(calls.length, 1, 'must not fetch the catalog, mission detail, or milestones');
    });
  }
});

test('mission URL and encoded name scope milestone discovery to the resolved ID', async () => {
  for (const input of ['https://prove2.me/missions/' + encodeURIComponent(slug), encodeURIComponent(mission.name)]) {
    const paths = [];
    const client = clientFor(async url => {
      paths.push(url.pathname);
      if (url.pathname === '/api/v1/missions') {
        assert.equal(url.searchParams.get('name'), mission.name);
        assert.equal(url.searchParams.get('limit'), '1');
        return response({ missions: [mission], total: 1 });
      }
      assert.equal(url.pathname, `/api/v1/missions/${mission.id}/milestones`);
      return response({ milestones: [{ id: 'milestone', title: 'Bound', theorem: { id: 'bound' } }], total: 1 });
    });
    assert.equal((await findTarget(client, 'Bound', { kind: 'milestone', mission: input })).root, 'bound');
    assert.equal(paths.length, 2);
  }
});

test('filtered pagination preserves ambiguity without scanning unrelated missions', async () => {
  const offsets = [];
  const client = clientFor(async url => {
    assert.equal(url.searchParams.get('name'), mission.name);
    assert.equal(url.searchParams.get('limit'), '1');
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return response({ missions: [{ ...mission, id: `match-${offset}` }], total: 2 });
  });
  await assert.rejects(findTarget(client, mission.name, { kind: 'mission' }), /Ambiguous target/);
  assert.deepEqual(offsets, [0, 1]);
});

test('missing names, failed requests, and invalid filtered responses never fall back to catalog', async () => {
  for (const input of [mission.name, 'https://prove2.me/missions/' + encodeURIComponent(slug)]) {
    for (const failure of ['missing', 'invalid', 'forbidden']) {
      let calls = 0;
      const client = clientFor(async url => {
        calls++;
        assert.equal(url.searchParams.get('name'), mission.name);
        if (failure === 'forbidden') return new Response('{}', { status: 403 });
        return response(failure === 'missing' ? { missions: [], total: 0 } : { missions: null, total: 1 });
      });
      await assert.rejects(findTarget(client, input, { kind: 'mission' }),
        failure === 'forbidden' ? error => error instanceof ApiError && error.status === 403
          : failure === 'missing' ? /No mission or milestone matches/ : /Invalid missions pagination/);
      assert.equal(calls, 1);
    }
  }
});

test('mission names preserve literal plus, percent, and encoded underscores', async () => {
  for (const [input, name] of [['C++ is 100% useful', 'C++ is 100% useful'],
    ['https://prove2.me/missions/A%5FB_%2B_C', 'A_B + C'],
    [encodeURIComponent('A/B? x & y #π'), 'A/B? x & y #π']]) {
    const client = clientFor(async url => {
      assert.equal(url.searchParams.get('name'), name);
      return response({ missions: [{ ...mission, name }], total: 1 });
    });
    assert.equal((await findTarget(client, input, { kind: 'mission' })).name, name);
  }
});

test('invalid mission URLs fail before requests', async () => {
  const client = clientFor(() => assert.fail('invalid URL must not make requests'));
  for (const url of ['https://other.example/missions/Target', 'https://prove2.me/missions/',
    'https://prove2.me/missions/Target/extra', 'http://prove2.me/missions/Target']) {
    await assert.rejects(findTarget(client, url), /Expected a https:\/\/prove2.me\/missions\/<name> URL/);
  }
});
