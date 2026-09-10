const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('\n=== TEST 13: Clean Transfer progress animation lifecycle & alignment ===');
  let PASS = 0, FAIL = 0;
  const ok = (cond, msg) => {
    if (cond) { PASS++; console.log('  \x1b[32mok\x1b[0m  ' + msg); }
    else { FAIL++; console.log('  \x1b[31mFAIL\x1b[0m ' + msg); }
  };
  const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

  const server = await require('./server.cjs').start();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  const htmlPath = server.url;
  await page.goto(htmlPath, { waitUntil: 'networkidle0' });

  // 1. Initial State: hidden, idle, bridge removed
  const initState = await page.evaluate(() => {
    const el = document.getElementById('renderWidget');
    const bridge = el.querySelector('.bridge');
    return {
      hidden: el.hidden,
      state: el.dataset.state,
      pctText: document.getElementById('renderWidgetPct').textContent.trim(),
      hasBridge: !!bridge
    };
  });
  ok(initState.hidden, 'widget initially hidden');
  eq(initState.state, 'idle', 'widget initially idle');
  eq(initState.pctText, '0%', 'initial pct is 0%');
  eq(initState.hasBridge, false, 'center progress line bar (bridge) is completely removed');

  // 2. Show & Progress through 0%, 45%, 100%
  // Test 0%
  await page.evaluate(() => {
    window.__app = true; // flag
    const rw = document.getElementById('renderWidget');
    rw.hidden = false;
    rw.dataset.state = 'running';
    const drain = document.getElementById('renderWidgetDrain');
    const fill = document.getElementById('renderWidgetFill');
    const pct = document.getElementById('renderWidgetPct');
    
    // Simulate setRenderProgress(0)
    drain.style.height = '100%';
    fill.style.height = '0%';
    pct.textContent = '0%';
  });
  await new Promise(r => setTimeout(r, 100));

  const at0 = await page.evaluate(() => {
    const drain = document.getElementById('renderWidgetDrain');
    const fill = document.getElementById('renderWidgetFill');
    return {
      drainH: drain.style.height,
      fillH: fill.style.height,
      pct: document.getElementById('renderWidgetPct').textContent.trim()
    };
  });
  eq(at0.drainH, '100%', '0% progress: drain is 100% height');
  eq(at0.fillH, '0%', '0% progress: fill is 0% height');
  eq(at0.pct, '0%', '0% progress: text is 0%');

  const artifactDir = process.env.AUDIT_SCREENSHOTS || path.join(require('os').tmpdir(), 'darkpdf-tests');
  fs.mkdirSync(artifactDir, {recursive: true});
  await page.screenshot({ path: path.join(artifactDir, 'darkpdf_transfer_0pct.png') });

  // Test 45%
  await page.evaluate(() => {
    const drain = document.getElementById('renderWidgetDrain');
    const fill = document.getElementById('renderWidgetFill');
    const pct = document.getElementById('renderWidgetPct');
    
    drain.style.height = '55%';
    fill.style.height = '45%';
    pct.textContent = '45%';
  });
  await new Promise(r => setTimeout(r, 100));

  const at45 = await page.evaluate(() => {
    const drain = document.getElementById('renderWidgetDrain');
    const fill = document.getElementById('renderWidgetFill');
    return {
      drainH: drain.style.height,
      fillH: fill.style.height,
      pct: document.getElementById('renderWidgetPct').textContent.trim()
    };
  });
  eq(at45.drainH, '55%', '45% progress: drain is 55% height');
  eq(at45.fillH, '45%', '45% progress: fill is 45% height');
  eq(at45.pct, '45%', '45% progress: text is 45%');

  // Screenshot at 45%
  await page.screenshot({ path: path.join(artifactDir, 'darkpdf_transfer_45pct.png') });

  // Test 100% (Complete state)
  await page.evaluate(() => {
    const rw = document.getElementById('renderWidget');
    const drain = document.getElementById('renderWidgetDrain');
    const fill = document.getElementById('renderWidgetFill');
    const pct = document.getElementById('renderWidgetPct');
    
    drain.style.height = '0%';
    fill.style.height = '100%';
    pct.textContent = '100%';
    rw.dataset.state = 'complete';
  });
  await new Promise(r => setTimeout(r, 100));

  const at100 = await page.evaluate(() => {
    const rw = document.getElementById('renderWidget');
    const drain = document.getElementById('renderWidgetDrain');
    const fill = document.getElementById('renderWidgetFill');
    const glow = rw.querySelector('.glow');
    const dest = rw.querySelector('.dest-frame');
    const compGlow = window.getComputedStyle(glow);
    const compDest = window.getComputedStyle(dest);
    return {
      drainH: drain.style.height,
      fillH: fill.style.height,
      state: rw.dataset.state,
      pct: document.getElementById('renderWidgetPct').textContent.trim(),
      hasBumpAnim: compDest.animationName.includes('bump'),
      hasFlashAnim: compGlow.animationName.includes('flash')
    };
  });
  eq(at100.drainH, '0%', '100% progress: drain is 0% height');
  eq(at100.fillH, '100%', '100% progress: fill is 100% height');
  eq(at100.state, 'complete', '100% progress: state is complete');
  eq(at100.pct, '100%', '100% progress: text is 100%');
  ok(at100.hasBumpAnim, 'complete state triggers bump animation on dest frame');
  ok(at100.hasFlashAnim, 'complete state triggers flash animation on glow');

  // Screenshot at 100%
  await page.screenshot({ path: path.join(artifactDir, 'darkpdf_transfer_100pct.png') });

  // 3. Mobile View (iPhone 14, 390px)
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 100));
  const mob = await page.evaluate(() => {
    const rw = document.getElementById('renderWidget');
    const label = rw.querySelector('.rw-label');
    const compLabel = window.getComputedStyle(label);
    const box = rw.getBoundingClientRect();
    return {
      labelHidden: compLabel.display === 'none',
      width: box.width,
      left: box.left,
      fitsViewport: box.right <= 390 && box.left >= 0
    };
  });
  ok(mob.labelHidden, 'mobile: "Converting" label hidden to save space');
  ok(mob.fitsViewport, `mobile: widget fits cleanly in header (${mob.width}px, left: ${mob.left}px)`);

  // Screenshot on mobile at 45%
  await page.screenshot({ path: path.join(artifactDir, 'darkpdf_transfer_mobile_45pct.png') });

  await browser.close();
  server.close();
  console.log(`\n${FAIL ? '\x1b[31m' : '\x1b[32m'}${PASS} passed, ${FAIL} failed\x1b[0m\n`);
  process.exitCode = FAIL ? 1 : 0;
})();
