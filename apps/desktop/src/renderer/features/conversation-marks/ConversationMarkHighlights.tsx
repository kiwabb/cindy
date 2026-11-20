/**
 * Paints the owner's marks inside the rendered messages with the CSS Custom Highlight API (no DOM
 * wrapping, so markdown, selection and copy are untouched). The message DOM is replaced by
 * virtualization and streaming, so ranges are rebuilt whenever the stream's subtree changes.
 * Styles: `::highlight(cindy-conversation-mark*)` in styles/globals.css.
 */
import { useEffect, useRef } from 'react';

import { markBodyOf } from '@/components/chat/SelectionQuoteButton';
import type { ConversationMark } from '../../../shared/conversationMarks';

export const MARK_HIGHLIGHT = 'cindy-conversation-mark';
export const MARK_DISCUSSED_HIGHLIGHT = 'cindy-conversation-mark-discussed';

/**
 * The stored excerpt carries the line breaks the selection pill added between blocks (paragraphs,
 * list items) that the DOM text does not have, so excerpt and DOM are compared without whitespace.
 */
const squash = (text: string) => text.replace(/\s+/g, '');

/** Finds `wanted` in `text` ignoring whitespace; returns offsets into the original `text`. */
function findIgnoringWhitespace(text: string, wanted: string): { start: number; end: number } | null {
  const positions: number[] = [];
  let flat = '';
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) continue;
    positions.push(i);
    flat += text[i];
  }
  const at = flat.indexOf(wanted);
  if (at < 0) return null;
  return { start: positions[at], end: positions[at + wanted.length - 1] + 1 };
}

/** Text nodes of `body` in document order with their starting offset (the same walk as Range#toString). */
function textNodesOf(body: HTMLElement): { nodes: Text[]; starts: number[]; text: string } {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += (node as Text).data;
  }
  return { nodes, starts, text };
}

function rangeAt(index: ReturnType<typeof textNodesOf>, start: number, end: number): Range | null {
  const locate = (offset: number, preferNext: boolean) => {
    for (let i = 0; i < index.nodes.length; i += 1) {
      const from = index.starts[i];
      const to = from + index.nodes[i].data.length;
      if (offset < to || (offset === to && !preferNext)) return { node: index.nodes[i], offset: offset - from };
    }
    return null;
  };
  const a = locate(start, true);
  const b = locate(end, false);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/**
 * The live range of a mark: its saved offsets when the text there still reads as the excerpt,
 * else the first place the excerpt occurs (the message re-rendered differently, or no offsets).
 */
export function locateMarkRange(message: HTMLElement, mark: Pick<ConversationMark, 'quote' | 'start' | 'end'>): Range | null {
  const body = markBodyOf(message);
  const index = textNodesOf(body);
  const wanted = squash(mark.quote.replace(/…$/, ''));
  if (!wanted) return null;
  if (mark.start !== undefined && mark.end !== undefined && mark.end <= index.text.length) {
    if (squash(index.text.slice(mark.start, mark.end)) === wanted) return rangeAt(index, mark.start, mark.end);
  }
  const found = findIgnoringWhitespace(index.text, wanted);
  return found ? rangeAt(index, found.start, found.end) : null;
}

export function ConversationMarkHighlights({
  containerRef,
  marks,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  marks: readonly ConversationMark[];
}) {
  // Rebuilt only when what is painted changes, not for an equal list in a new array.
  const signature = JSON.stringify(marks.map((mark) => [mark.messageClientId, mark.quote, mark.start, mark.end, mark.state]));
  const latest = useRef(marks);
  latest.current = marks;
  useEffect(() => {
    const marks = latest.current;
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
    const container = containerRef.current;
    // No marks: nothing to paint, so the streaming conversation is not watched at all.
    if (!registry || !container || typeof Highlight === 'undefined' || marks.length === 0) return;
    const open = new Highlight();
    const discussed = new Highlight();
    const paint = () => {
      open.clear();
      discussed.clear();
      for (const mark of marks) {
        const message = container.querySelector<HTMLElement>(
          `[data-message-client-id="${CSS.escape(mark.messageClientId)}"]`,
        );
        if (!message) continue;
        const range = locateMarkRange(message, mark);
        if (range) (mark.state === 'discussed' ? discussed : open).add(range);
      }
    };
    registry.set(MARK_HIGHLIGHT, open);
    registry.set(MARK_DISCUSSED_HIGHLIGHT, discussed);
    paint();
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (registry.get(MARK_HIGHLIGHT) === open) registry.delete(MARK_HIGHLIGHT);
      if (registry.get(MARK_DISCUSSED_HIGHLIGHT) === discussed) registry.delete(MARK_DISCUSSED_HIGHLIGHT);
    };
  }, [containerRef, signature]);
  return null;
}
