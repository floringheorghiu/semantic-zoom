// src/ui/diagrams/diagram-component.ts
//
// Mounts one DiagramProvider's output in place of a plain code block's
// <pre>: renders the SVG, wires svg-pan-zoom (pan/zoom is ephemeral,
// DOM-local view interaction — it never touches the store, same pattern as
// content-scale.ts), and — for diagrams with a non-empty DiagramGraph —
// attaches a click listener per node that dispatches DIAGRAM_NODE_SELECTED.
// The provider itself knows nothing about viewport/DOM wiring; this module
// is the only place that does.
import svgPanZoom from 'svg-pan-zoom';
import { getDiagramProvider, type DiagramGraph } from './provider';
import { actions$ } from '../../state/store';
import { diagramNodeSelected } from '../../state/actions';

export interface DiagramMountHandle {
  teardown: () => void;
}

let diagramSeq = 0;
/** container element → its teardown, so `teardownDiagramsIn` can find and
    release every mounted diagram under a subtree being torn down (D7 keyed
    reconciliation removes stale `.pgroup` nodes without knowing what's
    inside them). */
const handles = new WeakMap<HTMLElement, DiagramMountHandle>();

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * Best-effort match of a DiagramGraph node id to the SVG element Mermaid
 * rendered for it. Mermaid's node-group ids aren't a stable public API
 * (hence the graph is parsed from SOURCE, not this SVG — see provider.ts) —
 * this lookup is soft-fail: if a future Mermaid version changes its id
 * scheme, matching nodes here simply get no click listener; rendering,
 * pan, and zoom are unaffected either way.
 */
function findGraphNodeElement(svgEl: SVGSVGElement, nodeId: string): SVGElement | null {
  return (
    svgEl.querySelector<SVGElement>(`[id$="-${nodeId}-0"]`) ??
    svgEl.querySelector<SVGElement>(`[id$="-${nodeId}"]`) ??
    svgEl.querySelector<SVGElement>(`[id="${nodeId}"]`)
  );
}

export function mountDiagram(pre: HTMLElement, lang: string): DiagramMountHandle | null {
  const provider = getDiagramProvider(lang);
  if (!provider) return null;

  const source = pre.querySelector('code')?.textContent ?? '';
  const diagramId = `diagram-${++diagramSeq}`;

  const container = document.createElement('div');
  container.className = 'diagram';
  container.dataset.diagramId = diagramId;
  pre.replaceWith(container);

  const svgHost = document.createElement('div');
  svgHost.className = 'diagram__svg-host';
  container.appendChild(svgHost);

  const errorBadge = document.createElement('div');
  errorBadge.className = 'diagram__error';
  errorBadge.hidden = true;
  container.appendChild(errorBadge);

  const sourcePre = document.createElement('pre');
  sourcePre.className = 'diagram__source';
  sourcePre.hidden = true;
  const sourceCode = document.createElement('code');
  sourceCode.textContent = source;
  sourcePre.appendChild(sourceCode);
  container.appendChild(sourcePre);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'diagram__source-toggle';
  toggle.textContent = 'View source';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const nowHidden = !sourcePre.hidden;
    sourcePre.hidden = nowHidden;
    toggle.setAttribute('aria-expanded', String(!nowHidden));
    toggle.textContent = nowHidden ? 'View source' : 'View diagram';
  });
  container.appendChild(toggle);

  let panZoomInstance: SvgPanZoom.Instance | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let destroyed = false;

  function showError(message: string): void {
    svgHost.hidden = true;
    errorBadge.hidden = false;
    errorBadge.textContent = `Diagram error: ${message}`;
    sourcePre.hidden = false;
    toggle.hidden = true; // nothing to toggle to — source is the only view
  }

  function wireGraphClicks(graph: DiagramGraph, svgEl: SVGSVGElement): void {
    for (const node of graph.nodes) {
      const el = findGraphNodeElement(svgEl, node.id);
      if (!el) continue;
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        actions$.next(diagramNodeSelected(diagramId, node.id, node.label));
      });
    }
  }

  const validation = provider.validate(source);
  if (!validation.ok) {
    showError(validation.message);
  } else {
    provider
      .render(source, { theme: currentTheme() })
      .then((svg) => {
        if (destroyed) return;
        svgHost.hidden = false;
        svgHost.innerHTML = svg;
        const svgEl = svgHost.querySelector('svg');
        if (svgEl) {
          panZoomInstance = svgPanZoom(svgEl, {
            zoomEnabled: true,
            controlIconsEnabled: true,
            fit: true,
            center: true,
          });
          // `.diagram__svg-host` carries `resize: vertical` (diagrams.css)
          // so the user can drag it taller for a bigger diagram — but
          // svg-pan-zoom only measures the container once, at the line
          // above. Without this, dragging the handle would leave the
          // diagram mis-scaled inside its new box instead of re-fitting.
          // Guarded: ResizeObserver isn't available in the jsdom test
          // environment, and ITS OWN callback firing after teardown (a
          // resize mid-flight) must not touch a destroyed instance.
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => {
              if (destroyed || !panZoomInstance) return;
              panZoomInstance.resize();
              panZoomInstance.fit();
              panZoomInstance.center();
            });
            resizeObserver.observe(svgHost);
          }
          wireGraphClicks(provider.extractGraph(source), svgEl);
        }
      })
      .catch((err: unknown) => {
        if (destroyed) return;
        showError(err instanceof Error ? err.message : String(err));
      });
  }

  const handle: DiagramMountHandle = {
    teardown: () => {
      destroyed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      panZoomInstance?.destroy();
      panZoomInstance = null;
    },
  };
  handles.set(container, handle);
  return handle;
}

/** Tear down every mounted diagram under `root` (inclusive) — called before
    a stale `.pgroup` is `.remove()`'d by D7 keyed reconciliation, so a
    svg-pan-zoom instance's window-level listeners are never leaked. */
export function teardownDiagramsIn(root: ParentNode): void {
  const containers =
    root instanceof Element && root.matches('.diagram')
      ? [root as HTMLElement]
      : Array.from(root.querySelectorAll<HTMLElement>('.diagram'));
  for (const container of containers) {
    handles.get(container)?.teardown();
  }
}
