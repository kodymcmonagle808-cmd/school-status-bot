/* global FormData, Blob */
import { EPHEMERAL_FLAG } from './constants.js';
import { interactionResponse, deferredInteractionResponse, getCommandOption, getInvokerId } from './discord.js';
import { chsmapBase64 } from './mapAsset.js';
import { graph } from './graphData.js';
import { findPath } from './pathfinding.js';
import UPNG from 'upng-js';

export async function handleSetupClasses(body, env) {
  const userId = getInvokerId(body);
  const options = body.data?.options || [];
  const p1 = getCommandOption(options, 'p1');
  const p2 = getCommandOption(options, 'p2');
  const p3 = getCommandOption(options, 'p3');
  const p4a = getCommandOption(options, 'p4a');
  const p4b = getCommandOption(options, 'p4b');
  const p5 = getCommandOption(options, 'p5');
  const p6 = getCommandOption(options, 'p6');
  const lunch_a = getCommandOption(options, 'lunch_a');
  const lunch_b = getCommandOption(options, 'lunch_b');

  const schedule = { p1, p2, p3, p4a, p4b, p5, p6, lunch_a, lunch_b };
  
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
  const options = body.data?.options || [];
  const day = getCommandOption(options, 'day');

  const scheduleRaw = await env.STATUS_KV.get(`schedule:${userId}`);
  if (!scheduleRaw) {
    return interactionResponse({
      content: `❌ I don't have your schedule yet. Please run \`/setupclasses\` first!`,
      flags: EPHEMERAL_FLAG
    });
  }

  // Do this async to not block the interaction response
  env.ctx.waitUntil((async () => {
    try {
      const schedule = JSON.parse(scheduleRaw);

      let sequence = [];
      let lunchPeriod = 'Unknown';
      if (day === 'A') {
        lunchPeriod = schedule.lunch_a || schedule.lunch || 'Unknown';
        sequence = [schedule.p1, schedule.p2, `Lunch (${lunchPeriod})`, schedule.p3, schedule.p4a];
      } else {
        lunchPeriod = schedule.lunch_b || schedule.lunch || 'Unknown';
        sequence = [schedule.p4b, schedule.p5, `Lunch (${lunchPeriod})`, schedule.p6];
      }

      // Find coordinates for the rooms
      const pts = [];
      for (let r of sequence) {
        if (!r) continue;
        if (r.toLowerCase().includes('lunch')) {
          // Use cafeteria coordinates
          if (graph.roomMapping['903']) pts.push('903');
          else if (graph.roomMapping['Cafeteria']) pts.push('Cafeteria');
          continue;
        }
        const rmMatch = r.replace(/[^0-9A-Za-z-]/g, '').toUpperCase();
        let matchName = null;
        for (const k of Object.keys(graph.roomMapping)) {
            if (k.replace(/[^0-9A-Za-z-]/g, '').toUpperCase() === rmMatch) {
                matchName = k;
                break;
            }
        }
        if (matchName) {
            pts.push(matchName);
        } else if (graph.roomMapping[rmMatch]) {
            pts.push(rmMatch);
        }
      }

      const routeStr = sequence.filter(Boolean).join(' ➔ ');

      const rawMap = Uint8Array.from(atob(chsmapBase64), c => c.charCodeAt(0));
      const img = UPNG.decode(rawMap.buffer);
      const rgba = UPNG.toRGBA8(img)[0];
      const imageObj = {
        width: img.width,
        height: img.height,
        data: new Uint8Array(rgba)
      };

      if (pts.length > 1) {
        // Transform coordinates from chsmap.github.io graph to the chsmap.png image
        const transformX = x => x * 0.89005 + 11.225;
        const transformY = y => y * 0.88835 - 12.277;

        for (let i = 0; i < pts.length - 1; i++) {
          const path = findPath(graph, pts[i], pts[i+1]);
          if (path && path.length > 1) {
            for (let j = 0; j < path.length - 1; j++) {
              drawLine(imageObj, 
                Math.round(transformX(path[j].x)), Math.round(transformY(path[j].y)), 
                Math.round(transformX(path[j+1].x)), Math.round(transformY(path[j+1].y))
              );
            }
          } else {
            const startId = graph.roomMapping[pts[i]];
            const endId = graph.roomMapping[pts[i+1]];
            if (startId && endId) {
              drawLine(imageObj, 
                Math.round(transformX(graph.nodes[startId].x)), Math.round(transformY(graph.nodes[startId].y)), 
                Math.round(transformX(graph.nodes[endId].x)), Math.round(transformY(graph.nodes[endId].y))
              );
            }
          }
        }
      }

      const encoded = UPNG.encode([imageObj.data.buffer], imageObj.width, imageObj.height, 0);
      const pngBuffer = new Uint8Array(encoded);

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

      await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
        method: 'PATCH',
        body: formData
      });
    } catch (e) {
      const applicationId = env.DISCORD_APPLICATION_ID;
      const interactionToken = body.token;
      await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `❌ Error generating map: ${e.message}`
        })
      });
    }
  })());

  return deferredInteractionResponse();
}
