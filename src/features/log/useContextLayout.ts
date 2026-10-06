import { css } from '@emotion/css';
import { useEffect, useRef, useState } from 'react';

const flowingEntry = css`
  position: static !important;
`;
type Edge = 'before' | 'after';

/**
 * Grafana 12.2/12.3 pins the original row, even when it fills the viewport.
 * This is a guarded native-DOM adapter, not a public Grafana layout API.
 * Only this notice's modal is touched; unknown markup falls back to native unpin.
 */
export function useContextLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const jump = useRef<(edge: Edge) => void>();
  const [oversized, setOversized] = useState(false);

  useEffect(() => {
    const modal = ref.current?.closest('[role="dialog"]');
    const entry = modal?.querySelector<HTMLElement>('[data-testid="entry-row"]');
    const viewport = entry?.closest('table')?.parentElement;
    if (!entry || !viewport || !['auto', 'scroll'].includes(getComputedStyle(viewport).overflowY)) {
      return;
    }

    let active = true;
    let frame = 0;
    let wasOversized = false;
    let previousRows = 0;

    const align = (edge: Edge) => {
      const row = entry.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      const boundary = edge === 'before' ? row.top : row.bottom;
      viewport.scrollTop += boundary - view.top - viewport.clientHeight * (edge === 'before' ? 0.6 : 0.4);
    };
    jump.current = align;

    const measure = () => {
      if (!active || !entry.isConnected || !viewport.clientHeight) {
        return;
      }
      const large = entry.getBoundingClientRect().height > viewport.clientHeight * 0.6;
      entry.classList.toggle(flowingEntry, large);
      setOversized(large);

      // Count log records, not nested rows added by expanding log details.
      const rowCount = viewport.querySelectorAll('td.log-row-menu-cell').length;
      const row = entry.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      // Native initial loading re-centers the *middle* of a huge record. Show its
      // leading edge instead, so context/sentinels are reachable. Never adjust on
      // ordinary scrolling or repeatedly re-center an unchanged list.
      if (
        large &&
        (!wasOversized || rowCount !== previousRows) &&
        row.top < view.top &&
        row.bottom > view.bottom
      ) {
        align('before');
      }
      wasOversized = large;
      previousRows = rowCount;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    resize?.observe(entry);
    resize?.observe(viewport);
    const mutations = new MutationObserver(schedule);
    mutations.observe(viewport, { childList: true, subtree: true });
    // React can replace the native pin class after a user toggles pinning.
    mutations.observe(entry, { attributes: true, attributeFilter: ['class'] });
    measure();

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
      jump.current = undefined;
      entry.classList.remove(flowingEntry);
    };
  }, []);

  return { ref, oversized, jump: (edge: Edge) => jump.current?.(edge) };
}
