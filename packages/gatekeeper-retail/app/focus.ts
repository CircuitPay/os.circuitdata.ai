/**
 * A ref callback that moves focus to an element when it mounts, so a screen reader follows a view
 * change (opening an import, a report or a template). Module-level so its identity is stable and
 * React calls it once per mount rather than on every render.
 */
export const focusOnMount = (element: HTMLElement | null): void => {
  element?.focus();
};
