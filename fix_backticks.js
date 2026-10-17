const fs = require('fs');

let code = fs.readFileSync('ss-worker/src/commands.js', 'utf8');

code = code.replace(
  '```\n${webhookUrl}\n```',
  '\\`\\`\\`\n${webhookUrl}\n\\`\\`\\`'
);

code = code.replace(
  '```json\n{\n  "author":',
  '\\`\\`\\`json\n{\n  "author":'
);

code = code.replace(
  '"image": "{{picture}}"\n}\n```\n8. Turn it',
  '"image": "{{picture}}"\n}\n\\`\\`\\`\n8. Turn it'
);

fs.writeFileSync('ss-worker/src/commands.js', code, 'utf8');
console.log("Fixed backticks");
