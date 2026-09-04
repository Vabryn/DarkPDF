/* Node bootstrap: expose vendored libs + app modules on a fake window. */
const path = require('path');
const vm = require('vm');
const fs = require('fs');

const PDFLib = require('../js/vendor/pdf-lib.min.js');
const pako = require('../js/vendor/pako.min.js');

global.window = global;
global.window.PDFLib = PDFLib;
global.window.pako = pako;

// load stream-parser.js (browser IIFE that assigns window.StreamParser)
const sp = fs.readFileSync(path.join(__dirname, '../js/stream-parser.js'), 'utf8');
vm.runInThisContext(sp, { filename: 'stream-parser.js' });
const cv = fs.readFileSync(path.join(__dirname, '../js/converter.js'), 'utf8');
vm.runInThisContext(cv, { filename: 'converter.js' });

module.exports = { PDFLib, pako, StreamParser: global.window.StreamParser, PDFConverter: global.window.PDFConverter };

// ---- tiny assert helpers
let PASS = 0, FAIL = 0;
global.ok = (cond, msg) => { if (cond) { PASS++; console.log('  \x1b[32mok\x1b[0m  ' + msg); } else { FAIL++; console.log('  \x1b[31mFAIL\x1b[0m ' + msg); } };
global.eq = (a, b, msg) => global.ok(a === b, `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
global.near = (a, b, tol, msg) => global.ok(Math.abs(a - b) <= tol, `${msg}  (got ${a}, want ~${b})`);
global.summary = () => { console.log(`\n${FAIL ? '\x1b[31m' : '\x1b[32m'}${PASS} passed, ${FAIL} failed\x1b[0m`); process.exitCode = FAIL ? 1 : 0; };
