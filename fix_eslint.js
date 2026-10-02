const fs = require('fs');

let code = fs.readFileSync('hcpss-worker/src/panelcomponents.js', 'utf8');

// replace the dynamic import with nothing, we'll put static import at top
code = code.replace("      const { getKvUsage, KV_FREE_LIMITS } = await import('./kvanalytics.js');", "");

// add static import at the top
const importStatement = "import { getKvUsage, KV_FREE_LIMITS } from './kvanalytics.js';\n";
code = importStatement + code;

fs.writeFileSync('hcpss-worker/src/panelcomponents.js', code, 'utf8');
console.log("Fixed imports");
