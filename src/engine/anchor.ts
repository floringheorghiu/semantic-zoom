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

/** Shared "just below the top edge" breathing gap (px). Also used by ⌘↓/⌘↑
    and the content-map via viewport.ts — one convention everywhere. */
export const TOP_GAP = 24;

/** Top-alignment math (§2.5, amended 2026-07-18): land `el` TOP_GAP below
    the viewport's top edge instead of centering it. */
export function topAlignScrollTop(
  el: { offsetTop: number },
  viewport: { clientHeight: number; scrollHeight: number },
  gap: number = TOP_GAP,
): number {
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return Math.min(Math.max(el.offsetTop - gap, 0), max);
}

/**
 * Anchor resolution (§2.5, amended 2026-07-18): the topmost ACTUALLY-VISIBLE
 * node — the node whose box contains the viewport's top edge, else the first
 * node starting below it, else (over-scrolled past everything) the
 * bottommost. Deliberately NOT "closest to the top edge": a node whose
 * bottom scrolled 2px above the edge is close but no longer being read.
 *
 * No caret parameter — scroll position is the only anchor signal. The caret
 * marker carries no visible UI (see design doc), so it must not steer
 * navigation the user cannot see happening.
 *
 * Single pass over the mounted boxes. The inputs are already plain cached
 * `offsetTop`/`offsetHeight` numbers, so there is NO `getBoundingClientRect`
 * in the loop — layout is never touched here.
 */
export function resolveAnchor(
  mounted: readonly MountedBox[],
  viewportTop: number,
): string | null {
  let firstBelow: MountedBox | null = null;
  let bottommost: MountedBox | null = null;
  for (const el of mounted) {
    if (el.offsetTop <= viewportTop && viewportTop < el.offsetTop + el.offsetHeight) {
      return el.id;
    }
    if (el.offsetTop > viewportTop && (!firstBelow || el.offsetTop < firstBelow.offsetTop)) {
      firstBelow = el;
    }
    if (!bottommost || el.offsetTop > bottommost.offsetTop) bottommost = el;
  }
  return (firstBelow ?? bottommost)?.id ?? null;
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
