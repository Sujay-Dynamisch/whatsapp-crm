"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Progressive rendering for long lists: render the first `step` items,
 * then the next `step` each time the sentinel (an element placed after the
 * list) scrolls into view. Keeps the DOM small on pages that hold hundreds
 * of rows (inbox, callbacks, payments, …) without changing their data.
 *
 * `resetKey` — when it changes (a new filter / search), the window goes
 * back to the first page. `onEnd` — called when every loaded item is shown
 * and the sentinel is visible again (e.g. to fetch the next page from the
 * server).
 */
export function useIncrementalList<T>(
  items: T[],
  opts: { step?: number; resetKey?: unknown; onEnd?: () => void } = {},
) {
  const step = opts.step ?? 40;
  const [count, setCount] = useState(step);
  const [lastKey, setLastKey] = useState(opts.resetKey);
  // Reset during render (not in an effect) when the filter changes.
  if (lastKey !== opts.resetKey) {
    setLastKey(opts.resetKey);
    setCount(step);
  }

  const onEndRef = useRef(opts.onEnd);
  useEffect(() => {
    onEndRef.current = opts.onEnd;
  });
  const shownAll = count >= items.length;
  const shownAllRef = useRef(shownAll);
  useEffect(() => {
    shownAllRef.current = shownAll;
  }, [shownAll]);

  const observer = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!node || typeof IntersectionObserver === "undefined") return;
      observer.current = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          if (shownAllRef.current) onEndRef.current?.();
          else setCount((c) => c + step);
        },
        { rootMargin: "400px" },
      );
      observer.current.observe(node);
    },
    [step],
  );
  useEffect(() => () => observer.current?.disconnect(), []);

  return {
    visible: shownAll ? items : items.slice(0, count),
    hasMore: !shownAll,
    sentinelRef,
    showAll: () => setCount(items.length),
  };
}
