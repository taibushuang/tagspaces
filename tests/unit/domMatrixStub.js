/**
 * pdfjs-dist references browser globals at module-init time. Renderer modules
 * that transitively import it (e.g. AgentTools -> thumbsgenerator) would
 * otherwise fail to import in Node. Import this stub BEFORE such modules —
 * ESM evaluates imports in source order. The stub is never exercised; tests
 * that actually render PDFs run in the browser suite.
 */
if (typeof globalThis.DOMMatrix === 'undefined') {
  class DOMMatrix {
    constructor() {}

    static fromMatrix() {
      return new DOMMatrix();
    }

    static fromFloat32Array() {
      return new DOMMatrix();
    }

    static fromFloat64Array() {
      return new DOMMatrix();
    }
  }
  globalThis.DOMMatrix = DOMMatrix;
}

export default undefined;
