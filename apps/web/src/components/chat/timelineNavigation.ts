import { isTimelineScrollTarget } from "./timelineScrollTarget";

interface TimelineNavigationOptions {
  readonly getScrollNode: () => HTMLElement | null | undefined;
  readonly contentScrollsUp: () => boolean;
  readonly viewportIsAwayFromEnd: () => boolean;
  readonly onManualNavigation: () => void;
  readonly onScrollIntent: (intent: "toward-end" | "away-from-end") => void;
  readonly onWheelTowardEnd: () => void;
  readonly onScrollKey: (key: string) => void;
  readonly ignoreKeyEvent: (event: KeyboardEvent) => boolean;
}

/**
 * Reads the current timeline at each gesture: history can mount after hydration
 * or replace the list without changing the thread. Capture navigation before
 * list handlers can schedule another end pin; nested tool scrolling stays local.
 */
export function observeTimelineNavigation(options: TimelineNavigationOptions): () => void {
  const handleWheel = (event: WheelEvent) => {
    const scrollNode = options.getScrollNode();
    if (
      !scrollNode ||
      event.ctrlKey ||
      !isTimelineScrollTarget(event.target, scrollNode, event.deltaY)
    )
      return;
    if (event.deltaY > 0) {
      options.onScrollIntent("toward-end");
      options.onWheelTowardEnd();
    } else if (event.deltaY < 0) {
      options.onScrollIntent("away-from-end");
    }
    if (event.deltaY < 0 && options.contentScrollsUp()) options.onManualNavigation();
  };
  const handleTouchMove = (event: TouchEvent) => {
    const scrollNode = options.getScrollNode();
    if (
      scrollNode &&
      event.target instanceof Node &&
      scrollNode.contains(event.target) &&
      options.viewportIsAwayFromEnd()
    )
      options.onManualNavigation();
  };
  const handlePointerDown = (event: PointerEvent) => {
    const scrollNode = options.getScrollNode();
    if (!scrollNode || !(event.target instanceof Node) || !scrollNode.contains(event.target))
      return;
    if (event.target === scrollNode) {
      if (options.contentScrollsUp()) options.onManualNavigation();
    } else if (options.viewportIsAwayFromEnd()) {
      options.onManualNavigation();
    }
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    const scrollNode = options.getScrollNode();
    if (
      !scrollNode ||
      !(event.target instanceof Node) ||
      (!scrollNode.contains(event.target) &&
        event.target !== document.body &&
        event.target !== document.documentElement) ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      options.ignoreKeyEvent(event)
    )
      return;
    if (!["PageUp", "Home", "ArrowUp", "PageDown", "End", "ArrowDown"].includes(event.key)) return;
    const upward = ["PageUp", "Home", "ArrowUp"].includes(event.key);
    if (
      scrollNode.contains(event.target) &&
      !isTimelineScrollTarget(event.target, scrollNode, upward ? -1 : 1)
    )
      return;
    options.onScrollIntent(upward ? "away-from-end" : "toward-end");
    if (upward) {
      if (options.contentScrollsUp()) {
        options.onManualNavigation();
        options.onScrollKey(event.key);
      }
    } else {
      if (options.viewportIsAwayFromEnd()) options.onManualNavigation();
      options.onScrollKey(event.key);
    }
  };
  document.addEventListener("wheel", handleWheel, { passive: true, capture: true });
  document.addEventListener("touchmove", handleTouchMove, { passive: true, capture: true });
  document.addEventListener("pointerdown", handlePointerDown, { passive: true, capture: true });
  document.addEventListener("keydown", handleKeyDown);
  return () => {
    document.removeEventListener("wheel", handleWheel, true);
    document.removeEventListener("touchmove", handleTouchMove, true);
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown);
  };
}
