const { StreamParser } = require('./_boot.js');

let PASS = 0, FAIL = 0;
const ok = (c, msg) => { if (c) { PASS++; console.log('  ok  ' + msg); } else { FAIL++; console.error('  FAIL ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const rgbOf = (str) => {
  const m = str.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(rg|RG)/i);
  return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : null;
};

(async () => {
  console.log('\n=== TEST 14: preservation of math rules, fraction bars & square roots ===');

  const tintCfg = {
    bgHex: '#18181b',
    textHex: '#f4f4f5',
    objHex: '#38bdf8',
    objMode: 'tint',
    objSaturation: 1,
    objBorderBrightness: 0.8
  };

  const run = (s) => new TextDecoder().decode(
    StreamParser.transformStreamBytes(new TextEncoder().encode(s), tintCfg).bytes
  ).trim();

  const textRgb = StreamParser.parseHex(tintCfg.textHex);
  const accentRgb = StreamParser.parseHex(tintCfg.objHex);

  // 1. Fraction bar drawn as thin filled rectangle: 100 500 45 0.5 re f
  const fractionStream = '0 g 100 500 45 0.5 re f';
  const fractionOut = run(fractionStream);
  const fractionCol = rgbOf(fractionOut);
  ok(fractionCol !== null, 'fraction rule remapped to valid color');
  ok(Math.abs(fractionCol[0] - textRgb.r) < 0.05 && Math.abs(fractionCol[2] - textRgb.b) < 0.05,
    `fraction bar matches text color (lum ~${fractionCol[0].toFixed(3)}) rather than accent (${accentRgb.r.toFixed(3)})`);
  ok(Math.abs(fractionCol[0] - accentRgb.r) > 0.3,
    'fraction bar is NOT tinted to object accent blue');

  // 2. Square root vinculum (overbar) drawn as thin rectangle: 120 520 60 0.4 re f
  const sqrtStream = '0 g 120 520 60 0.4 re f';
  const sqrtOut = run(sqrtStream);
  const sqrtCol = rgbOf(sqrtOut);
  ok(Math.abs(sqrtCol[0] - textRgb.r) < 0.05,
    `square root vinculum matches text color (${sqrtCol[0].toFixed(3)} vs text ${textRgb.r.toFixed(3)})`);

  // 3. Horizontal line stroke fraction bar: 0 G 0.5 w 100 500 m 150 500 l S
  const strokeFracStream = '0 G 0.5 w 100 500 m 150 500 l S';
  const strokeFracOut = run(strokeFracStream);
  const strokeFracCol = rgbOf(strokeFracOut);
  ok(Math.abs(strokeFracCol[0] - textRgb.r) < 0.05,
    `stroke fraction bar matches text color (${strokeFracCol[0].toFixed(3)})`);

  // 4. Genuine vector object: chart bar (40x80 rectangle): 0 g 100 100 40 80 re f
  const chartBarStream = '0 g 100 100 40 80 re f';
  const chartBarOut = run(chartBarStream);
  const chartBarCol = rgbOf(chartBarOut);
  ok(Math.abs(chartBarCol[0] - accentRgb.r) < 0.02 && Math.abs(chartBarCol[2] - accentRgb.b) < 0.02,
    `genuine vector object (chart bar) IS tinted to accent in tint mode (${chartBarCol})`);

  // 5. Genuine vector art: diagonal diagram stroke: 0 G 0 0 m 10 10 l S
  const diagStream = '0 G 0 0 m 10 10 l S';
  const diagOut = run(diagStream);
  const diagCol = rgbOf(diagOut);
  ok(Math.abs(diagCol[0] - accentRgb.r) < 0.02,
    `genuine diagonal diagram stroke IS tinted to accent (${diagCol})`);

  console.log(`\n${FAIL ? '\x1b[31m' : '\x1b[32m'}${PASS} passed, ${FAIL} failed\x1b[0m\n`);
  if (FAIL) process.exitCode = 1;
})();
