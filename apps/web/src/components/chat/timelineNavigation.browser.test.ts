import { describe, expect, it } from "vite-plus/test";
import { attachTimelineViewport, navigationReleasesFollow } from "./timelineViewport";

function reader(mounted = true, overflows = true) {
  let node: HTMLElement | null = null;
  let following = true;
  let contentEnd = 1_000;
  let content: HTMLElement;
  let dispose: (() => void) | undefined;
  const mount = () => {
    dispose?.();
    node?.remove();
    node = document.createElement("div");
    node.style.cssText = "height:100px;overflow-y:auto";
    content = document.createElement("div");
    content.style.height = String(contentEnd + 100) + "px";
    node.append(content);
    document.body.append(node);
    node.scrollTop = contentEnd;
    const viewport = attachTimelineViewport(node);
    viewport.subscribe((navigation) => {
      if (
        navigationReleasesFollow(navigation, {
          contentScrollsUp: () => overflows,
          awayFromEnd: () => node !== null && node.scrollTop < contentEnd,
        })
      )
        following = false;
    });
    dispose = viewport.dispose;
    return node;
  };
  if (mounted) mount();
  const stop = () => dispose?.();

  return {
    [Symbol.dispose]() {
      stop();
      node?.remove();
    },
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
      content.style.height = `${contentEnd + 100}px`;
      if (following) node!.scrollTop = contentEnd;
    },
  };
}

describe("timeline navigation during hydration", () => {
  it("keeps the reading position when history mounts after a slow thread load", () => {
    using view = reader(false);
    view.mount();
    view.readEarlier();
    view.grow();
    expect(view.node.scrollTop).toBe(800);
  });

  it("stops following an already mounted timeline on an upward wheel", () => {
    using view = reader();
    view.readEarlier();
    view.grow();
    expect(view.node.scrollTop).toBe(800);
  });

  it("honors navigation after the timeline DOM node is replaced", () => {
    using view = reader();
    view.mount();
    view.readEarlier();
    view.grow();
    expect(view.node.scrollTop).toBe(800);
  });

  it("allows PageUp after delayed hydration even when focus is on the page", () => {
    using view = reader(false);
    view.mount();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    view.node.scrollTop = 400;
    view.grow();
    expect(view.node.scrollTop).toBe(400);
  });

  it("leaves editing keys inside the timeline to the editor", () => {
    using view = reader();
    const input = document.createElement("textarea");
    view.node.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("sees upward navigation before a message stops event propagation", () => {
    using view = reader();
    const message = document.createElement("div");
    view.node.append(message);
    message.addEventListener("wheel", (event) => event.stopPropagation());
    view.readEarlier(message);
    view.grow();
    expect(view.node.scrollTop).toBe(800);
  });

  it("keeps following while a nested tool output consumes the wheel", () => {
    using view = reader();
    const output = document.createElement("div");
    output.style.overflowY = "auto";
    output.style.height = "50px";
    const detail = document.createElement("div");
    detail.style.height = "500px";
    output.append(detail);
    view.node.append(output);
    output.scrollTop = 100;
    output.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
    output.scrollTop = 0;
    view.readEarlier(output);
    view.grow();
    expect(view.node.scrollTop).toBe(1_300);
  });

  it("ignores wheel gestures outside the current timeline", () => {
    using view = reader();
    document.body.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("ignores outside touch and pointer gestures while the timeline is away from the end", () => {
    using view = reader();
    view.node.scrollTop = 800;
    document.body.dispatchEvent(new Event("touchmove", { bubbles: true }));
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("keeps pinch zoom and horizontal wheels from disabling follow", () => {
    using view = reader();
    view.node.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true }),
    );
    view.node.dispatchEvent(new WheelEvent("wheel", { deltaX: -100, bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("keeps following when an upward wheel cannot scroll short content", () => {
    using view = reader(true, false);
    view.node.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });

  it("removes navigation listeners on disposal", () => {
    using view = reader();
    view.stop();
    view.readEarlier();
    view.grow();
    expect(view.node.scrollTop).toBe(1_500);
  });
});
