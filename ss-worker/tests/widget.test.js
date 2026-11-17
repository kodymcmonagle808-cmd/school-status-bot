import test from 'node:test';
import assert from 'node:assert/strict';
import { runWidgetCommand } from '../src/commands.js';
import { handleInteraction } from '../src/interactions.js';

test('runWidgetCommand returns guide with API url and Scriptable snippet', () => {
  const env = { PUBLIC_BASE_URL: 'https://test-worker.dev' };
  const res = runWidgetCommand(env);
  assert.ok(res.embeds);
  assert.equal(res.embeds.length, 1);
  const embed = res.embeds[0];
  assert.ok(embed.title.includes('iOS / iPhone Live School Status Widget Setup'));
  assert.ok(embed.description.includes('https://test-worker.dev/api/status'));
  assert.ok(embed.description.includes('Apple Shortcuts'));
  assert.ok(embed.description.includes('Scriptable'));
  assert.ok(embed.description.includes('Widgy'));
});

test('handleInteraction routes /widget command correctly', async () => {
  const body = {
    type: 2,
    data: { name: 'widget' }
  };
  const env = {
    PUBLIC_BASE_URL: 'https://status-bot.example.com',
    STATUS_KV: { get: async () => null }
  };
  const res = await handleInteraction(body, env, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.type, 4); // CHANNEL_MESSAGE_WITH_SOURCE
  assert.ok(data.data.embeds);
  assert.ok(data.data.embeds[0].description.includes('https://status-bot.example.com/api/status'));
});
