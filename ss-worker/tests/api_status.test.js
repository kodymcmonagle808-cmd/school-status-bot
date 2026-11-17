import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

test('GET /api/status returns JSON payload with CORS and cache headers', async () => {
  const req = new Request('https://worker.local/api/status');
  const env = {
    STATUS_KV: {
      get: async (k) => {
        if (k === 'status_cards_cache') {
          return JSON.stringify([{ status: 'Normal Operations', statusKey: 'normal_operations', date: '2026-11-16' }]);
        }
        return null;
      }
    }
  };

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');

  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.district, 'hcpss');
  assert.equal(data.statusText, 'Normal Operations');
  assert.ok(data.timestamp);
});

test('GET /status.json is an alias for /api/status', async () => {
  const req = new Request('https://worker.local/status.json');
  const env = {
    STATUS_KV: {
      get: async () => null
    }
  };

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.district, 'hcpss');
});

test('GET /api/status?district=bcps specifies district', async () => {
  const req = new Request('https://worker.local/api/status?district=bcps');
  const env = {
    STATUS_KV: {
      get: async () => null
    }
  };

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.district, 'bcps');
  assert.equal(data.districtName, 'Baltimore Co.');
});
