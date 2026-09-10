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
    coverPages: new Set()
  };

  const els = {};
  [
    'uploadSection', 'dropZone', 'fileInput', 'btnUpload', 'btnDemo',
    'workspace', 'viewerContainer',
    'docTitle', 'docMeta', 'btnNewDoc', 'btnOpenDoc', 'btnDownload', 'sizeChip',
    'themeSelect', 'btnToggleStudio', 'rememberDocument',
    'zoomSlider', 'zoomVal', 'btnZoomReset', 'btnZoomFill', 'btnZoomActual',
    'btnPrevPage', 'btnNextPage', 'pageInput', 'pageTotalDisplay',
    'colorStudioDrawer', 'btnCloseStudio', 'btnResetStudio',
    'studioBgColor', 'studioBgHex', 'sliderBgLightness', 'valBgLightness', 'sliderBgTint', 'valBgTint',
    'studioTextColor', 'studioTextHex', 'sliderTextBrightness', 'valTextBrightness',
    'sliderTextContrast', 'valTextContrast', 'sliderTextWarmth', 'valTextWarmth',
    'studioObjColor', 'studioObjHex', 'toggleObjRecolor', 'sliderObjSaturation', 'valObjSaturation',
    'sliderObjBorder', 'valObjBorder',
    'progressModal', 'progressBar', 'progressPercent', 'progressStatus', 'btnCancelProgress',
    'renderWidget', 'renderWidgetDrain', 'renderWidgetFill', 'renderWidgetLight', 'renderWidgetPct', 'renderWidgetLabel'
  ].forEach((id) => { els[id] = document.getElementById(id); });

  let converter, viewer;
  let previewTimer = null, fullTimer = null, previewToken = 0, fullToken = 0;
  let renderAction = 'converting'; // 'converting' | 'customizing'

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
    // Bring back the document from the last session (a refresh shouldn't dump
    // you on the upload screen). No-ops silently if there's nothing stored.
    restoreSession();
  }

  function bindEvents() {
    els.rememberDocument.addEventListener('change', async () => {
      if (els.rememberDocument.checked) await persistDocument();
      else await clearSession();
    });
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
      exitToLanding();
      if (window.history && window.history.state && window.history.state.darkPdfLoaded) {
        window.history.back();
      }
    });
    window.addEventListener('popstate', () => {
      if (els.workspace && els.workspace.style.display !== 'none') {
        exitToLanding();
      }
    });
    // open a different PDF without leaving the workspace
    els.btnOpenDoc.addEventListener('click', () => { els.fileInput.value = ''; els.fileInput.click(); });

    els.btnToggleStudio.addEventListener('click', () => els.colorStudioDrawer.classList.toggle('open'));
    els.btnCloseStudio.addEventListener('click', () => els.colorStudioDrawer.classList.remove('open'));

    els.btnCancelProgress.addEventListener('click', () => { if (progressCancelFn) progressCancelFn(); });

    els.themeSelect.addEventListener('change', () => {
      converter.setTheme(els.themeSelect.value);
      syncStudioWithTheme();
      applyStudioColors();
    });

    document.querySelectorAll('.seg-btn').forEach((btn) => btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      viewer.setViewMode(btn.dataset.mode);
    }));

    els.zoomSlider.addEventListener('input', () => setZoom(+els.zoomSlider.value, false));
    els.zoomSlider.addEventListener('change', () => setZoom(+els.zoomSlider.value, true));
    els.btnZoomReset.addEventListener('click', () => viewer.fitToView());
    els.btnZoomFill.addEventListener('click', () => viewer.fitToWidth());
    els.btnZoomActual.addEventListener('click', () => setZoom(100, true));

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
    els.toggleObjRecolor.addEventListener('change', changed);
    SLIDER_ROWS.forEach(([sl, out, fmt]) => els[sl].addEventListener('input', () => { els[out].textContent = fmt(+els[sl].value); changed(); }));

    // Per-section revert — reset just this card's controls to the current theme
    document.querySelectorAll('.param-card-revert').forEach((btn) => btn.addEventListener('click', () => {
      applyGroupDefaults(btn.dataset.group);
      applyStudioColors();
    }));

    els.btnResetStudio.addEventListener('click', () => {
      converter.setTheme(els.themeSelect.value);
      syncStudioWithTheme();
      applyStudioColors();
    });

    window.addEventListener('keydown', (e) => {
      if (els.workspace.style.display === 'none') return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (e.key === 'ArrowLeft') els.btnPrevPage.click();
      else if (e.key === 'ArrowRight') els.btnNextPage.click();
      else if (e.key === '=' || e.key === '+') setZoom(state.zoomPct + 15, true);
      else if (e.key === '-') setZoom(state.zoomPct - 15, true);
    });
  }

  /* ---- customization <-> converter ---- */
  // Reset one section's controls (or, via syncStudioWithTheme, all three) to the
  // current theme's defaults.
  function applyGroupDefaults(group) {
    const theme = converter.currentTheme;
    if (group === 'bg') {
      els.studioBgColor.value = els.studioBgHex.value = theme.bgHex;
      els.sliderBgLightness.value = Math.round(rgbToHsl(theme.bg.r, theme.bg.g, theme.bg.b)[2] * 100);
      els.sliderBgTint.value = 0;
    } else if (group === 'text') {
      els.studioTextColor.value = els.studioTextHex.value = theme.textHex;
      els.sliderTextBrightness.value = 100;
      els.sliderTextContrast.value = 100;
      els.sliderTextWarmth.value = 0;
    } else if (group === 'obj') {
      els.studioObjColor.value = els.studioObjHex.value = theme.objHex;
      els.toggleObjRecolor.checked = false;
      els.sliderObjSaturation.value = 100;
      els.sliderObjBorder.value = 80;
    }
    refreshSliderLabels();
  }

  function syncStudioWithTheme() {
    applyGroupDefaults('bg');
    applyGroupDefaults('text');
    applyGroupDefaults('obj');
  }

  function applyStudioColors() {
    converter.updateColorConfig({
      bgHex: composedBackgroundHex(),
      textHex: els.studioTextHex.value,
      textBrightness: +els.sliderTextBrightness.value / 100,
      textContrast: +els.sliderTextContrast.value / 100,
      textWarmth: +els.sliderTextWarmth.value / 50,
      objHex: els.studioObjHex.value,
      objMode: els.toggleObjRecolor.checked ? 'tint' : 'adapt',
      objSaturation: +els.sliderObjSaturation.value / 100,
      objBorderBrightness: +els.sliderObjBorder.value / 100
    });
    renderAction = 'customizing';
    if (els.renderWidgetLabel) els.renderWidgetLabel.textContent = 'Customizing';
    if (els.renderWidget) els.renderWidget.setAttribute('aria-label', 'Customizing document');
    invalidateConversion();
    scheduleRefresh();
  }

  /* Original bytes and settings are stored only after an explicit device-storage
     choice. Existing saved sessions remain restorable. Store document + metadata
     atomically so an interrupted write cannot pair two different documents. */
  const SESSION = (() => {
    const DB = 'darkpdf-session', STORE = 'kv';
    let dbp = null;
    const open = () => {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        let r;
        try { r = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    };
    const run = async (mode, op) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(STORE, mode);
        const rq = op(t.objectStore(STORE));
        t.oncomplete = () => res(rq ? rq.result : undefined);
        t.onerror = t.onabort = () => rej(t.error);
      });
    };
    return {
      get: (k) => run('readonly', (s) => s.get(k)).catch(() => undefined),
      put: (k, v) => run('readwrite', (s) => s.put(v, k)),
      save: (bytes, meta) => run('readwrite', (s) => { s.put(bytes, 'bytes'); s.put(meta, 'meta'); }),
      clear: () => run('readwrite', (s) => s.clear())
    };
  })();

  function collectSessionMeta() {
    return {
      name: state.fileName, size: state.fileSize,
      themeId: els.themeSelect.value,
      colors: { ...converter.customConfig },
      page: state.currentPage, zoom: state.zoomPct,
      savedAt: Date.now()
    };
  }
  let metaSaveTimer = null;
  function schedulePersistMeta() {
    if (!state.originalBytes || !els.rememberDocument.checked) return;
    clearTimeout(metaSaveTimer);
    metaSaveTimer = setTimeout(() => {
      if (state.originalBytes && els.rememberDocument.checked) {
        SESSION.put('meta', collectSessionMeta()).catch(() => toast('Could not save your latest settings on this device.', 'error'));
      }
    }, 500);
  }
  let restoringSession = false;
  async function persistDocument() {
    if (!state.originalBytes || restoringSession || !els.rememberDocument.checked) return;
    try {
      await SESSION.save(state.originalBytes.slice().buffer, collectSessionMeta());
    } catch (e) {
      els.rememberDocument.checked = false;
      toast('Could not save this PDF on your device. Keep this tab open to continue working.', 'error');
    }
  }
  async function clearSession() {
    clearTimeout(metaSaveTimer);
    try { await SESSION.clear(); }
    catch (e) { toast('Could not clear saved data. Use your browser’s site-data settings to remove it.', 'error'); }
  }
  async function restoreSession() {
    let meta, buf;
    try {
      meta = await SESSION.get('meta');
      buf = await SESSION.get('bytes');
    } catch (e) { return false; }
    if (!meta || !buf || !buf.byteLength) return false;
    restoringSession = true;
    els.rememberDocument.checked = true;
    try {
      state.fileName = meta.name || 'document.pdf';
      state.fileSize = meta.size || buf.byteLength;
      state.originalBytes = new Uint8Array(buf);
      if (meta.themeId) { els.themeSelect.value = meta.themeId; converter.setTheme(meta.themeId); }
      if (meta.colors) { converter.updateColorConfig(meta.colors); syncStudioWithTheme(); }
      await setupWorkspace();                       // re-renders + re-converts
      if (meta.zoom) setZoom(meta.zoom, true);
      if (meta.page && meta.page > 1) gotoPage(meta.page);
      return true;
    } catch (e) {
      // stored doc is unreadable now — don't get stuck failing on every refresh
      state.originalBytes = null;
      await clearSession();
      return false;
    } finally {
      hideProgress();
      restoringSession = false;
    }
  }

  const invalidateConversion = () => { state.conversionFresh = false; schedulePersistMeta(); };

  let zoomDebounceTimer = null;
  function setZoom(pct, immediate = false) {
    state.zoomPct = Math.max(25, Math.min(400, Math.round(pct)));
    els.zoomSlider.value = state.zoomPct;
    els.zoomVal.textContent = `${state.zoomPct}%`;
    const targetScale = state.zoomPct / 100;
    if (immediate) {
      clearTimeout(zoomDebounceTimer);
      viewer.setZoom(targetScale);
    } else {
      viewer.previewZoom(targetScale);
      clearTimeout(zoomDebounceTimer);
      zoomDebounceTimer = setTimeout(() => {
        viewer.setZoom(targetScale);
      }, 150);
    }
    schedulePersistMeta();
  }

  function gotoPage(page) {
    if (isNaN(page)) return;
    page = Math.max(1, Math.min(state.pageCount, page));
    state.currentPage = page;
    els.pageInput.value = page;
    els.btnPrevPage.disabled = page <= 1;
    els.btnNextPage.disabled = page >= state.pageCount;
    viewer.goToPage(page);
    schedulePersistMeta();

    const pageIdx = page - 1;
    let isCover = state.coverPages.has(pageIdx);
    if (!isCover && state.srcDoc && converter.isPageCover) {
      isCover = converter.isPageCover(state.srcDoc, pageIdx);
      if (isCover) state.coverPages.add(pageIdx);
    }
    viewer.setPageIsImage(isCover);

    // A page jump converts immediately, not on the slider-drag debounce —
    // it's proportional to that one page alone, so on a 1000-page book this
    // is just as fast as on a 10-page one, and there's no reason to delay it.
    if (!state.conversionFresh) { clearTimeout(previewTimer); runPreview(); }
  }

  /* ---- conversion scheduling ---- */
  const scheduleRefresh = () => { schedulePreview(); scheduleFull(); };
  // A single-page preview conversion is small and independent of book size
  // (~15-100ms depending on page complexity, see runPreview/runFull split
  // above) -- a long debounce here just adds pure waiting on top of that.
  // 60ms still coalesces the flood of 'input' events a slider drag fires
  // into one conversion per settle point, without making the drag feel laggy.
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 60);
  }
  function scheduleFull() {
    clearTimeout(fullTimer);
    fullTimer = setTimeout(runFull, 850);
  }

  // copyPages() drags in everything transitively reachable from the page:
  // on a tagged book that means the struct-tree subtree -- thousands of
  // /StructElem objects and megabytes of sibling streams the page never
  // paints. On this book's contents pages that made a 13 MB one-page
  // mini-doc whose save()+convert() took ~4.5s on the main thread, so the
  // live preview sat blank while the user paged. Physically drop the
  // catalog/page keys that anchor that non-visual baggage, then delete
  // every indirect object no longer reachable from the render graph
  // (Contents, Resources, and whatever those point at). Rendering is
  // unchanged -- verified byte-for-byte on the bloated pages -- and the
  // lossless full-document pass runs separately on the untouched original.
  const PREVIEW_DROP_CATALOG_KEYS = ['StructTreeRoot', 'Outlines', 'Names', 'AcroForm',
    'PageLabels', 'MarkInfo', 'OpenAction', 'ViewerPreferences', 'Threads', 'Metadata', 'PieceInfo'];
  const PREVIEW_DROP_PAGE_KEYS = ['Annots', 'StructParents', 'Metadata', 'PieceInfo', 'AA', 'B', 'Tabs'];
  // up-tree / sibling pointers: following them would re-reach the whole doc
  const PREVIEW_WALK_SKIP_KEYS = new Set(['/Parent', '/P', '/Prev', '/Next', '/First', '/Last']);

  function pruneMiniToRenderGraph(mini) {
    const PL = window.PDFLib;
    const ctx = mini.context;
    const rootRef = ctx.trailerInfo.Root;
    if (!rootRef) return;
    const nm = (n) => PL.PDFName.of(n);

    const catalog = ctx.lookup(rootRef);
    if (catalog && catalog.delete) PREVIEW_DROP_CATALOG_KEYS.forEach((k) => catalog.delete(nm(k)));
    const pageLeaf = mini.getPage(0).node;
    PREVIEW_DROP_PAGE_KEYS.forEach((k) => pageLeaf.delete(nm(k)));

    const keep = new Set([rootRef.toString(), mini.getPage(0).ref.toString()]);
    const walk = (obj, depth) => {
      if (obj == null || depth > 60) return;
      if (obj instanceof PL.PDFRef) {
        const s = obj.toString();
        if (keep.has(s)) return;
        keep.add(s);
        walk(ctx.lookup(obj), depth + 1);
        return;
      }
      if (obj instanceof PL.PDFArray) {
        const a = obj.asArray();
        for (let i = 0; i < a.length; i++) walk(a[i], depth + 1);
        return;
      }
      const dict = obj instanceof PL.PDFDict ? obj : (obj && obj.dict instanceof PL.PDFDict ? obj.dict : null);
      if (dict) {
        for (const [k, v] of dict.entries()) {
          if (!PREVIEW_WALK_SKIP_KEYS.has(k.toString())) walk(v, depth + 1);
        }
      }
    };
    walk(catalog, 0);
    walk(pageLeaf, 0);
    for (const [ref] of ctx.enumerateIndirectObjects()) {
      if (!keep.has(ref.toString())) ctx.delete(ref);
    }
  }

  async function runPreview() {
    if (!state.originalBytes) return;
    const token = ++previewToken;
    const targetPage = state.currentPage;   // tag the result with the page it's actually FOR, not whatever's current when it lands
    try {
      let previewBytes, previewRange;
      if (state.srcDoc) {
        const mini = await window.PDFLib.PDFDocument.create();
        const [pg] = await mini.copyPages(state.srcDoc, [Math.max(0, targetPage - 1)]);
        mini.addPage(pg);
        try { pruneMiniToRenderGraph(mini); } catch (e) { /* prune is best-effort; a full mini still converts, just slower */ }
        previewBytes = await mini.save();
        previewRange = 'All';
      } else {
        // pdf-lib couldn't parse this file (stricter than pdf.js). Preview
        // straight from the original bytes, limited to the page in view, so
        // the dark side still shows something while runFull() catches up.
        previewBytes = state.originalBytes;
        previewRange = String(targetPage);
      }
      const res = await converter.convert(previewBytes, { pageRange: previewRange });
      const isCover = !!(res && res.stats && (res.stats.pagesLeftAsImage > 0 || (res.stats.coverPages && res.stats.coverPages.length > 0)));
      if (isCover) {
        state.coverPages.add(targetPage - 1);
      } else if (!state.srcDoc) {
        state.coverPages.delete(targetPage - 1);
      }
      if (state.currentPage === targetPage) {
        viewer.setPageIsImage(isCover);
      }
      // Drop the result if a newer preview superseded it, or if the full
      // lossless pass has already finished — a late preview landing after
      // runFull() would flip the dark side back to a 1-page stand-in.
      if (token !== previewToken || state.conversionFresh) return;
      await viewer.setDarkDocument(res.pdfBytes, true, targetPage);
    } catch (e) {
      console.warn('preview conversion failed', e);
    }
  }

  // The background pass converts the WHOLE target range, same as Export
  // will need — but converter.js now yields on an elapsed-time budget
  // (8ms) rather than a fixed stream count, using requestIdleCallback where
  // available. That makes it self-adapting to whatever the device can do:
  // a slow machine simply gets more, smaller slices, so the main thread is
  // never held for long regardless of how weak the hardware is. Meanwhile
  // jumping to any page renders instantly on its own (see gotoPage/
  // runPreview below) — a single page's conversion is proportional to that
  // page alone, never to the book's total length, so it isn't waiting on
  // this pass at all.
  async function runFull(explicitRange) {
    if (!state.originalBytes) return;
    const token = ++fullToken;
    const range = explicitRange || 'All';   // export always covers the whole document
    showRenderProgress();
    try {
      // Off the main thread: a large document's final PDFDocument.save() is a
      // single call pdf-lib can't yield inside, so running it in-page would
      // freeze navigation and the live preview for however long that takes.
      // Starting a new run here also CANCELS (worker.terminate()) whatever
      // convertInWorker call is still in flight on this converter, which is
      // exactly why its rejection is ignored below -- that's this call's own
      // successor taking over, not a real failure.
      const res = await converter.convertInWorker(state.originalBytes, {
        pageRange: range,
        onProgress: (p) => { if (token === fullToken) setRenderProgress(p.percent); }
      });
      if (token !== fullToken) return;

      if (res.stats && Array.isArray(res.stats.coverPages)) {
        state.coverPages = new Set(res.stats.coverPages);
        viewer.setPageIsImage(state.coverPages.has(state.currentPage - 1));
      }

      state.convertedBytes = res.pdfBytes;
      state.conversionFresh = true;
      state.conversionRange = range;
      previewToken++;   // invalidate any preview still in flight so it can't overwrite the lossless doc

      try { await viewer.setDarkDocument(res.pdfBytes, false); } catch (e) { console.warn('dark render', e); }
      if (token !== fullToken) return;
      await runRetention(res, token);
      finishRenderProgress();
    } catch (e) {
      if (e && e.superseded) return;   // a newer runFull() already took over
      hideRenderProgress();
      console.error(e);
      toast('Conversion failed: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  /* ---- conversion progress widget -----------------------------------------
     Clean Transfer animation: source light document drains while destination
     dark document fills in direct proportion to conversion progress. Completes
     a single loop (bump + flash) only when percentage finishes at 100%. */
  let rwFadeTimers = [];
  function clearRenderTimers() { rwFadeTimers.forEach(clearTimeout); rwFadeTimers = []; }

  function showRenderProgress(action) {
    if (action) renderAction = action;
    clearRenderTimers();
    if (!els.renderWidget) return;
    if (els.renderWidgetLabel) {
      els.renderWidgetLabel.textContent = renderAction === 'customizing' ? 'Customizing' : 'Converting';
    }
    els.renderWidget.setAttribute('aria-label', renderAction === 'customizing' ? 'Customizing document' : 'Converting document to dark mode');
    els.renderWidget.hidden = false;
    // Snap positions back to 0% instantly before starting
    if (els.renderWidgetDrain) {
      els.renderWidgetDrain.style.transition = 'none';
      els.renderWidgetDrain.style.height = '100%';
    }
    if (els.renderWidgetFill) {
      els.renderWidgetFill.style.transition = 'none';
      els.renderWidgetFill.style.height = '0%';
    }
    void els.renderWidget.offsetWidth; // flush the snap
    if (els.renderWidgetDrain) els.renderWidgetDrain.style.transition = '';
    if (els.renderWidgetFill) els.renderWidgetFill.style.transition = '';
    els.renderWidget.dataset.state = 'running';
    setRenderProgress(0);
  }

  function setRenderProgress(pct) {
    if (!els.renderWidget) return;
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const drainH = 100 - p;
    const fillH = p;
    if (els.renderWidgetDrain) els.renderWidgetDrain.style.height = `${drainH}%`;
    if (els.renderWidgetFill) els.renderWidgetFill.style.height = `${fillH}%`;
    els.renderWidget.style.setProperty('--progress', `${p}%`);
    els.renderWidget.setAttribute('aria-valuenow', Math.round(p));
    if (els.renderWidgetPct) els.renderWidgetPct.textContent = `${Math.round(p)}%`;
  }

  // Finish the transfer, trigger the completion bloom & glow at 100%,
  // hold for a beat, then fade the whole widget out.
  function finishRenderProgress() {
    clearRenderTimers();
    if (!els.renderWidget) return;
    setRenderProgress(100);
    els.renderWidget.dataset.state = 'complete';
    rwFadeTimers.push(setTimeout(() => { els.renderWidget.dataset.state = 'fading'; }, 800));
    rwFadeTimers.push(setTimeout(hideRenderProgress, 1300));
  }

  function hideRenderProgress() {
    clearRenderTimers();
    if (!els.renderWidget) return;
    els.renderWidget.hidden = true;
    els.renderWidget.dataset.state = 'idle';
    renderAction = 'converting';
    if (els.renderWidgetLabel) els.renderWidgetLabel.textContent = 'Converting';
  }

  function exitToLanding() {
    fullToken++;
    previewToken++;
    clearTimeout(previewTimer);
    clearTimeout(fullTimer);
    clearTimeout(zoomDebounceTimer);
    clearTimeout(metaSaveTimer);
    if (converter && converter.abortWorker) {
      try { converter.abortWorker(); } catch (e) {}
    }
    hideRenderProgress();
    hideProgress();
    if (els.colorStudioDrawer) els.colorStudioDrawer.classList.remove('open');
    if (els.workspace) els.workspace.style.display = 'none';
    if (els.uploadSection) els.uploadSection.style.display = 'flex';
    if (els.fileInput) els.fileInput.value = '';
    state.originalBytes = null;
    state.convertedBytes = null;
    state.srcDoc = null;
    els.rememberDocument.checked = false;
    clearSession();
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
      if (token === fullToken) toast('Preservation could not be verified. Compare the original and export before relying on it.', 'error');
    }
  }

  /* ---- output-size estimate (calibrated in tests/size_calibration.js) ---- *
   * The PDF is re-saved with object streams, so original content carries       *
   * through at ~its original density; a small dark-ground stream is added per  *
   * page (~+10-18%). Single-stream-per-page PDFs sit at the low end.           */
  function estimateOutputSize(origSize, pageCount) {
    const p = Math.max(1, pageCount);
    return { lo: origSize * 0.95, hi: origSize * 1.35 + p * 45 + 500 };
  }

  // file chip shows  "<orig> → est ~<mid>"  before conversion, "<orig> → <actual>" after
  function showEstimatedSize() {
    const e = estimateOutputSize(state.fileSize, state.pageCount);
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
    els.rememberDocument.checked = false;
    await clearSession();
    try {
      showProgress('Reading PDF document...');
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
    showProgress('Rendering document...');

    try {
      state.srcDoc = await window.PDFLib.PDFDocument.load(state.originalBytes.slice(), { ignoreEncryption: true, updateMetadata: false });
    } catch (e) {
      // pdf.js will still render this file; pdf-lib (used for the fast
      // page-at-a-time preview) can't parse it, so the dark side comes from
      // the slower whole-document pass. Tell the user why previews lag.
      state.srcDoc = null;
      toast('Unusual PDF structure — dark rendering may take a moment longer.', 'info');
    }

    let info;
    try {
      info = await viewer.loadDocument(state.originalBytes.slice());
    } catch (err) {
      // Invalid/unreadable PDF: the workspace was already shown (pdf.js needs
      // visible layout dimensions to compute its first fit), but there's
      // nothing to show now -- back out to the upload screen instead of
      // leaving an empty, broken workspace with no way forward but the
      // manual back button.
      els.workspace.style.display = 'none';
      els.uploadSection.style.display = 'flex';
      state.originalBytes = null;
      state.srcDoc = null;
      hideProgress();
      throw err;
    }
    // Read the page count defensively: whatever loadDocument returned, the
    // viewer itself is the source of truth. A hiccup here must not abort the
    // dark conversion below.
    const pageCount = (info && info.numPages) || viewer.getPageCount() || 1;
    state.pageCount = pageCount;
    state.currentPage = 1;
    els.pageTotalDisplay.textContent = `/ ${state.pageCount}`;
    els.pageInput.value = 1;
    els.pageInput.max = state.pageCount;
    els.btnPrevPage.disabled = true;
    els.btnNextPage.disabled = state.pageCount <= 1;
    // viewer.loadDocument() fits page width automatically; slider syncs via onZoomChange
    showEstimatedSize();

    state.coverPages = new Set();
    const isCover = state.srcDoc && converter.isPageCover ? converter.isPageCover(state.srcDoc, 0) : false;
    if (isCover) state.coverPages.add(0);
    viewer.setPageIsImage(isCover);

    renderAction = 'converting';
    invalidateConversion();
    runPreview();
    scheduleFull();

    try {
      if (window.history && (!window.history.state || !window.history.state.darkPdfLoaded)) {
        window.history.pushState({ darkPdfLoaded: true }, '');
      }
    } catch (e) {}

    persistDocument();                 // only when device storage is enabled
    hideProgress();
  }

  async function loadDemoPdf() {
    els.rememberDocument.checked = false;
    await clearSession();
    try {
      showProgress('Building sample PDF...');
      state.coverPages = new Set();
      viewer.setPageIsImage(false);
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

      // ---- extra pages: give the preview a real 10-page document to page through
      const TOTAL = 10;
      const footer = (page, n) => {
        page.drawLine({ start: { x: 48, y: 56 }, end: { x: W - 48, y: 56 }, thickness: 0.75, color: rule });
        page.drawText('DarkPDF sample', { x: 48, y: 42, size: 8, font: F, color: muted });
        page.drawText(`Page ${n} / ${TOTAL}`, { x: W - 48 - 60, y: 42, size: 8, font: F, color: muted });
      };
      footer(P, 1);

      const bodyLines = [
        'Each page here is plain text plus vector geometry so the dark',
        'conversion has something real to chew on: selectable paragraphs,',
        'ruled lines, and a chart drawn from primitives rather than a raster.',
        'Use the page controls to step through all ten pages and confirm the',
        'preview, the page counter, and the dark render all stay in sync.',
      ];

      for (let n = 2; n <= TOTAL; n++) {
        const pg = doc.addPage([595, 792]);
        pg.drawText(`Section ${n - 1}`, { x: 48, y: 744, size: 20, font: B, color: rgb(0.10, 0.22, 0.55) });
        pg.drawText(`Page ${n} of ${TOTAL} — vector + text furniture`, { x: 48, y: 726, size: 10, font: F, color: muted });
        pg.drawLine({ start: { x: 48, y: 716 }, end: { x: W - 48, y: 716 }, thickness: 1, color: rule });

        bodyLines.forEach((ln, i) => {
          pg.drawText(ln, { x: 48, y: 690 - i * 16, size: 11, font: F, color: ink });
        });

        // A small bar chart whose values shift page to page.
        const gx = 48, gy = 360, gw = 300, gh = 180;
        pg.drawText('Weekly throughput', { x: gx, y: gy + gh + 14, size: 11, font: B, color: ink });
        pg.drawLine({ start: { x: gx, y: gy }, end: { x: gx + gw, y: gy }, thickness: 1, color: ink });
        pg.drawLine({ start: { x: gx, y: gy }, end: { x: gx, y: gy + gh }, thickness: 1, color: ink });
        const palette = [rgb(0.20, 0.55, 0.90), rgb(0.15, 0.70, 0.55), rgb(0.95, 0.65, 0.20), rgb(0.85, 0.30, 0.40), rgb(0.55, 0.45, 0.85), rgb(0.30, 0.60, 0.75)];
        for (let i = 0; i < 6; i++) {
          const h = 24 + ((n * 17 + i * 29) % 140);
          pg.drawRectangle({ x: gx + 16 + i * 46, y: gy + 1, width: 30, height: h, color: palette[i] });
          pg.drawText(`W${i + 1}`, { x: gx + 22 + i * 46, y: gy - 14, size: 9, font: F, color: muted });
        }

        footer(pg, n);
      }

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
      const range = 'All';
      let bytes = state.convertedBytes;
      if (!state.conversionFresh || state.conversionRange !== range || !bytes) {
        showProgress('Converting...', 5);
        setProgressCancellable(() => converter.abortWorker());   // the modal's 'x' aborts the worker
        // Off the main thread, same reasoning as runFull(): a full export on
        // a large document shouldn't freeze the modal's own progress updates
        // (or anything else) while pdf-lib's save() runs.
        const res = await converter.convertInWorker(state.originalBytes, {
          pageRange: range, onProgress: (p) => showProgress(p.message, p.percent)
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
      if (err && (err.cancelled || err.superseded)) return;   // user hit 'x' / a newer run took over
      console.error(err);
      toast('Error exporting PDF: ' + err.message, 'error');
    }
  }

  // Omit `pct` for phases with no measurable progress (initial PDF parse /
  // first render) — the modal shows pulsing dots instead of a fake bar.
  function showProgress(msg, pct) {
    els.progressModal.classList.add('visible');
    els.progressStatus.textContent = msg;
    const indeterminate = (pct == null);
    els.progressModal.classList.toggle('indeterminate', indeterminate);
    if (!indeterminate) {
      els.progressBar.style.width = `${pct}%`;
      els.progressPercent.textContent = `${Math.round(pct)}%`;
    }
  }
  // When set, the modal shows an 'x' that runs this to abort the running job.
  let progressCancelFn = null;
  function setProgressCancellable(fn) {
    progressCancelFn = fn || null;
    els.progressModal.classList.toggle('cancelable', !!fn);
  }
  const hideProgress = () => {
    els.progressModal.classList.remove('visible', 'cancelable');
    progressCancelFn = null;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
