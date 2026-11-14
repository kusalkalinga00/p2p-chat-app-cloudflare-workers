/**
 * Software-keyboard aware app height.
 *
 * `dvh` units and `position: fixed` are measured against the *layout*
 * viewport, which does not shrink when the iOS software keyboard slides up —
 * only the *visual* viewport does. A full-height shell therefore keeps its
 * composer parked behind the keyboard, and Safari pans the page to reveal the
 * focused field, which is what tears the layout apart on a phone.
 *
 * Mirroring the visual viewport into a CSS variable gives the shell one honest
 * height to size itself from, so the composer ends up just above the keyboard
 * and nothing has to scroll.
 */

const HEIGHT_VAR = "--app-height";
const OFFSET_VAR = "--app-top";

export function installViewportHeight(): void {
  const root = document.documentElement;
  const viewport = window.visualViewport;

  const sync = () => {
    // `visualViewport` is absent on older browsers; the window height is the
    // right fallback there because those keyboards resize the layout instead.
    const height = viewport?.height ?? window.innerHeight;
    root.style.setProperty(HEIGHT_VAR, `${Math.round(height)}px`);

    // iOS can still pan the page when it reveals a focused field, leaving the
    // visual viewport below the layout origin. Track that offset so the shell
    // stays glued to the visible area. Always 0 elsewhere.
    root.style.setProperty(
      OFFSET_VAR,
      `${Math.round(viewport?.offsetTop ?? 0)}px`,
    );

    // A large gap between the layout and visual viewport means the keyboard is
    // up (or the page is pinch-zoomed); in both cases the home indicator is
    // off-screen, so the bottom safe-area padding should not be reserved.
    const shrunk = window.innerHeight - height > 100;
    root.toggleAttribute("data-keyboard", shrunk);
  };

  sync();

  // Safari fires `resize` on the visual viewport when the keyboard opens or
  // closes, and `scroll` when the page pans or pinch-zooms. The window events
  // cover rotation, desktop resizes, and browsers without visualViewport.
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  viewport?.addEventListener("resize", sync);
  viewport?.addEventListener("scroll", sync);
}
