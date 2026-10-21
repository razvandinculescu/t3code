import { useStableCallback } from "../../hooks/useStableCallback";
import {
  eventPathContainsSelector,
  TYPE_TO_FOCUS_EDITABLE_SELECTOR,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
} from "./composerFocusRedirect";
import { type MessageId, type ThreadId, type RunId } from "@t3tools/contracts";
import { CHAT_LIST_ANCHOR_OFFSET } from "@t3tools/shared/chatList";
import { Debouncer } from "@tanstack/react-pacer";
import {
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type LegendListRef } from "@legendapp/list/react";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  timelineContentOverflowsViewport,
  readTimelinePosition,
  observeTimelineRun,
  type TimelineRunObservation,
  type TimelineScrollMode,
} from "./timelineScrollAnchoring";
import { type ChatComposerHandle } from "./ChatComposer";
import { createPageScrollController, type PageScrollKey } from "./pageScrollController";
import { createUpwardScrollDetector } from "./timelineScrollTarget";
import { observeTimelineNavigation } from "./timelineNavigation";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { shouldReleaseTimelineAnchorForToolActivity } from "../ChatView.logic";
import { releaseChatTimelineAnchor } from "../ChatView.logic";
import type { Dispatch, RefObject } from "react";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { deriveThreadActivityRun } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { TimelineEntry } from "../../session-logic";

const TIMELINE_SCROLL_CANCEL_SENTINEL = Object.freeze({});

interface TimelineAnchor {
  readonly threadKey: string | null;
  readonly messageId: MessageId | null;
}

interface TimelineFollowInput {
  readonly legendListRef: RefObject<LegendListRef | null>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly composerOverlayElement: HTMLDivElement | null;
  readonly composerTimelineInset: number;
  readonly routeThreadKey: string;
  readonly activeThreadKey: string | null;
  readonly activeThreadId: ThreadId | undefined;
  readonly isServerThread: boolean;
  readonly serverProjection: EnvironmentThread["projection"] | null;
  readonly threadStatus: EnvironmentThreadStatus;
  readonly activeActivityRun: ReturnType<typeof deriveThreadActivityRun>;
  readonly activeRunningTurnId: RunId | null;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly timelineAnchorMessageId: MessageId | null;
  readonly setTimelineAnchor: Dispatch<SetStateAction<TimelineAnchor>>;
}

/**
 * Keeps the timeline following the live end, anchoring a newly sent turn near
 * the top, and letting the user scroll away. The scroll handlers read refs, so
 * a scroll gesture does not re-render ChatView unless the follow mode flips.
 */
