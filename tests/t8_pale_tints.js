// TEST 8 — pale near-white/near-black tints must be treated as neutral (chroma, not HSL saturation).
const { StreamParser } = require('./_boot.js');

(async () => {
  console.log('\n=== TEST 8: pale tint neutrality + readability ===');
  const cfg = { bgHex: '#18181b', textHex: '#f4f4f5', objHex: '#38bdf8', objMode: 'adapt', objSaturation: 1, objBorderBrightness: 0.8 };
  const run = (s) => new TextDecoder().decode(StreamParser.transformStreamBytes(new TextEncoder().encode(s), cfg).bytes).trim();
  const rgbOf = (out) => { const m = out.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/); return [ +m[1], +m[2], +m[3] ]; };
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);

  // pale blue-white banner fill -> should become a DARK near-neutral, not saturated blue
  let c = rgbOf(run('0.92 0.95 1 rg 0 0 10 10 re f'));
  ok(lum(c) < 0.18, `pale banner fill -> dark ground (lum ${lum(c).toFixed(3)})`);
  ok(chroma(c) < 0.08, `pale banner fill stays near-neutral (chroma ${chroma(c).toFixed(3)})`);

  c = rgbOf(run('0.97 0.98 1 rg 0 0 10 10 re f'));
  ok(lum(c) < 0.18, `zebra row fill -> dark (lum ${lum(c).toFixed(3)})`);

  // near-black pale tint text -> should become light text
  c = rgbOf(run('BT 0.06 0.07 0.09 rg (x) Tj ET'));
  ok(lum(c) > 0.7, `near-black bluish body text -> light (lum ${lum(c).toFixed(3)})`);

  // genuinely saturated colours must STILL be treated as chromatic
  c = rgbOf(run('0.85 0.2 0.2 rg 0 0 10 10 re f'));
  ok(chroma(c) > 0.2, `saturated red object keeps chroma (${chroma(c).toFixed(3)})`);
  c = rgbOf(run('BT 0.1 0.3 0.75 rg (x) Tj ET'));
  ok(chroma(c) > 0.2 && lum(c) > 0.35, `blue link text stays blue & readable (chroma ${chroma(c).toFixed(3)}, lum ${lum(c).toFixed(3)})`);

  // white text on a coloured badge (light neutral, inside BT) -> must stay visibly light
  c = rgbOf(run('BT 1 1 1 rg (x) Tj ET'));
  ok(lum(c) > 0.55, `white badge text stays light (lum ${lum(c).toFixed(3)})`);

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
