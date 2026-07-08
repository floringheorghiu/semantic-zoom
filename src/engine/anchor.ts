import type { LookupTable, ResolvedIndex, ZoomLevel } from './schema';

/**
 * Context the cross-level mapping table (§2.5) reads from. Carries the
 * O(1) index, the raw table (for `sections[S].children[0]` /
 * `meta[M].children[0]` first-child fallbacks) and the "remembered place"
 * maps kept in the store.
 */
export interface MapCtx {
  index: ResolvedIndex;
  table: LookupTable;
  lastCaretIn: Map<string, string>;   // S-id → P-id
  lastAnchorIn: Map<string, string>;  // M-id → S-id
}

/** A mounted node's cached layout box — plain numbers, never a live DOM read. */
export interface MountedBox {
  id: string;
  offsetTop: number;
  offsetHeight: number;
}

// centerScrollTop — transcribed VERBATIM from §2.5.
export function centerScrollTop(
  el: { offsetTop: number; offsetHeight: number },
  viewport: { clientHeight: number; scrollHeight: number }
): number {
  const ideal = el.offsetTop + el.offsetHeight / 2 - viewport.clientHeight / 2;
  return Math.max(0, Math.min(ideal, viewport.scrollHeight - viewport.clientHeight));
}

/**
 * Anchor resolution (§2.5): if the read-only caret is placed in a paragraph,
 * that paragraph IS the anchor. Otherwise pick the mounted node whose rendered
 * vertical center is closest to the viewport center.
 *
 * Single pass over the mounted boxes. The inputs are already plain cached
 * `offsetTop`/`offsetHeight` numbers, so there is NO `getBoundingClientRect`
 * in the loop — layout is never touched here.
 */
export function resolveAnchor(
  caretParagraphId: string | null | undefined,
  mounted: readonly MountedBox[],
  viewportCenter: number
): string | null {
  if (caretParagraphId) return caretParagraphId;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const el of mounted) {
    const center = el.offsetTop + el.offsetHeight / 2;
    const dist = Math.abs(center - viewportCenter);
    if (dist < bestDist) {
      bestDist = dist;
      best = el.id;
    }
  }
  return best;
}

/**
 * Record the place we are LEAVING, so zooming back in feels "remembered"
 * (§2.5, `lastCaretIn` / `lastAnchorIn`).
 *
 * The whole ancestor chain is written, not just one link. Leaving level 0 we
 * know both the paragraph within its section AND the section within its meta;
 * recording only `lastCaretIn[S]` would make `0 → −2 → 0` forget the section
 * (`mapAcrossLevels('-2->-1')` would fall back to `meta[M].children[0]`) and so
 * land on the wrong paragraph.
 *
 * Leaving −1 records only `lastAnchorIn` — a DEEPER memory (`lastCaretIn[S]`)
 * from an earlier visit must survive, which is what makes the two-hop
 * `−2 → −1 → 0` restore the exact paragraph you were reading.
 */
export function recordPlace(
  source: ZoomLevel,
  anchorId: string,
  index: ResolvedIndex,
  lastCaretIn: Map<string, string>,
  lastAnchorIn: Map<string, string>,
): void {
  if (source === 0) {
    // anchor is a P: remember it in its S, and remember that S in its M.
    const s = index.parentOfParagraph.get(anchorId);
    if (s) {
      lastCaretIn.set(s, anchorId);
      const m = index.parentOfSection.get(s);
      if (m) lastAnchorIn.set(m, s);
    }
  } else if (source === -1) {
    // anchor is an S: remember it in its M. Never clobber lastCaretIn.
    const m = index.parentOfSection.get(anchorId);
    if (m) lastAnchorIn.set(m, anchorId);
  }
  // source === -2: the meta level is the root — nothing above it to remember.
}

/**
 * Cross-level mapping (§2.5 table). Maps the source-level anchor to its
 * semantic relative at the target level. Pure, synchronous, O(1) — the −2 → 0
 * row composes two single-step reads.
 */
export function mapAcrossLevels(
  from: ZoomLevel,
  to: ZoomLevel,
  anchor: string,
  ctx: MapCtx
): string {
  if (from === to) return anchor;
  const { index, table, lastCaretIn, lastAnchorIn } = ctx;
  switch (`${from}->${to}`) {
    case '0->-1': // parentOfParagraph.get(anchor)
      return index.parentOfParagraph.get(anchor)!;
    case '0->-2': // parentOfSection.get(parentOfParagraph.get(anchor))
      return index.parentOfSection.get(index.parentOfParagraph.get(anchor)!)!;
    case '-1->0': // lastCaretIn[S] ?? sections[S].children[0]
      return lastCaretIn.get(anchor) ?? table.sections[anchor].children[0];
    case '-1->-2': // parentOfSection.get(anchor)
      return index.parentOfSection.get(anchor)!;
    case '-2->-1': // lastAnchorIn[M] ?? meta[M].children[0]
      return lastAnchorIn.get(anchor) ?? table.meta[anchor].children[0];
    case '-2->0': { // two-hop: −2 → −1 then −1 → 0 (still O(1))
      const section = mapAcrossLevels(-2, -1, anchor, ctx);
      return mapAcrossLevels(-1, 0, section, ctx);
    }
    default:
      throw new Error(`unreachable level pair ${from}->${to}`);
  }
}
