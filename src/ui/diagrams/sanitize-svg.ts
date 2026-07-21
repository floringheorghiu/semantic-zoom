// Mermaid's SVG output is live, interactive DOM inserted via `innerHTML` —
// materially higher risk than the app's existing static, HTML-escaped
// <pre><code> code-block path, and the app's CSP is disabled entirely
// (src-tauri/tauri.conf.json: "csp": null), so this sanitization is a real
// gate, not a backstop. `mermaid.initialize({ securityLevel: 'strict' })`
// (Task 5) additionally disables Mermaid's own click-directive JS execution
// at the source; this is the second, independent layer.
import DOMPurify from 'dompurify';

export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Explicit defense-in-depth on top of DOMPurify's SVG profile defaults
    // (which already exclude <script> and event-handler attributes).
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onclick', 'onerror', 'onmouseover'],
  });
}
