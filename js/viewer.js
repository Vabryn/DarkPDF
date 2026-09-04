/**
 * viewer.js
 * In-browser reader + before/after comparison surface.
 *
 * The dark side renders the ACTUAL converted PDF (a second pdf.js document),
 * not a canvas approximation — so the split slider and zoom show exactly what
 * Export produces, for every engine and every customization value.
 *
 * All renders are serialized through a mutex and every in-flight paint is
 * cancelled AND awaited before a new one starts, so pdf.js never sees two
 * concurrent renders on the same canvas.
 */

(function (window) {
  'use strict';

  class PDFViewer {
    constructor(containerEl) {
      this.container = containerEl;

      this.pdfDoc = null;        // original (light)
      this.darkDoc = null;       // converted (dark)
      this.darkIsPreview = false;

      this.currentPage = 1;
      this.totalPages = 0;
      this.zoomScale = 1.15;
      this.fitMode = true;                 // auto-fit until the user zooms manually
      this.fitStrategy = "view";           // "view" = whole page  |  "width" = fill pane width
      this.viewMode = 'split';
      this.sliderPosition = 50;
      this.isDraggingSlider = false;

      this._renderToken = 0;
      this._renderMutex = null;
      this._lightTask = null;
      this._darkTask = null;
      this._textTask = null;
      this._resizeTimer = null;
      this._resizeRaf = 0;
      this._renderedScale = 1;            // scale the visible bitmap was last painted at
      this._baseW = 0;                    // page size at scale 1 (cached for cheap resize math)
      this._baseH = 0;
      this.onZoomChange = null;            // app hook: fired with the effective % when fit recomputes

      this._initDom();
      this._bindEvents();
    }

    _initDom() {
      this.container.innerHTML = `
        <div class="pdf-viewer-wrapper">
          <div class="viewer-stage" id="viewerStage">
            <div class="page-container light-container" id="lightContainer"><canvas id="canvasLight" class="pdf-canvas"></canvas></div>
            <div class="page-container dark-container" id="darkContainer"><canvas id="canvasDark" class="pdf-canvas"></canvas></div>
            <div id="textLayer" class="textLayer"></div>
            <div class="split-slider" id="splitSlider" role="slider" aria-label="Compare original vs converted" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" title="Drag to compare original vs converted">
              <div class="slider-line"></div>
              <div class="slider-handle">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>
              </div>
            </div>
            <div class="view-badge light-badge" id="lightBadge">Original Light</div>
            <div class="view-badge dark-badge" id="darkBadge">Lossless Dark</div>
          </div>
        </div>`;

      const q = (id) => this.container.querySelector('#' + id);
      this.wrapper = this.container.querySelector('.pdf-viewer-wrapper');
      this.stage = q('viewerStage');
      this.lightContainer = q('lightContainer');
      this.darkContainer = q('darkContainer');
      this.canvasLight = q('canvasLight');
      this.canvasDark = q('canvasDark');
      this.textLayer = q('textLayer');
      this.splitSlider = q('splitSlider');
      this.lightBadge = q('lightBadge');
      this.darkBadge = q('darkBadge');
    }

    _bindEvents() {
      const onDown = (e) => {
        if (this.viewMode !== 'split') return;
        this.isDraggingSlider = true;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!this.isDraggingSlider) return;
        const rect = this.stage.getBoundingClientRect();
        const x = e.touches ? e.touches[0].clientX : e.clientX;
        this.setSliderPosition(Math.max(0, Math.min(100, ((x - rect.left) / rect.width) * 100)));
      };
      const onUp = () => {
        if (!this.isDraggingSlider) return;
        this.isDraggingSlider = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      this.splitSlider.addEventListener('mousedown', onDown);
      this.splitSlider.addEventListener('touchstart', onDown, { passive: false });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchend', onUp);

      // While the window is being dragged we don't re-render on every frame —
      // that is what caused the flashing / lag. Instead the already-painted
      // bitmap is CSS-scaled to the new fit in real time (cheap, GPU), and the
      // crisp re-render happens once, after the drag settles.
      const onResize = () => {
        if (this.fitMode && !this._resizeRaf) {
          this._resizeRaf = requestAnimationFrame(() => { this._resizeRaf = 0; this._previewFit(); });
        }
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => { if (this.fitMode) this._fit(this.fitStrategy); }, 180);
      };
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
    }

    /** Inner size of the scroll container available for a page (minus padding). */
    _availableBox() {
      const box = this.container.closest('.stage-viewport') || this.container;
      const cs = getComputedStyle(box);
      const px = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const py = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      return { w: Math.max(120, box.clientWidth - px), h: Math.max(160, box.clientHeight - py) };
    }

    /** target fit scale for a strategy, from cached page dimensions (no async). */
    _fitScale(strategy) {
      if (!this._baseW || !this._baseH) return this.zoomScale;
      const box = this._availableBox();
      const s = strategy === 'width'
        ? box.w / this._baseW
        : Math.min(box.w / this._baseW, box.h / this._baseH);
      return Math.max(0.25, Math.min(4, s));
    }

    /** Real-time, render-free resize feedback: CSS-scale the current frame.
     *  The wrapper's layout box is resized to the scaled dimensions too, so
     *  `margin: 0 auto` keeps the page centred instead of letting the old
     *  (larger) box shove the shrunk page off toward one side. */
    _previewFit() {
      if (!this.fitMode || !this._renderedScale || !this._baseW) return;
      const target = this._fitScale(this.fitStrategy);
      const css = target / this._renderedScale;
      this.stage.style.transformOrigin = 'top left';
      this.stage.style.transform = `scale(${css})`;
      this.wrapper.style.width = `${Math.round(target * this._baseW)}px`;
      this.wrapper.style.height = `${Math.round(target * this._baseH)}px`;
      if (this.onZoomChange) this.onZoomChange(Math.round(target * 100));
    }

    /** drop every trace of the CSS resize preview */
    _clearPreview() {
      this.stage.style.transform = 'none';
      this.wrapper.style.width = '';
      this.wrapper.style.height = '';
    }

    /** strategy 'view' = whole page inside the pane; 'width' = fill the pane width */
    async _fit(strategy) {
      this.fitMode = true;
      this.fitStrategy = strategy;
      if (!this.pdfDoc) return;
      let scale = 1;
      try {
        const vp = (await this.pdfDoc.getPage(this.currentPage)).getViewport({ scale: 1 });
        this._baseW = vp.width; this._baseH = vp.height;
        const box = this._availableBox();
        scale = strategy === 'width' ? box.w / vp.width : Math.min(box.w / vp.width, box.h / vp.height);
      } catch (e) { return; }
      scale = Math.max(0.25, Math.min(4, scale));
      if (Math.abs(scale - this.zoomScale) > 0.002) {
        this.zoomScale = scale;
        await this.renderCurrentPage();          // clears the preview on paint
      } else {
        this._clearPreview();                    // settled on the same scale
      }
      if (this.onZoomChange) this.onZoomChange(Math.round(scale * 100));
    }

    fitToView() { return this._fit('view'); }
    fitToWidth() { return this._fit('width'); }

    setSliderPosition(percent) {
      this.sliderPosition = percent;
      this.splitSlider.style.left = `${percent}%`;
      this.darkContainer.style.clipPath = `polygon(${percent}% 0, 100% 0, 100% 100%, ${percent}% 100%)`;
      this.lightContainer.style.clipPath = `polygon(0 0, ${percent}% 0, ${percent}% 100%, 0 100%)`;
      this.splitSlider.setAttribute('aria-valuenow', Math.round(percent));
    }

    setViewMode(mode) {
      this.viewMode = mode;
      this.stage.className = `viewer-stage mode-${mode}`;
      const showBadges = mode === 'split';
      this.lightBadge.hidden = !showBadges;
      this.darkBadge.hidden = !showBadges;
      this.splitSlider.hidden = mode !== 'split';

      if (mode === 'split') {
        this.lightContainer.style.display = 'block';
        this.darkContainer.style.display = 'block';
        this.setSliderPosition(this.sliderPosition);
      } else {
        const on = mode === 'dark' ? this.darkContainer : this.lightContainer;
        const off = mode === 'dark' ? this.lightContainer : this.darkContainer;
        on.style.clipPath = 'none';
        on.style.display = 'block';
        off.style.display = 'none';
      }
    }

    /** Manual zoom from the slider — leaves fit-mode. */
    setZoom(scale) {
      this.fitMode = false;
      this.zoomScale = Math.max(0.4, Math.min(4, scale));
      if (this.pdfDoc) this.renderCurrentPage();
    }

    /* ---- document loading ---- */
    _configurePdfJs() {
      if (!window.pdfjsLib) throw new Error('pdf.js not loaded.');
      if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';
      }
    }

    _docParams(data) {
      // pdf.js detaches the data buffer — hand it a private copy so the caller's bytes survive
      const params = {
        data: data instanceof Uint8Array ? data.slice(0) : new Uint8Array(data),
        useSystemFonts: true, isEvalSupported: false
      };
      if (window.__DARKPDF_HAS_CMAPS__) { params.cMapUrl = 'js/vendor/cmaps/'; params.cMapPacked = true; }
      return params;
    }

    async loadDocument(pdfData) {
      this._configurePdfJs();
      if (this.pdfDoc) { try { await this.pdfDoc.destroy(); } catch (e) {} }
      if (this.darkDoc) { try { await this.darkDoc.destroy(); } catch (e) {} this.darkDoc = null; }

      this.pdfDoc = await window.pdfjsLib.getDocument(this._docParams(pdfData)).promise;
      this.totalPages = this.pdfDoc.numPages;
      this.currentPage = 1;
      this.fitToView();                      // fire-and-forget: workspace must not block on painting
      return { numPages: this.totalPages };
    }

    async setDarkDocument(bytes, isPreview) {
      this._configurePdfJs();
      const token = ++this._renderToken;
      let doc;
      try { doc = await window.pdfjsLib.getDocument(this._docParams(bytes)).promise; }
      catch (e) { console.warn('dark document load failed', e); return; }
      if (token !== this._renderToken) { try { await doc.destroy(); } catch (e) {} return; }
      if (this.darkDoc) { try { await this.darkDoc.destroy(); } catch (e) {} }
      this.darkDoc = doc;
      this.darkIsPreview = !!isPreview;
      this.renderCurrentPage();
    }

    async goToPage(pageNum) {
      if (!this.pdfDoc || pageNum < 1 || pageNum > this.totalPages) return;
      this.currentPage = pageNum;
      if (this.fitMode) await this.fitToView();
      else await this.renderCurrentPage();
    }

    /* ---- rendering ---- */
    renderCurrentPage() {
      if (!this.pdfDoc) return Promise.resolve();
      const token = ++this._renderToken;
      for (const t of [this._lightTask, this._darkTask, this._textTask]) {
        if (t && t.cancel) { try { t.cancel(); } catch (e) {} }
      }
      this._renderMutex = (this._renderMutex || Promise.resolve()).catch(() => {}).then(() => this._doRender(token));
      return this._renderMutex;
    }

    /**
     * Paint one page onto one canvas. Renders to an OFF-SCREEN canvas first,
     * then blits the finished frame onto the visible canvas in a single sync
     * op — the visible canvas never shows a cleared / half-drawn state, so
     * there is no flash when zooming or re-converting. Any prior task on this
     * slot is cancelled AND awaited before the new one starts.
     */
    async _paint(slot, canvas, page, tf, token) {
      const prev = this[slot];
      if (prev) {
        try { prev.cancel(); } catch (e) {}
        try { await prev.promise; } catch (e) {}
        if (this[slot] === prev) this[slot] = null;
      }
      if (token !== this._renderToken) return;

      const vp = page.getViewport({ scale: this.zoomScale });
      const dw = Math.max(1, Math.floor(vp.width * tf[0]));
      const dh = Math.max(1, Math.floor(vp.height * tf[0]));

      const off = document.createElement('canvas');
      off.width = dw;
      off.height = dh;
      const task = page.render({ canvasContext: off.getContext('2d'), viewport: vp, transform: tf });
      this[slot] = task;
      try {
        await task.promise;
      } catch (e) {
        if (this[slot] === task) this[slot] = null;
        return;                                   // cancelled / superseded — keep the current frame
      }
      if (this[slot] === task) this[slot] = null;
      if (token !== this._renderToken) return;

      // Resize + blit happen in the same tick: no flash. CSS keeps the canvas
      // at 100% of its container (see .pdf-canvas) instead of an explicit px
      // size — light and dark repaint on separate awaits, so whichever one
      // hasn't finished yet would otherwise sit at its old pixel size inside
      // an already-resized stage, exposing the white page background in the
      // gap. At 100% it always fills the stage (stretching its stale bitmap
      // for the instant before its own repaint lands), so there is never a gap.
      canvas.width = dw;
      canvas.height = dh;
      canvas.getContext('2d').drawImage(off, 0, 0);
    }

    async _doRender(token) {
      if (!this.pdfDoc || token !== this._renderToken) return;
      const page = await this.pdfDoc.getPage(this.currentPage);
      if (token !== this._renderToken) return;

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: this.zoomScale });
      const w = Math.floor(vp.width), h = Math.floor(vp.height);
      const tf = [ratio, 0, 0, ratio, 0, 0];
      this._baseW = vp.width / this.zoomScale;
      this._baseH = vp.height / this.zoomScale;
      this._renderedScale = this.zoomScale;
      this._clearPreview();                        // this frame is painted at the real scale
      this.stage.style.width = `${w}px`;
      this.stage.style.height = `${h}px`;

      await this._paint('_lightTask', this.canvasLight, page, tf, token);
      if (token !== this._renderToken) return;

      if (this.darkDoc) {
        const dpage = await this.darkDoc.getPage(Math.min(this.currentPage, this.darkDoc.numPages));
        if (token !== this._renderToken) return;
        await this._paint('_darkTask', this.canvasDark, dpage, tf, token);
        if (token !== this._renderToken) return;
      } else {
        // no converted doc yet — neutral dark placeholder so the split isn't blank
        this.canvasDark.width = Math.floor(w * ratio);
        this.canvasDark.height = Math.floor(h * ratio);
        const c = this.canvasDark.getContext('2d');
        c.setTransform(ratio, 0, 0, ratio, 0, 0);
        c.fillStyle = '#1b1b1b';
        c.fillRect(0, 0, w, h);
      }

      await this._renderTextLayer(page, vp, token);

      this.darkBadge.textContent = this.darkIsPreview ? 'Dark (live preview)' : 'Lossless Dark';
      if (this.viewMode === 'split') this.setSliderPosition(this.sliderPosition);
    }

    async _renderTextLayer(page, viewport, token) {
      this.textLayer.innerHTML = '';
      this.textLayer.style.width = `${Math.floor(viewport.width)}px`;
      this.textLayer.style.height = `${Math.floor(viewport.height)}px`;
      this.textLayer.style.setProperty('--scale-factor', this.zoomScale);

      let textContent;
      try { textContent = await page.getTextContent(); } catch (e) { return; }
      if (token !== this._renderToken || !window.pdfjsLib.renderTextLayer) return;

      this._textTask = window.pdfjsLib.renderTextLayer({ textContentSource: textContent, container: this.textLayer, viewport, textDivs: [] });
      try { await this._textTask.promise; } catch (e) {}
    }
  }

  window.PDFViewer = PDFViewer;
})(typeof window !== 'undefined' ? window : this);
