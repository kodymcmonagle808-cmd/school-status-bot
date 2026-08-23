import { createWorker } from 'tesseract.js';
import fs from 'fs';

(async () => {
  const worker = await createWorker('eng');
  const ret = await worker.recognize('chsmap.png', {}, { tsv: true });
  const tsv = ret.data.tsv;
  
  const rooms = {};
  const lines = tsv.split('\n');
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 12) {
      const text = parts[11];
      const match = text.match(/^(\d{3}[A-Z]?|P-\d)$/);
      if (match) {
        const left = parseInt(parts[6]);
        const top = parseInt(parts[7]);
        const width = parseInt(parts[8]);
        const height = parseInt(parts[9]);
        rooms[match[1]] = {
          x: Math.round(left + width / 2),
          y: Math.round(top + height / 2)
        };
      }
    }
  }
  fs.writeFileSync('rooms.json', JSON.stringify(rooms, null, 2));
  console.log(`Found ${Object.keys(rooms).length} rooms.`);
  await worker.terminate();
})();
