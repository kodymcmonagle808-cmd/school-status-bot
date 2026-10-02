const fs = require('fs');

let code = fs.readFileSync('hcpss-worker/src/interactions.js', 'utf8');

// Replace the synchronous ownerpanel handler with a deferred one
const oldHandler = `    if (name === 'ownerpanel') {\r\n      const ownerId = String(env.OWNER_ID || '').trim();\r\n      const invokerId = getInvokerId(body);\r\n      if (!ownerId || invokerId !== ownerId) {\r\n        return interactionResponse({ content: '\\u{1F512} Only the bot owner can use this command.', flags: EPHEMERAL_FLAG });\r\n      }\r\n      const ownerPayload = await buildWorkerUpdatesPayload(env);\r\n      return interactionResponse({ ...ownerPayload, flags: EPHEMERAL_FLAG });\r\n    }`;

const newHandler = `    if (name === 'ownerpanel') {\r\n      const ownerId = String(env.OWNER_ID || '').trim();\r\n      const invokerId = getInvokerId(body);\r\n      if (!ownerId || invokerId !== ownerId) {\r\n        return interactionResponse({ content: '\\u{1F512} Only the bot owner can use this command.', flags: EPHEMERAL_FLAG });\r\n      }\r\n      ctx.waitUntil((async () => {\r\n        try {\r\n          const ownerPayload = await buildWorkerUpdatesPayload(env);\r\n          await updateInteractionOriginal(env, body.token, { ...ownerPayload });\r\n        } catch (e) {\r\n          console.error('ownerpanel deferred render failed:', e);\r\n          await updateInteractionOriginal(env, body.token, { content: '\\u274C Failed to load owner panel: ' + e.message });\r\n        }\r\n      })());\r\n      return deferredInteractionResponse(true);\r\n    }`;

code = code.replace(oldHandler, newHandler);

fs.writeFileSync('hcpss-worker/src/interactions.js', code, 'utf8');
console.log("Made ownerpanel deferred");
