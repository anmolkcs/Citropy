const KEYBOARD_MIN_HEIGHT = 150;

export function followVisualViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  const touch = window.matchMedia("(hover: none)");
  let width = viewport.width * viewport.scale;
  let fullHeight = viewport.height * viewport.scale;
  const update = () => {
    const height = viewport.height * viewport.scale;
    if (viewport.width * viewport.scale !== width) {
      width = viewport.width * viewport.scale;
      fullHeight = height;
    }
    fullHeight = Math.max(fullHeight, height);
    root.style.setProperty("--viewport-height", `${height}px`);
    root.toggleAttribute("data-keyboard", touch.matches && fullHeight - height > KEYBOARD_MIN_HEIGHT);
    // iOS Safari scrolls the whole page up to reveal a focused field even though the app already fits above the keyboard.
    if (window.scrollY) window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
}
