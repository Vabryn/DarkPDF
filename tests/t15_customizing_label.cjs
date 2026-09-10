const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

let PASS = 0, FAIL = 0;
const ok = (c, msg) => { if (c) { PASS++; console.log('  ok  ' + msg); } else { FAIL++; console.error('  FAIL ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

(async () => {
  console.log('\n=== TEST 15: Converting vs Customizing label & unboxed rw-panel ===');

  const server = await require('./server.cjs').start();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  await page.goto(server.url, { waitUntil: 'networkidle0' });

  // Verify .rw-panel has no border, rounded corners, or background box
  const panelStyles = await page.evaluate(() => {
    const p = document.getElementById('renderWidget');
    const cs = window.getComputedStyle(p);
    return {
      background: cs.backgroundColor,
      borderTopWidth: cs.borderTopWidth,
      borderTopStyle: cs.borderTopStyle,
      borderRadius: cs.borderTopLeftRadius,
      boxShadow: cs.boxShadow
    };
  });

  ok(panelStyles.background === 'rgba(0, 0, 0, 0)' || panelStyles.background === 'transparent',
    `rw-panel background is transparent (${panelStyles.background})`);
  ok(panelStyles.borderTopStyle === 'none' || panelStyles.borderTopWidth === '0px',
    `rw-panel has no border (${panelStyles.borderTopStyle}, ${panelStyles.borderTopWidth})`);
  ok(panelStyles.boxShadow === 'none',
    `rw-panel has no box-shadow (${panelStyles.boxShadow})`);

  // Trigger showRenderProgress() directly to check default label
  const initialLabel = await page.evaluate(() => {
    const label = document.getElementById('renderWidgetLabel');
    return label ? label.textContent.trim() : null;
  });
  eq(initialLabel, 'Converting', 'default label in DOM is Converting');

  // Load sample demo PDF and wait for workspace to be visible
  await page.evaluate(() => {
    const demoBtn = document.querySelector('.drop-cta-group button:last-child');
    if (demoBtn) demoBtn.click();
  });
  await page.waitForFunction(() => {
    const ws = document.getElementById('workspace');
    return ws && ws.style.display !== 'none';
  }, { timeout: 8000 });

  // Now trigger a customization change (e.g. adjust slider or color)
  const duringChange = await page.evaluate(() => {
    const sl = document.getElementById('sliderTextBrightness');
    if (sl) {
      sl.value = 85;
      sl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const label = document.getElementById('renderWidgetLabel');
    const rw = document.getElementById('renderWidget');
    return {
      text: label ? label.textContent.trim() : null,
      ariaLabel: rw ? rw.getAttribute('aria-label') : null
    };
  });

  eq(duringChange.text, 'Customizing', 'customization change sets header text to Customizing');
  ok(duringChange.ariaLabel && duringChange.ariaLabel.includes('Customizing'),
    `aria-label updated to Customizing (${duringChange.ariaLabel})`);

  // Click Return to upload (back button)
  await page.evaluate(() => {
    const backBtn = document.getElementById('btnNewDoc');
    if (backBtn) backBtn.click();
  });
  await page.waitForFunction(() => {
    const up = document.getElementById('uploadSection');
    return up && up.style.display !== 'none';
  }, { timeout: 5000 });

  const afterBack = await page.evaluate(() => {
    const rw = document.getElementById('renderWidget');
    const upload = document.getElementById('uploadSection');
    const cs = window.getComputedStyle(rw);
    return {
      hiddenAttr: rw ? rw.hidden : null,
      display: cs.display,
      uploadVisible: upload && window.getComputedStyle(upload).display !== 'none'
    };
  });

  ok(afterBack.uploadVisible, 'upload section is visible after pressing back');
  ok(afterBack.hiddenAttr === true, 'renderWidget hidden attribute is true after back');
  eq(afterBack.display, 'none', 'renderWidget computed display is none on homescreen');

  // Take screenshot of clean homescreen
  const artifactDir = process.env.AUDIT_SCREENSHOTS || path.join(require('os').tmpdir(), 'darkpdf-tests');
  fs.mkdirSync(artifactDir, {recursive: true});
  await page.screenshot({ path: path.join(artifactDir, 'darkpdf_homescreen_after_back.png') });

  await browser.close();
  server.close();
  console.log(`\n${FAIL ? '\x1b[31m' : '\x1b[32m'}${PASS} passed, ${FAIL} failed\x1b[0m\n`);
  if (FAIL) process.exitCode = 1;
})();
