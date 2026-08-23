/* global FormData, Blob */
import { EPHEMERAL_FLAG } from './constants.js';
import { interactionResponse, deferredInteractionResponse, getCommandOption, getInvokerId } from './discord.js';
import { chsmapBase64 } from './mapAsset.js';
import { rooms } from './roomsData.js';
import { Buffer } from 'node:buffer';
import pkg from 'pngjs';
const { PNG } = pkg;

export async function handleSetupClasses(body, env) {
  const userId = getInvokerId(body);
  const p1 = getCommandOption(body, 'p1');
  const p2 = getCommandOption(body, 'p2');
  const p3 = getCommandOption(body, 'p3');
  const p4a = getCommandOption(body, 'p4a');
  const p4b = getCommandOption(body, 'p4b');
  const p5 = getCommandOption(body, 'p5');
  const p6 = getCommandOption(body, 'p6');
  const lunch = getCommandOption(body, 'lunch');

  const schedule = { p1, p2, p3, p4a, p4b, p5, p6, lunch };
  
  await env.STATUS_KV.put(`schedule:${userId}`, JSON.stringify(schedule));

  return interactionResponse({
    content: `✅ Your schedule has been saved! You can now use \`/mapmyclass [day]\` to see your route.`,
    flags: EPHEMERAL_FLAG
  });
}

function drawLine(png, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = (x0 < x1) ? 1 : -1;
  const sy = (y0 < y1) ? 1 : -1;
  let err = dx - dy;

  let currX = x0, currY = y0;
  while (true) {
    // 5x5 brush
    for (let bx = -2; bx <= 2; bx++) {
      for (let by = -2; by <= 2; by++) {
        const px = currX + bx;
        const py = currY + by;
        if (px >= 0 && px < png.width && py >= 0 && py < png.height) {
          const idx = (png.width * py + px) << 2;
          png.data[idx] = 255;   // R
          png.data[idx+1] = 0;   // G
          png.data[idx+2] = 0;   // B
          png.data[idx+3] = 255; // A
        }
      }
    }

    if (currX === x1 && currY === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; currX += sx; }
    if (e2 < dx) { err += dx; currY += sy; }
  }
}

export async function handleMapMyClass(body, env) {
  const userId = getInvokerId(body);
  const day = getCommandOption(body, 'day');

  const scheduleRaw = await env.STATUS_KV.get(`schedule:${userId}`);
  if (!scheduleRaw) {
    return interactionResponse({
      content: `❌ I don't have your schedule yet. Please run \`/setupclasses\` first!`,
      flags: EPHEMERAL_FLAG
    });
  }

  const schedule = JSON.parse(scheduleRaw);

  let sequence = [];
  if (day === 'A') {
    sequence = [schedule.p1, schedule.p2, "Lunch", schedule.p3, schedule.p4a];
  } else {
    sequence = [schedule.p4b, schedule.p5, "Lunch", schedule.p6];
  }

  // Find coordinates for the rooms
  const pts = [];
  for (let r of sequence) {
    if (r.toLowerCase() === 'lunch') {
      // Use cafeteria coordinates
      if (rooms['903']) pts.push(rooms['903']);
      else if (rooms['Cafeteria']) pts.push(rooms['Cafeteria']);
      continue;
    }
    const rmMatch = r.replace(/[^0-9A-Za-z-]/g, '').toUpperCase();
    if (rooms[rmMatch]) {
      pts.push(rooms[rmMatch]);
    }
  }

  const routeStr = sequence.join(' ➔ ');

  // Parse PNG and draw lines
  let pngBuffer;
  try {
    const rawMap = Uint8Array.from(atob(chsmapBase64), c => c.charCodeAt(0));
    // Since PNG.sync.read expects a Buffer, in Cloudflare Workers we might need a polyfill
    // or just pass Uint8Array if pngjs supports it (pngjs v7 does support Uint8Array).
    const png = PNG.sync.read(Buffer.from(rawMap));

    if (pts.length > 1) {
      for (let i = 0; i < pts.length - 1; i++) {
        drawLine(png, pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y);
      }
    }

    pngBuffer = PNG.sync.write(png);
  } catch (e) {
    return interactionResponse({
      content: `❌ Error generating map: ${e.message}`,
      flags: EPHEMERAL_FLAG
    });
  }

  // Construct multipart payload to send the file via Discord webhook
  const applicationId = env.DISCORD_APPLICATION_ID;
  const interactionToken = body.token;
  
  const payload = {
    embeds: [{
      title: `${day} Day Route`,
      description: `**Your Route:**\n${routeStr}\n\n*Note: Map lines are drawn straight between known room locations.*`,
      color: 0x3498db,
      image: { url: 'attachment://route.png' }
    }],
    attachments: [{
      id: 0,
      description: "Map with drawn route",
      filename: "route.png"
    }]
  };

  const formData = new FormData();
  formData.append('payload_json', JSON.stringify(payload));
  formData.append('files[0]', new Blob([pngBuffer], { type: 'image/png' }), 'route.png');

  // Do this async to not block the interaction response
  env.ctx.waitUntil(
    fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
      method: 'PATCH',
      body: formData
    })
  );

  return deferredInteractionResponse();
}
