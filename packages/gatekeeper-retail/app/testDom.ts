// DOM helpers for the Data app's jsdom component tests (react-dom + act, as OverviewPage.test.tsx).

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom gaps Kumo relies on: tabs measure their list with a ResizeObserver and scroll the chosen tab
// into view; preview problems scroll to their row.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

let root: Root | undefined;

export async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

export function cleanup(): void {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
}

/** Lets pending promises (RPC results) and their renders land. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function accessibleName(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label) return label;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  if (element.id) {
    const forLabel = [...document.querySelectorAll("label")].find((candidate) => candidate.htmlFor === element.id);
    if (forLabel) return forLabel.textContent?.trim() ?? "";
  }
  return element.textContent?.trim() ?? "";
}

export function button(name: string, within: ParentNode = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => accessibleName(element) === name || element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button "${name}"`);
  return found;
}

export function byRole(role: string, name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(
    (element) => accessibleName(element) === name,
  );
  if (!found) throw new Error(`No ${role} "${name}"`);
  return found;
}

/** An input or textarea by its label's text (the label's start, ignoring "optional" markers). */
export function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelElement = [...document.querySelectorAll("label")].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  const control = labelElement && document.getElementById(labelElement.htmlFor);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
    throw new Error(`No field labelled "${label}"`);
  }
  return control;
}

/**
 * Base UI controls (checkboxes, select options) re-dispatch a click they build as a PointerEvent,
 * which jsdom lacks, so the window has a stand-in while the action runs.
 */
async function withPointerEvent(action: () => void): Promise<void> {
  const view: { PointerEvent?: typeof MouseEvent } = window;
  view.PointerEvent = MouseEvent;
  try {
    await act(async () => action());
  } finally {
    delete view.PointerEvent;
  }
}

export async function click(element: HTMLElement): Promise<void> {
  await withPointerEvent(() => element.click());
  await settle();
}

export async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Picks an option of a Kumo Select by keyboard. */
export async function choose(selectName: string, optionLabel: string): Promise<void> {
  await click(byRole("combobox", selectName));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent?.trim() === optionLabel,
  );
  if (!option) throw new Error(`No option "${optionLabel}" in "${selectName}"`);
  await act(async () => option.focus());
  await withPointerEvent(() =>
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
  );
  await settle();
}
