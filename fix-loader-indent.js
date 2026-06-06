const fs = require('fs');
const files = fs.readdirSync('.').filter(f => f.endsWith('.html'));
let fixed = 0;
for (const f of files) {
  const orig = fs.readFileSync(f, 'utf8');
  // Fix bare (unindented) loading.css link
  const updated = orig.split('\n').map(line => {
    if (line === '<link rel="stylesheet" href="loading.css">') {
      return '  <link rel="stylesheet" href="loading.css">';
    }
    return line;
  }).join('\n');
  if (updated !== orig) {
    fs.writeFileSync(f, updated, 'utf8');
    fixed++;
    console.log('Fixed: ' + f);
  }
}
console.log('Total fixed: ' + fixed);
