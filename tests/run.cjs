const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const files = fs.readdirSync(__dirname).filter(n => /^t\d.*\.(?:js|cjs)$/.test(n) || n === 'size_calibration.js').sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
files.push('browser.cjs');
let failed=0;
for (const file of files) {
  const result=spawnSync(process.execPath,[path.join(__dirname,file)],{encoding:'utf8',timeout:120000});
  if (result.status !== 0) {failed++;console.error('FAIL',file,result.error?.message || '',result.stdout,result.stderr);}
  else console.log('PASS',file);
}
console.log(`${files.length-failed}/${files.length} suites passed`);
process.exitCode=failed?1:0;
