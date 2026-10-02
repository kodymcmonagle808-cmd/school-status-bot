const fs = require('fs');

let code = fs.readFileSync('hcpss-worker/src/interactions.js', 'utf8');

// Add import
code = code.replace(
  'runNotifyCommand,',
  'runNotifyCommand,\n  runSocialLinkCommand,'
);

// Add route
code = code.replace(
  "if (name === 'myschool') return interactionResponse(await runMySchoolCommand(body, env));",
  "if (name === 'myschool') return interactionResponse(await runMySchoolCommand(body, env));\n    if (name === 'social-link') return interactionResponse(await runSocialLinkCommand(body, env));"
);

fs.writeFileSync('hcpss-worker/src/interactions.js', code, 'utf8');
console.log("Added social-link to interactions.js");
