// --- A tool call whose arguments are still streaming (#664) ---
//
// A runtime-driven backend draws a tool call while the model is still writing its arguments. Those arrive as
// JSON text a piece at a time, and until the text parses the call carries what has arrived so far under one
// key instead of its real arguments (`argsFromText` in `src/backends/rpc-shared.js`). The key is the app's
// own word, not a CLI's, and three places read it: the decoders that write it, Pi's normaliser that maps a
// finished call onto the viewer's renderers, and the viewer, which draws such a call as its raw input rather
// than handing a half-written object to a renderer that expects the finished one.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d by the main process and node
// tests (module.exports).

const PARTIAL_ARGS_KEY = '_partial';

/** True when a tool call's input is the text of arguments that have not finished arriving. */
function isPartialArgs(input) {
  return !!(input && typeof input === 'object' && typeof input[PARTIAL_ARGS_KEY] === 'string');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PARTIAL_ARGS_KEY, isPartialArgs };
}