export function useTimelineFollow(input: TimelineFollowInput) {
  const {
    legendListRef,
    composerRef,
    composerOverlayElement,
    composerTimelineInset,
    routeThreadKey,
    activeThreadKey,
    activeThreadId,
    isServerThread,
    serverProjection,
    threadStatus,
    activeActivityRun,
    activeRunningTurnId,
    timelineEntries,
    timelineAnchorMessageId,
    setTimelineAnchor,
  } = input;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const isAtEndRef = useRef(true);
  const isTimelineAtLogicalEnd = () =>
    resolveTimelineIsAtEnd(legendListRef.current?.getState()) ?? isAtEndRef.current;
  const isTimelineAtLogicalEndStable = useStableCallback(isTimelineAtLogicalEnd);
  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollIntentRef = useRef<"toward-end" | "away-from-end" | null>(null);
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  // State mirror of the follow mode refs. LegendList's maintainScrollAtEnd
  // re-pins on its own (independent of the refs), so the timeline needs a
  // render-visible flag to switch it off once the user scrolls away.
  const [timelineLiveFollowEnabled, setTimelineLiveFollowEnabled] = useState(true);
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null);
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const observedTimelineActivityRef = useRef<TimelineRunObservation | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const cancelPositionRestoreRef = useRef<(() => void) | null>(null);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const followRepinFrameRef = useRef<number | null>(null);
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: MessageId;
    readonly offset: number;
    readonly userScrollGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);
  const cancelTimelineLiveFollowForUserNavigation = () => {
    cancelPositionRestoreRef.current?.();
    anchorUserScrollGenerationRef.current += 1;
    const wasProgrammaticScrollMode = timelineScrollModeRef.current !== "free-scrolling";
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    setTimelineLiveFollowEnabled(false);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }
    if (wasProgrammaticScrollMode) {
      // While following or anchoring, our scrollToEnd/scrollToOffset calls can
      // sit in LegendList's pending-imperative-scroll queue (it defers them
      // while layout settles) and fire seconds later with stale targets,
      // yanking the view away after the user scrolled. Starting a new
      // imperative scroll cancels everything queued; targeting an item that
      // is not in the data makes the new request itself resolve without ever
      // scrolling, so this is a pure cancel.
      void legendListRef.current?.scrollToItem({
        item: TIMELINE_SCROLL_CANCEL_SENTINEL,
        animated: false,
      });
      // An already-started animated scroll (behavior: smooth) keeps running in
      // the browser regardless of the queue; a same-position instant write is
      // the only way to halt it where it is.
      const scrollNode = legendListRef.current?.getScrollableNode() as
        | { scrollTop?: number }
        | null
        | undefined;
      const currentScrollTop = scrollNode?.scrollTop;
      if (scrollNode && typeof currentScrollTop === "number") {
        scrollNode.scrollTop = currentScrollTop;
      }
    }
  };
  const cancelTimelineLiveFollowForUserNavigationStable = useStableCallback(
    cancelTimelineLiveFollowForUserNavigation,
  );
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigationStable,
  );
  useEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForUserNavigationStable;
  }, [cancelTimelineLiveFollowForUserNavigationStable]);
  useEffect(() => {
    const previous = observedTimelineActivityRef.current;
    const dispatchedUserItem =
      previous?.hydrated &&
      previous.threadKey === activeThreadKey &&
      activeActivityRun !== null &&
      previous.runId !== activeActivityRun.runId
        ? serverProjection?.visibleTurnItems.find(
            (row) => row.item.type === "user_message" && row.item.runId === activeActivityRun.runId,
          )
        : undefined;
    const { observation, anchorMessageId: messageId } = observeTimelineRun(previous, {
      threadKey: activeThreadKey,
      hydrated: !isServerThread || (serverProjection !== null && threadStatus === "live"),
      runId: activeActivityRun?.runId ?? null,
      queued: activeActivityRun?.status === "queued",
      messageId:
        dispatchedUserItem?.item.type === "user_message" ? dispatchedUserItem.item.messageId : null,
    });
    observedTimelineActivityRef.current = observation;
    if (messageId === null) return;
    if (
      pendingTimelineAnchorRef.current !== null ||
      timelineScrollModeRef.current === "free-scrolling"
    ) {
      return;
    }

    isAtEndRef.current = true;
    timelineScrollModeRef.current = "anchoring-new-turn";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    pendingTimelineAnchorRef.current = messageId;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor({ threadKey: activeThreadKey, messageId });
  }, [
    activeActivityRun,
    activeThreadKey,
    isServerThread,
    serverProjection,
    setTimelineAnchor,
    threadStatus,
  ]);
  const timelineRealContentOverflowsViewport = (list?: LegendListRef | null) =>
    timelineContentOverflowsViewport((list ?? legendListRef.current)?.getState(), {
      composerInset: composerTimelineInset,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
  const timelineRealContentOverflowsViewportStable = useStableCallback(
    timelineRealContentOverflowsViewport,
  );
  const pageScrollControllerRef = useRef<ReturnType<typeof createPageScrollController> | null>(
    null,
  );
  const handlePageScrollStart = useEffectEvent((key: PageScrollKey) => {
    timelineScrollIntentRef.current = key === "PageUp" ? "away-from-end" : "toward-end";
    composerRef.current?.collapseForTimelineScrollKey(key);
    if (
      (key === "PageUp" && timelineRealContentOverflowsViewportStable()) ||
      !isTimelineAtLogicalEndStable()
    ) {
      cancelTimelineLiveFollowForUserNavigationStable();
    }
  });
  useEffect(() => {
    const controller = createPageScrollController({
      getContainer: () => legendListRef.current?.getScrollableNode() ?? null,
      getScrollPaddingBottomPx: () => composerOverlayElement?.getBoundingClientRect().height ?? 0,
      onScrollStart: handlePageScrollStart,
    });
    pageScrollControllerRef.current = controller;

    return () => {
      controller.dispose();
      if (pageScrollControllerRef.current === controller) {
        pageScrollControllerRef.current = null;
      }
    };
  }, [composerOverlayElement, legendListRef]);
  const onComposerPageScrollKeyDown = (key: PageScrollKey) => {
    pageScrollControllerRef.current?.handleKeyDown(key);
  };
  const onComposerPageScrollKeyDownStable = useStableCallback(onComposerPageScrollKeyDown);
  const onComposerPageScrollKeyUp = (key: string) => {
    pageScrollControllerRef.current?.handleKeyUp(key);
  };
  const onComposerPageScrollKeyUpStable = useStableCallback(onComposerPageScrollKeyUp);
  const onComposerPageScrollRelease = () => {
    pageScrollControllerRef.current?.releaseActiveKey();
  };
  const onComposerPageScrollReleaseStable = useStableCallback(onComposerPageScrollRelease);
  const scrollToEnd = (animated: boolean = false) => {
    cancelPositionRestoreRef.current?.();
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor(releaseChatTimelineAnchor);
    // The anchored end space must be gone before the scroll measures, or the
    // list lands short of the real end (#6519).
    requestAnimationFrame(() => {
      void legendListRef.current?.scrollToEnd?.({
        animated: animated && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
    });
  };
  const scrollToEndStable = useStableCallback(scrollToEnd);
  useEffect(() => {
    const composer = composerRef;
    return observeTimelineNavigation({
      getScrollNode: () => legendListRef.current?.getScrollableNode(),
      contentScrollsUp: timelineRealContentOverflowsViewportStable,
      viewportIsAwayFromEnd: () =>
        resolveTimelineIsAtEnd(legendListRef.current?.getState()) === false,
      onManualNavigation: () => cancelTimelineLiveFollowForUserNavigationRef.current(),
      onScrollIntent: (intent) => {
        timelineScrollIntentRef.current = intent;
      },
      onWheelTowardEnd: () => {
        if (isAtEndRef.current) composer.current?.restoreAfterTimelineReachedEnd();
      },
      onScrollKey: (key) => {
        composer.current?.collapseForTimelineScrollKey(key);
        if (["PageDown", "End", "ArrowDown"].includes(key) && isTimelineAtLogicalEndStable()) {
          composer.current?.restoreAfterTimelineReachedEnd();
        }
      },
      ignoreKeyEvent: (event) =>
        eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) ||
        document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) !== null,
    });
  }, [
    composerRef,
    legendListRef,
    isTimelineAtLogicalEndStable,
    timelineRealContentOverflowsViewportStable,
  ]);

  useEffect(() => {
    let frame: number | null = null;
    let removeListener: (() => void) | undefined;
    const attach = (remaining: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const node = legendListRef.current?.getScrollableNode();
        if (!node) {
          if (remaining > 0) attach(remaining - 1);
          return;
        }
        // Embedded frames hide their input events; their scroll still chains into the timeline.
        const scrolledUp = createUpwardScrollDetector({
          top: node.scrollTop,
          height: node.scrollHeight,
        });
        const onScroll = () => {
          if (
            scrolledUp({
              top: node.scrollTop,
              height: node.scrollHeight,
              programmatic:
                positionedTimelineAnchorRef.current !== null &&
                positionedTimelineAnchorRef.current !== settledTimelineAnchorRef.current,
            }) &&
            timelineScrollModeRef.current !== "free-scrolling" &&
            resolveTimelineIsAtEnd({
              contentLength: node.scrollHeight,
              scroll: node.scrollTop,
              scrollLength: node.clientHeight,
            }) === false
          ) {
            cancelTimelineLiveFollowForUserNavigationRef.current();
          }
        };
        node.addEventListener("scroll", onScroll, { passive: true });
        removeListener = () => node.removeEventListener("scroll", onScroll);
      });
    };
    attach(12);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      removeListener?.();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A thread switch remounts the list's scroll node.
    activeThreadId,
    legendListRef,
  ]);

  const onTimelineAnchorReady = (messageId: MessageId, anchorIndex: number) => {
    if (pendingTimelineAnchorRef.current === messageId) {
      pendingTimelineAnchorRef.current = null;
    }
    activeTimelineAnchorIndexRef.current = anchorIndex;
    if (positionedTimelineAnchorRef.current === messageId) {
      return;
    }
    positionedTimelineAnchorRef.current = messageId;
    settledTimelineAnchorRef.current = null;
    const positionAnchor = (remainingAttempts: number) => {
      requestAnimationFrame(() => {
        if (positionedTimelineAnchorRef.current !== messageId) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          if (remainingAttempts > 0) {
            positionAnchor(remainingAttempts - 1);
          }
          return;
        }
        // LegendList waits for queued layout and the animation before resolving.
        void list
          .scrollToIndex({
            index: anchorIndex,
            animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
            viewPosition: 0,
            viewOffset: CHAT_LIST_ANCHOR_OFFSET,
          })
          .then(() => {
            if (
              legendListRef.current === list &&
              positionedTimelineAnchorRef.current === messageId
            ) {
              settledTimelineAnchorRef.current = messageId;
            }
          });
      });
    };
    requestAnimationFrame(() => positionAnchor(12));
  };
  const onTimelineAnchorReadyStable = useStableCallback(onTimelineAnchorReady);
  const onTimelineAnchorSizeChanged = (messageId: MessageId) => {
    if (settledTimelineAnchorRef.current !== messageId) {
      return;
    }
    if (liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current) {
      return;
    }
    const scrollOffset = legendListRef.current?.getState().scroll;
    if (scrollOffset === undefined) {
      return;
    }
    if (pendingAnchorScrollRestoreRef.current === null) {
      pendingAnchorScrollRestoreRef.current = {
        messageId,
        offset: scrollOffset,
        userScrollGeneration: anchorUserScrollGenerationRef.current,
      };
    }
    if (anchorScrollRestoreFrameRef.current !== null) {
      return;
    }
    anchorScrollRestoreFrameRef.current = requestAnimationFrame(() => {
      anchorScrollRestoreFrameRef.current = null;
      const pending = pendingAnchorScrollRestoreRef.current;
      pendingAnchorScrollRestoreRef.current = null;
      if (
        pending &&
        settledTimelineAnchorRef.current === pending.messageId &&
        pending.userScrollGeneration === anchorUserScrollGenerationRef.current
      ) {
        const list = legendListRef.current;
        const currentScrollOffset = list?.getState().scroll;
        if (
          typeof currentScrollOffset === "number" &&
          Math.abs(currentScrollOffset - pending.offset) <= 2
        ) {
          void list?.scrollToOffset({ offset: pending.offset, animated: false });
        }
      }
    });
  };
  const onTimelineAnchorSizeChangedStable = useStableCallback(onTimelineAnchorSizeChanged);

  const onToolOutputCollapsedAtEnd = () => {
    composerRef.current?.restoreAfterTimelineReachedEnd();
  };
  const onToolOutputCollapsedAtEndStable = useStableCallback(onToolOutputCollapsedAtEnd);

  const onIsAtEndChange = (isAtEnd: boolean) => {
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      // Measurements can move the end while an unbroken follow is still active.
      if (
        timelineScrollModeRef.current === "following-end" &&
        followRepinFrameRef.current === null
      ) {
        followRepinFrameRef.current = requestAnimationFrame(() => {
          followRepinFrameRef.current = null;
          if (
            liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current ||
            timelineScrollModeRef.current !== "following-end"
          )
            return;
          void legendListRef.current?.scrollToEnd?.({ animated: false });
        });
      }
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      if (timelineScrollIntentRef.current === "toward-end") {
        composerRef.current?.restoreAfterTimelineReachedEnd();
      }
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      setTimelineAnchor(releaseChatTimelineAnchor);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  };
  const onIsAtEndChangeStable = useStableCallback(onIsAtEndChange);

  useLayoutEffect(() => {
    if (timelineScrollModeRef.current !== "anchoring-new-turn") return;
    if (
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId: timelineAnchorMessageId,
        liveFollowEnabled: timelineLiveFollowEnabled,
        runningTurnId: activeRunningTurnId,
        timelineEntries,
      })
    ) {
      scrollToEndStable();
    }
  }, [
    activeRunningTurnId,
    scrollToEndStable,
    timelineAnchorMessageId,
    timelineEntries,
    timelineLiveFollowEnabled,
  ]);

  // A thread switch restores that thread's remembered follow state; the refs
  // the scroll handlers read catch up after commit.
  const [timelineThreadReset, setTimelineThreadReset] = useState({
    threadKey: activeThreadKey,
    followEnd: true,
  });
  if (timelineThreadReset.threadKey !== activeThreadKey) {
    const followEnd = readTimelinePosition(routeThreadKey)?.atEnd !== false;
    setTimelineThreadReset({ threadKey: activeThreadKey, followEnd });
    setTimelineLiveFollowEnabled(followEnd);
    setShowScrollToBottom(!followEnd);
  }
  useEffect(() => {
    const { followEnd } = timelineThreadReset;
    if (followRepinFrameRef.current !== null) {
      cancelAnimationFrame(followRepinFrameRef.current);
      followRepinFrameRef.current = null;
    }
    isAtEndRef.current = followEnd;
    timelineScrollIntentRef.current = null;
    timelineScrollModeRef.current = followEnd ? "following-end" : "free-scrolling";
    liveFollowUserScrollGenerationRef.current = followEnd
      ? anchorUserScrollGenerationRef.current
      : null;
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
  }, [timelineThreadReset]);

  /** Arms the anchor for a message the user just sent, before its run exists. */
  const anchorNewTurn = (threadKey: string, messageId: MessageId) => {
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "anchoring-new-turn";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = messageId;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor({ threadKey, messageId });
  };

  return {
    showScrollToBottom,
    timelineLiveFollowEnabled,
    cancelPositionRestoreRef,
    isTimelineAtLogicalEndStable,
    cancelTimelineLiveFollowForUserNavigationStable,
    onComposerPageScrollKeyDownStable,
    onComposerPageScrollKeyUpStable,
    onComposerPageScrollReleaseStable,
    scrollToEnd,
    onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable,
    onToolOutputCollapsedAtEndStable,
    onIsAtEndChangeStable,
    anchorNewTurn,
  };
}
