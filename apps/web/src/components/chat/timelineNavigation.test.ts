// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { observeTimelineNavigation } from "./timelineNavigation";

let frames: Map<number, FrameRequestCallback>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  frames = new Map();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function advanceFrames(count: number) {
  for (let i = 0; i < count; i++) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(i * 16);
  }
}

// jsdom has no native wheel scrolling or list layout. This reader applies the
// browser's scroll delta, then models a later live-follow content update.
function reader(mounted = true, overflows = true) {
  let node: HTMLElement | null = null;
  let following = true;
  let contentEnd = 1_000;
  const mount = () => {
    node?.remove();
    node = document.createElement("div");
    node.scrollTop = contentEnd;
    document.body.append(node);
    return node;
  };
  if (mounted) mount();
  const stop = observeTimelineNavigation({
    getScrollNode: () => node,
    contentScrollsUp: () => overflows,
    viewportIsAwayFromEnd: () => node !== null && node.scrollTop < contentEnd,
    onManualNavigation: () => {
      following = false;
    },
    onScrollIntent: () => {},
    onWheelTowardEnd: () => {},
    onScrollKey: () => {},
    ignoreKeyEvent: (event) =>
      event.target instanceof Element && event.target.closest("input,textarea") !== null,
  });
  cleanups.push(stop);
  return {
    mount,
    stop,
    get node() {
      return node!;
    },
    readEarlier(target: EventTarget = node!) {
      target.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
      node!.scrollTop -= 200;
    },
    grow() {
      contentEnd += 500;
      if (following) node!.scrollTop = contentEnd;
    },
  };
}

describe("timeline navigation during hydration", () => {
  it("keeps the reading position when history mounts after a slow thread load", () => {
    const view = reader(false);
    advanceFrames(60);
    view.mount();
    view.readEarlier();
    view.grow();
    expect(view.node.scrollTop).toBe(800);
  });

  it("stops following an already mounted timeline on an upward wheel", () => {
    const view = reader();
    advanceFrames(1);
    view.readEarlier();
    view.grow();
    expect(view.node.scrollTop).toBe(800);
  });

  it("honors navigation after the timeline DOM node is replaced", () => {
    const view = reader();
    advanceFrames(1);
    view.mount();
    view.readEarlier();
    view.grow();
    expect(view.node.scrollTop).toBe(800);
  });

  it("allows PageUp after delayed hydration even when focus is on the page", () => {
    const view = reader(false);
    advanceFrames(60);
    view.mount();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    view.node.scrollTop = 400;
    view.grow();
    expect(view.node.scrollTop).toBe(400);
  });

  it("leaves editing keys inside the timeline to the editor", () => {
    const view = reader();
    advanceFrames(1);
    const input = document.createElement("textarea");
    view.node.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("sees upward navigation before a message stops event propagation", () => {
    const view = reader();
    advanceFrames(1);
    const message = document.createElement("div");
    view.node.append(message);
    message.addEventListener("wheel", (event) => event.stopPropagation());
    view.readEarlier(message);
    view.grow();
    expect(view.node.scrollTop).toBe(800);
  });

  it("keeps following while a nested tool output consumes the wheel", () => {
    const view = reader();
    advanceFrames(1);
    const output = document.createElement("div");
    output.style.overflowY = "auto";
    output.scrollTop = 100;
    view.node.append(output);
    output.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
    output.scrollTop = 0;
    view.readEarlier(output);
    view.grow();
    expect(view.node.scrollTop).toBe(1_300);
  });

  it("ignores wheel gestures outside the current timeline", () => {
    const view = reader();
    advanceFrames(1);
    document.body.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("ignores outside touch and pointer gestures while the timeline is away from the end", () => {
    const view = reader();
    advanceFrames(1);
    view.node.scrollTop = 800;
    document.body.dispatchEvent(new Event("touchmove", { bubbles: true }));
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("keeps pinch zoom and horizontal wheels from disabling follow", () => {
    const view = reader();
    advanceFrames(1);
    view.node.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true }),
    );
    view.node.dispatchEvent(new WheelEvent("wheel", { deltaX: -100, bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("keeps following when an upward wheel cannot scroll short content", () => {
    const view = reader(true, false);
    advanceFrames(1);
    view.node.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("removes navigation listeners on disposal", () => {
    const view = reader();
    advanceFrames(1);
    view.stop();
    view.readEarlier();
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });
});
