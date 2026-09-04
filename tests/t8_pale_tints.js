// TEST 8 — pale near-white/near-black tints must be treated as neutral (chroma, not HSL saturation).
const { StreamParser } = require('./_boot.js');

(async () => {
  console.log('\n=== TEST 8: pale tint neutrality + readability ===');
  const cfg = { bgHex: '#18181b', textHex: '#f4f4f5', objHex: '#38bdf8', objMode: 'adapt', objSaturation: 1, objBorderBrightness: 0.8 };
  const run = (s) => new TextDecoder().decode(StreamParser.transformStreamBytes(new TextEncoder().encode(s), cfg).bytes).trim();
  const rgbOf = (out) => { const m = out.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+[rR][gG]/); return [ +m[1], +m[2], +m[3] ]; };
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

  // neutral STROKES (axis lines, thin borders) — a light-grey original used to
  // taper toward the low end of the "rules, dark shapes" range and nearly
  // vanish against a near-black background; must now clear a contrast floor.
  const bgLum = lum([0x18 / 255, 0x18 / 255, 0x1b / 255]);
  c = rgbOf(run('0.85 0.85 0.85 RG 0 0 m 10 10 l S'));
  ok(lum(c) - bgLum > 0.2, `light-grey axis-line stroke clears contrast floor (lum ${lum(c).toFixed(3)} vs bg ${bgLum.toFixed(3)})`);

  c = rgbOf(run('0.6 0.6 0.6 RG 0 0 m 10 10 l S'));
  ok(lum(c) - bgLum > 0.2, `mid-grey stroke stays clearly visible (lum ${lum(c).toFixed(3)})`);

  // solid near-black stroke should stay bold — the floor must not water it down
  c = rgbOf(run('0.02 0.02 0.02 RG 0 0 m 10 10 l S'));
  ok(lum(c) > 0.45, `near-black stroke stays bold, unaffected by the floor (lum ${lum(c).toFixed(3)})`);

  // "Unify Vectors to Accent" (objMode: 'tint') must also recolour black/grey
  // vector art (axis lines, diagram strokes) — previously only chromatic
  // content ever reached oc.rgb, so this mode had zero effect on line art.
  const tintCfg = { ...cfg, objMode: 'tint' };
  const runTint = (s) => new TextDecoder().decode(StreamParser.transformStreamBytes(new TextEncoder().encode(s), tintCfg).bytes).trim();
  const accent = StreamParser.parseHex(tintCfg.objHex);

  c = rgbOf(runTint('0.85 0.85 0.85 RG 0 0 m 10 10 l S'));
  ok(Math.abs(c[0] - accent.r) < 0.01 && Math.abs(c[2] - accent.b) < 0.01, `tint mode recolours a light-grey stroke to the accent (${c})`);

  c = rgbOf(runTint('0.02 0.02 0.02 RG 0 0 m 10 10 l S'));
  ok(Math.abs(c[0] - accent.r) < 0.01 && Math.abs(c[2] - accent.b) < 0.01, `tint mode recolours a near-black stroke to the accent (${c})`);

  // structural page chrome (background/zebra fills) stays bg-anchored even in
  // tint mode — "unify vectors" should not repaint the page surface itself
  c = rgbOf(runTint('0.97 0.98 1 rg 0 0 10 10 re f'));
  ok(lum(c) < 0.18, `zebra-row fill stays bg-anchored in tint mode, not accent-coloured (lum ${lum(c).toFixed(3)})`);

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
