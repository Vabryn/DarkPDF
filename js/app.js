/**
 * app.js
 * DarkPDF UI controller.
 *
 *  - Colour customization (background / text / object) with live, WYSIWYG preview
 *  - Live preview converts the CURRENT PAGE instantly; a full-document pass runs
 *    shortly after and drives the before/after retention report
 *  - Zoom: auto fit-to-view, plus a 25-400% slider for close inspection
 *  - Output size estimate, cross-checked against the real result
 */

(function () {
  'use strict';

  const state = {
    originalBytes: null,
    srcDoc: null,               // pdf-lib doc, kept for fast single-page preview extraction
    convertedBytes: null,
    conversionFresh: false,
    conversionRange: 'All',
    fileName: 'document.pdf',
    fileSize: 0,
    pageCount: 0,
    currentPage: 1,
    zoomPct: 100,
    activeEngine: 'stream_remap'
  };

  const els = {};
  [
    'uploadSection', 'dropZone', 'fileInput', 'btnUpload', 'btnDemo',
    'workspace', 'viewerContainer',
    'docTitle', 'docMeta', 'btnNewDoc', 'btnDownload', 'sizeChip',
    'themeSelect', 'btnToggleStudio', 'engineSelect', 'pageRangeInput',
    'zoomSlider', 'zoomVal', 'btnZoomReset', 'btnZoomFill',
    'btnPrevPage', 'btnNextPage', 'pageInput', 'pageTotalDisplay',
    'colorStudioDrawer', 'btnCloseStudio', 'btnResetStudio',
    'studioBgColor', 'studioBgHex', 'sliderBgLightness', 'valBgLightness', 'sliderBgTint', 'valBgTint',
    'studioTextColor', 'studioTextHex', 'sliderTextBrightness', 'valTextBrightness',
    'sliderTextContrast', 'valTextContrast', 'sliderTextWarmth', 'valTextWarmth',
    'studioObjColor', 'studioObjHex', 'studioObjMode', 'sliderObjSaturation', 'valObjSaturation',
    'sliderObjBorder', 'valObjBorder',
    'progressModal', 'progressBar', 'progressPercent', 'progressStatus'
  ].forEach((id) => { els[id] = document.getElementById(id); });

  let converter, viewer;
  let previewTimer = null, fullTimer = null, previewToken = 0, fullToken = 0;

  /* ---- colour helpers (compose the background from base hue + sliders) ---- */
  const hexToRgb = (hex) => {
    const h = (hex || '#000000').replace('#', '');
    return { r: parseInt(h.substr(0, 2), 16) / 255, g: parseInt(h.substr(2, 2), 16) / 255, b: parseInt(h.substr(4, 2), 16) / 255 };
  };
  const rgbToHex = (r, g, b) => {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
  };
  function rgbToHsl(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h, s, l = (mx + mn) / 2;
    if (mx === mn) { h = s = 0; }
    else {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    if (s === 0) return { r: l, g: l, b: l };
    const f = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return { r: f(p, q, h + 1 / 3), g: f(p, q, h), b: f(p, q, h - 1 / 3) };
  }
  function composedBackgroundHex() {
    const base = hexToRgb(els.studioBgHex.value || '#18181b');
    const [h, s] = rgbToHsl(base.r, base.g, base.b);
    const l = Math.max(0, Math.min(0.30, +els.sliderBgLightness.value / 100));
    let { r, g, b } = hslToRgb(h, s, l);
    const w = +els.sliderBgTint.value / 50;                   // -1 cool .. +1 warm
    r = Math.max(0, Math.min(1, r * (1 + 0.20 * w) + Math.max(0, w) * 0.015));
    b = Math.max(0, Math.min(1, b * (1 - 0.20 * w) + Math.max(0, -w) * 0.015));
    return rgbToHex(r, g, b);
  }

  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');

  /* ---- toasts (replace blocking alert) ---- */
  function toast(msg, kind) {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, kind === 'error' ? 6000 : 3000);
  }

  /* ---- studio slider readouts (data-driven) ---- */
  const SLIDER_ROWS = [
    ['sliderBgLightness', 'valBgLightness', (v) => `${v}%`],
    ['sliderBgTint', 'valBgTint', (v) => (v < -10 ? 'Cool' : v > 10 ? 'Warm' : 'Neutral')],
    ['sliderTextBrightness', 'valTextBrightness', (v) => `${v}%`],
    ['sliderTextContrast', 'valTextContrast', (v) => `${(v / 100).toFixed(1)}x`],
    ['sliderTextWarmth', 'valTextWarmth', (v) => (v > 0 ? `+${v}` : `${v}`)],
    ['sliderObjSaturation', 'valObjSaturation', (v) => `${v}%`],
    ['sliderObjBorder', 'valObjBorder', (v) => `${v}%`]
  ];
  const refreshSliderLabels = () => SLIDER_ROWS.forEach(([sl, out, fmt]) => { els[out].textContent = fmt(+els[sl].value); });

  /* ---- init ---- */
  function init() {
    converter = new window.PDFConverter();
    viewer = new window.PDFViewer(els.viewerContainer);
    viewer.onZoomChange = (pct) => {          // keep the slider in sync when fit recomputes
      state.zoomPct = pct;
      els.zoomSlider.value = pct;
      els.zoomVal.textContent = `${pct}%`;
    };
    bindEvents();
    refreshSliderLabels();
  }

  function bindEvents() {
    els.btnUpload.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', (e) => { if (e.target.files[0]) loadPdfFile(e.target.files[0]); });

    ['dragenter', 'dragover'].forEach((n) => els.dropZone.addEventListener(n, (e) => {
      e.preventDefault(); e.stopPropagation(); els.dropZone.classList.add('drag-active');
    }));
    ['dragleave', 'drop'].forEach((n) => els.dropZone.addEventListener(n, (e) => {
      e.preventDefault(); e.stopPropagation(); els.dropZone.classList.remove('drag-active');
    }));
    els.dropZone.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) loadPdfFile(f);
      else if (f) toast('Please drop a valid PDF document.', 'error');
    });

    els.btnDemo.addEventListener('click', loadDemoPdf);
    els.btnNewDoc.addEventListener('click', () => {
      els.workspace.style.display = 'none';
      els.uploadSection.style.display = 'flex';
      els.fileInput.value = '';
    });

    els.btnToggleStudio.addEventListener('click', () => els.colorStudioDrawer.classList.toggle('open'));
    els.btnCloseStudio.addEventListener('click', () => els.colorStudioDrawer.classList.remove('open'));

    els.themeSelect.addEventListener('change', () => {
      converter.setTheme(els.themeSelect.value);
      syncStudioWithTheme(converter.currentTheme);
      applyStudioColors();
    });
    els.engineSelect.addEventListener('change', () => {
      state.activeEngine = els.engineSelect.value;
      invalidateConversion();
      scheduleRefresh();
    });
    els.pageRangeInput.addEventListener('change', () => { invalidateConversion(); scheduleRefresh(); });

    document.querySelectorAll('.seg-btn').forEach((btn) => btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      viewer.setViewMode(btn.dataset.mode);
    }));

    els.zoomSlider.addEventListener('input', () => setZoom(+els.zoomSlider.value));
    els.btnZoomReset.addEventListener('click', () => viewer.fitToView());
    els.btnZoomFill.addEventListener('click', () => viewer.fitToWidth());

    els.btnPrevPage.addEventListener('click', () => gotoPage(state.currentPage - 1));
    els.btnNextPage.addEventListener('click', () => gotoPage(state.currentPage + 1));
    els.pageInput.addEventListener('change', (e) => gotoPage(parseInt(e.target.value, 10)));

    els.btnDownload.addEventListener('click', exportPdf);

    const changed = () => applyStudioColors();
    [['studioBgColor', 'studioBgHex'], ['studioTextColor', 'studioTextHex'], ['studioObjColor', 'studioObjHex']].forEach(([pick, hex]) => {
      els[pick].addEventListener('input', () => { els[hex].value = els[pick].value; changed(); });
      els[hex].addEventListener('change', () => {
        if (/^#[0-9a-fA-F]{6}$/.test(els[hex].value)) { els[pick].value = els[hex].value; changed(); }
      });
    });
    els.studioObjMode.addEventListener('change', changed);
    SLIDER_ROWS.forEach(([sl, out, fmt]) => els[sl].addEventListener('input', () => { els[out].textContent = fmt(+els[sl].value); changed(); }));

    els.btnResetStudio.addEventListener('click', () => {
      converter.setTheme(els.themeSelect.value);
      syncStudioWithTheme(converter.currentTheme);
      applyStudioColors();
    });

    window.addEventListener('keydown', (e) => {
      if (els.workspace.style.display === 'none') return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (e.key === 'ArrowLeft') els.btnPrevPage.click();
      else if (e.key === 'ArrowRight') els.btnNextPage.click();
      else if (e.key === '=' || e.key === '+') setZoom(state.zoomPct + 15);
      else if (e.key === '-') setZoom(state.zoomPct - 15);
    });
  }

  /* ---- customization <-> converter ---- */
  function syncStudioWithTheme(theme) {
    els.studioBgColor.value = els.studioBgHex.value = theme.bgHex;
    els.studioTextColor.value = els.studioTextHex.value = theme.textHex;
    els.studioObjColor.value = els.studioObjHex.value = theme.objHex;
    els.sliderBgLightness.value = Math.round(rgbToHsl(theme.bg.r, theme.bg.g, theme.bg.b)[2] * 100);
    els.sliderBgTint.value = 0;
    els.sliderTextBrightness.value = 100;
    els.sliderTextContrast.value = 100;
    els.sliderTextWarmth.value = 0;
    els.sliderObjSaturation.value = 100;
    els.sliderObjBorder.value = 80;
    els.studioObjMode.value = 'adapt';
    refreshSliderLabels();
  }

  function applyStudioColors() {
    converter.updateColorConfig({
      bgHex: composedBackgroundHex(),
      textHex: els.studioTextHex.value,
      textBrightness: +els.sliderTextBrightness.value / 100,
      textContrast: +els.sliderTextContrast.value / 100,
      textWarmth: +els.sliderTextWarmth.value / 50,
      objHex: els.studioObjHex.value,
      objMode: els.studioObjMode.value,
      objSaturation: +els.sliderObjSaturation.value / 100,
      objBorderBrightness: +els.sliderObjBorder.value / 100
    });
    invalidateConversion();
    scheduleRefresh();
  }

  const invalidateConversion = () => { state.conversionFresh = false; };

  function setZoom(pct) {
    state.zoomPct = Math.max(25, Math.min(400, Math.round(pct)));
    els.zoomSlider.value = state.zoomPct;
    els.zoomVal.textContent = `${state.zoomPct}%`;
    viewer.setZoom(state.zoomPct / 100);     // leaves fit-mode
  }

  function gotoPage(page) {
    if (isNaN(page)) return;
    page = Math.max(1, Math.min(state.pageCount, page));
    state.currentPage = page;
    els.pageInput.value = page;
    els.btnPrevPage.disabled = page <= 1;
    els.btnNextPage.disabled = page >= state.pageCount;
    viewer.goToPage(page);
    if (!state.conversionFresh) schedulePreview();
  }

  /* ---- conversion scheduling ---- */
  const scheduleRefresh = () => { schedulePreview(); scheduleFull(); };
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 200);
  }
  function scheduleFull() {
    clearTimeout(fullTimer);
    fullTimer = setTimeout(runFull, 850);
  }

  async function runPreview() {
    if (!state.srcDoc || !state.originalBytes) return;
    const token = ++previewToken;
    try {
      const mini = await window.PDFLib.PDFDocument.create();
      const [pg] = await mini.copyPages(state.srcDoc, [Math.max(0, state.currentPage - 1)]);
      mini.addPage(pg);
      const res = await converter.convert(await mini.save(), { engine: state.activeEngine, pageRange: 'All' });
      if (token !== previewToken) return;
      await viewer.setDarkDocument(res.pdfBytes, true);
    } catch (e) {
      console.warn('preview conversion failed', e);
    }
  }

  async function runFull() {
    if (!state.originalBytes) return;
    const token = ++fullToken;
    const range = (els.pageRangeInput.value || '').trim() || 'All';
    try {
      const res = await converter.convert(state.originalBytes, { engine: state.activeEngine, pageRange: range });
      if (token !== fullToken) return;

      state.convertedBytes = res.pdfBytes;
      state.conversionFresh = true;
      state.conversionRange = range;

      try { await viewer.setDarkDocument(res.pdfBytes, false); } catch (e) { console.warn('dark render', e); }
      if (token !== fullToken) return;
      await runRetention(res, token);
    } catch (e) {
      console.error(e);
      toast('Conversion failed: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  // Verify the conversion changed only colour — warn (once) if anything else moved.
  async function runRetention(convResult, token) {
    if (!window.RetentionCheck || !window.pdfjsLib) return;
    try {
      const [before, after] = await Promise.all([
        window.RetentionCheck.analyze(window.pdfjsLib, state.originalBytes),
        window.RetentionCheck.analyze(window.pdfjsLib, convResult.pdfBytes)
      ]);
      if (token !== fullToken) return;
      const report = window.RetentionCheck.compare(before, after);
      showOutputSize(convResult.pdfBytes.length);
      if (!report.criticalPass) {
        const diffs = report.rows.filter((r) => !r.ok && r.label !== 'File size').map((r) => r.label);
        toast('Retention check: ' + (diffs.join(', ') || 'differences') + ' changed — inspect before relying on the export.', 'error');
      }
    } catch (e) {
      console.warn('retention check failed', e);
    }
  }

  /* ---- output-size estimate (calibrated in tests/size_calibration.js) ---- *
   * The PDF is re-saved with object streams, so original content carries       *
   * through at ~its original density; Standard then adds a small dark-ground   *
   * stream per page (~+10-18%). Scanned re-encodes every page as an image, so  *
   * it can go either way. Single-stream-per-page PDFs sit at the low end.      */
  function estimateOutputSize(origSize, pageCount, engine) {
    const p = Math.max(1, pageCount);
    if (engine === 'scanned_canvas') return { lo: origSize * 0.30, hi: origSize * 2.0 };
    return { lo: origSize * 0.95, hi: origSize * 1.35 + p * 45 + 500 };   // stream_remap (Standard)
  }

  // file chip shows  "<orig> → est ~<mid>"  before conversion, "<orig> → <actual>" after
  function showEstimatedSize() {
    const e = estimateOutputSize(state.fileSize, state.pageCount, state.activeEngine);
    els.sizeChip.textContent = `~${fmtSize((e.lo + e.hi) / 2)}`;
    els.sizeChip.title = `Estimated output ${fmtSize(e.lo)} – ${fmtSize(e.hi)} · updates to the real size after conversion`;
  }
  function showOutputSize(outBytes) {
    const pct = state.fileSize ? ((outBytes - state.fileSize) / state.fileSize) * 100 : 0;
    els.sizeChip.textContent = fmtSize(outBytes);
    els.sizeChip.title = `output ${fmtSize(outBytes)} · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs original ${fmtSize(state.fileSize)}`;
  }

  /* ---- load / setup ---- */
  async function loadPdfFile(file) {
    try {
      showProgress('Reading PDF document...', 15);
      state.fileName = file.name;
      state.fileSize = file.size;
      state.originalBytes = new Uint8Array(await file.arrayBuffer());
      await setupWorkspace();
      hideProgress();
    } catch (err) {
      hideProgress();
      console.error(err);
      toast('Error loading PDF: ' + err.message, 'error');
    }
  }

  async function setupWorkspace() {
    els.uploadSection.style.display = 'none';
    els.workspace.style.display = 'flex';
    els.docTitle.textContent = state.fileName;
    els.docMeta.textContent = fmtSize(state.fileSize);
    showProgress('Rendering document...', 45);

    try {
      state.srcDoc = await window.PDFLib.PDFDocument.load(state.originalBytes.slice(), { ignoreEncryption: true, updateMetadata: false });
    } catch (e) { state.srcDoc = null; }

    const info = await viewer.loadDocument(state.originalBytes.slice());
    state.pageCount = info.numPages;
    state.currentPage = 1;
    els.pageTotalDisplay.textContent = `/ ${state.pageCount}`;
    els.pageInput.value = 1;
    els.pageInput.max = state.pageCount;
    els.btnPrevPage.disabled = true;
    els.btnNextPage.disabled = state.pageCount <= 1;
    // viewer.loadDocument() fits page width automatically; slider syncs via onZoomChange
    showEstimatedSize();

    invalidateConversion();
    runPreview();
    scheduleFull();
  }

  async function loadDemoPdf() {
    try {
      showProgress('Building sample PDF...', 20);
      const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
      const doc = await PDFDocument.create();
      const F = await doc.embedFont(StandardFonts.Helvetica);
      const B = await doc.embedFont(StandardFonts.HelveticaBold);
      const ink = rgb(0.13, 0.13, 0.15), muted = rgb(0.42, 0.44, 0.48), rule = rgb(0.75, 0.77, 0.80);
      const P = doc.addPage([595, 792]);
      const W = 595;

      // ---- header (no boxes, just type) --------------------------------------
      P.drawText('Quarterly Vector Report', { x: 48, y: 744, size: 20, font: B, color: rgb(0.10, 0.22, 0.55) });
      P.drawText('Every mark below is a vector — zoom to 400% and nothing blurs.', { x: 48, y: 726, size: 10, font: F, color: muted });
      P.drawLine({ start: { x: 48, y: 716 }, end: { x: W - 48, y: 716 }, thickness: 1, color: rule });

      P.drawText('This sample exercises the converter on real page furniture: body text', { x: 48, y: 694, size: 11, font: F, color: ink });
      P.drawText('and four charts built from vector primitives. The dark output keeps all', { x: 48, y: 678, size: 11, font: F, color: ink });
      P.drawText('of it as selectable text and crisp vector geometry.', { x: 48, y: 662, size: 11, font: F, color: ink });

      // ---- bar chart -------------------------------------------------------------
      const bx = 48, by = 430, bw = 230, bh = 150;
      P.drawText('Revenue by region  ($k)', { x: bx, y: by + bh + 14, size: 11, font: B, color: ink });
      P.drawLine({ start: { x: bx, y: by }, end: { x: bx + bw, y: by }, thickness: 1, color: ink });          // x axis
      P.drawLine({ start: { x: bx, y: by }, end: { x: bx, y: by + bh }, thickness: 1, color: ink });          // y axis
      const bars = [['N', 96, rgb(0.20, 0.55, 0.90)], ['S', 138, rgb(0.15, 0.70, 0.55)], ['E', 74, rgb(0.95, 0.65, 0.20)], ['W', 150, rgb(0.85, 0.30, 0.40)], ['C', 60, rgb(0.55, 0.45, 0.85)]];
      bars.forEach(([label, h, col], i) => {
        const x = bx + 14 + i * 42;
        P.drawRectangle({ x, y: by + 1, width: 28, height: h, color: col });
        P.drawText(label, { x: x + 9, y: by - 14, size: 9, font: F, color: muted });
      });
      [0, 50, 100, 150].forEach((v) => {
        P.drawText(String(v), { x: bx - 22, y: by + v - 3, size: 7, font: F, color: muted });
        P.drawLine({ start: { x: bx - 3, y: by + v }, end: { x: bx, y: by + v }, thickness: 0.75, color: ink });
      });

      // ---- line chart ----------------------------------------------------------
      const lx = 330, ly = 430, lw = 215, lh = 150;
      P.drawText('Adoption trend  (weeks 1-6)', { x: lx, y: ly + lh + 14, size: 11, font: B, color: ink });
      P.drawLine({ start: { x: lx, y: ly }, end: { x: lx + lw, y: ly }, thickness: 1, color: ink });
      P.drawLine({ start: { x: lx, y: ly }, end: { x: lx, y: ly + lh }, thickness: 1, color: ink });
      const pts = [12, 34, 30, 68, 92, 120].map((v, i) => ({ x: lx + 6 + i * 40, y: ly + 4 + v }));
      for (let i = 1; i < pts.length; i++) {
        P.drawLine({ start: pts[i - 1], end: pts[i], thickness: 2, color: rgb(0.20, 0.55, 0.90) });
      }
      pts.forEach((p) => P.drawCircle({ x: p.x, y: p.y, size: 3, color: rgb(0.10, 0.30, 0.60) }));

      // ---- stacked proportion bar --------------------------------------------
      const sx = 48, sw = 250, syB = 300;
      P.drawText('Storage mix by type', { x: sx, y: syB + 36, size: 11, font: B, color: ink });
      const seg = [['Text', 0.38, rgb(0.20, 0.55, 0.90)], ['Vectors', 0.27, rgb(0.15, 0.70, 0.55)],
        ['Fonts', 0.21, rgb(0.95, 0.65, 0.20)], ['Images', 0.14, rgb(0.85, 0.30, 0.40)]];
      let sxOff = sx;
      seg.forEach(([, frac, col]) => {
        const segW = sw * frac;
        P.drawRectangle({ x: sxOff, y: syB, width: segW, height: 22, color: col });
        sxOff += segW;
      });
      let lgx = sx;
      seg.forEach(([label, frac, col]) => {
        P.drawRectangle({ x: lgx, y: syB - 20, width: 8, height: 8, color: col });
        P.drawText(`${label} ${Math.round(frac * 100)}%`, { x: lgx + 12, y: syB - 20, size: 7.5, font: F, color: muted });
        lgx += 62;
      });

      // ---- scatter plot ------------------------------------------------------
      const px = 330, py = 150, pw = 215, ph = 170;
      P.drawText('Latency vs. page size', { x: px, y: py + ph + 14, size: 11, font: B, color: ink });
      P.drawLine({ start: { x: px, y: py }, end: { x: px + pw, y: py }, thickness: 1, color: ink });
      P.drawLine({ start: { x: px, y: py }, end: { x: px, y: py + ph }, thickness: 1, color: ink });
      const dots = [[18, 22, 0], [40, 55, 0], [62, 44, 0], [95, 90, 1], [120, 76, 1],
        [150, 130, 1], [175, 110, 2], [190, 150, 2], [70, 30, 0], [110, 60, 1],
        [30, 40, 0], [160, 95, 2], [200, 140, 2], [85, 105, 1]];
      const dotCol = [rgb(0.20, 0.55, 0.90), rgb(0.95, 0.65, 0.20), rgb(0.85, 0.30, 0.40)];
      dots.forEach(([dx, dy, g]) => P.drawCircle({ x: px + 6 + dx * (pw - 12) / 210, y: py + 6 + dy * (ph - 12) / 160, size: 3.2, color: dotCol[g], opacity: 0.85 }));
      ['small', 'medium', 'large'].forEach((t, i) => {
        P.drawRectangle({ x: px + i * 66, y: py - 20, width: 8, height: 8, color: dotCol[i] });
        P.drawText(t, { x: px + i * 66 + 12, y: py - 20, size: 7.5, font: F, color: muted });
      });

      const bytes = await doc.save();
      state.fileName = 'darkpdf-sample.pdf';
      state.fileSize = bytes.byteLength;
      state.originalBytes = bytes;
      await setupWorkspace();
      hideProgress();
    } catch (err) {
      hideProgress();
      console.error(err);
      toast('Error loading demo PDF: ' + err.message, 'error');
    }
  }

  /* ---- export ---- */
  async function exportPdf() {
    if (!state.originalBytes) return;
    try {
      const range = (els.pageRangeInput.value || '').trim() || 'All';
      let bytes = state.convertedBytes;
      if (!state.conversionFresh || state.conversionRange !== range || !bytes) {
        showProgress('Converting...', 5);
        const res = await converter.convert(state.originalBytes, {
          engine: state.activeEngine, pageRange: range, onProgress: (p) => showProgress(p.message, p.percent)
        });
        bytes = res.pdfBytes;
        state.convertedBytes = bytes;
        state.conversionFresh = true;
        state.conversionRange = range;
        hideProgress();
        await viewer.setDarkDocument(bytes, false);
        runRetention(res, ++fullToken);
      }

      const url = URL.createObjectURL(new Blob([bytes.slice(0)], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = state.fileName.replace(/\.pdf$/i, '') + '-dark.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Saved converted dark PDF.', 'ok');
    } catch (err) {
      hideProgress();
      console.error(err);
      toast('Error exporting PDF: ' + err.message, 'error');
    }
  }

  function showProgress(msg, pct) {
    els.progressModal.classList.add('visible');
    els.progressStatus.textContent = msg;
    els.progressBar.style.width = `${pct}%`;
    els.progressPercent.textContent = `${Math.round(pct)}%`;
  }
  const hideProgress = () => els.progressModal.classList.remove('visible');

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
