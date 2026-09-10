/**
 * converter.worker.js
 * Runs the Standard (stream-remap) conversion off the main thread. pdf-lib's
 * final PDFDocument.save() for a large document is a single, unyielding
 * call -- nothing inside it can be paused -- so on the main thread it would
 * freeze page navigation and the live preview for however long it takes.
 * Off the main thread, that same call can run as long as it needs to
 * without blocking anything the user is doing.
 *
 * One worker = one job. The main thread cancels a superseded job by calling
 * worker.terminate() outright rather than message-passing a cancellation --
 * termination is immediate and unconditional, so a stale conversion can't
 * keep burning CPU (or finish a multi-second save()) after the user has
 * already moved on to something else.
 */
importScripts('vendor/pdf-lib.min.js', 'stream-parser.js', 'converter.js');

self.onmessage = async (e) => {
  const { pdfBytes, pageRange, customConfig } = e.data;
  try {
    const converter = new self.PDFConverter();
    if (customConfig) converter.updateColorConfig(customConfig);
    const res = await converter.convert(pdfBytes, {
      pageRange,
      onProgress: (p) => self.postMessage({ type: 'progress', percent: p.percent, message: p.message })
    });
    self.postMessage(
      { type: 'done', pdfBytes: res.pdfBytes, pageCount: res.pageCount, stats: res.stats, durationMs: res.durationMs },
      [res.pdfBytes.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
