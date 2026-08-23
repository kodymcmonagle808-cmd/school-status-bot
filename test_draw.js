const fs = require('fs');
const { PNG } = require('pngjs');

const data = fs.readFileSync('chsmap.png');
const png = PNG.sync.read(data);

// Draw a red line from (100, 100) to (500, 500)
const x0 = 100, y0 = 100, x1 = 500, y1 = 500;
const dx = Math.abs(x1 - x0);
const dy = Math.abs(y1 - y0);
const sx = (x0 < x1) ? 1 : -1;
const sy = (y0 < y1) ? 1 : -1;
let err = dx - dy;

let currX = x0, currY = y0;
while (true) {
  // draw 5x5 brush
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

  if ((currX === x1) && (currY === y1)) break;
  const e2 = 2 * err;
  if (e2 > -dy) { err -= dy; currX += sx; }
  if (e2 < dx) { err += dx; currY += sy; }
}

const out = PNG.sync.write(png);
fs.writeFileSync('out.png', out);
console.log('Done!');
