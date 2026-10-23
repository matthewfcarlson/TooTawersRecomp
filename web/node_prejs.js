// (web port) Under Node there is no page. The build hands main() a canvas at
// start-up (#ttmain: a stand-in that keeps the page's #screen free for the
// GPU renderer's WebGL; -sOFFSCREENCANVASES_TO_PTHREAD), and Emscripten looks
// it up in the document and transfers it. Here: a document with that one
// "canvas", whose transferable stand-in is a MessagePort. main() never draws
// on it; the GPU renderer has no canvas under Node (TT_WEB_HEADLESS).
if (typeof process == 'object' && typeof document == 'undefined' && typeof globalThis.ttNodeDocument == 'undefined') {
  globalThis.ttNodeDocument = true;
  globalThis.document = {
    querySelector: (sel) => sel === '#ttmain'
      ? { id: 'ttmain', width: 1, height: 1, transferControlToOffscreen: () => new MessageChannel().port1 }
      : null,
  };
}
