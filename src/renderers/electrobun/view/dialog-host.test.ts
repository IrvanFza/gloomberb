import { describe, expect, test } from "bun:test";
import { isDialogDismissKey, shouldFocusDialogContainer } from "./dialog-host";

describe("desktop dialog focus and dismissal", () => {
  test("dismisses on Escape, including legacy WebView key names", () => {
    expect(isDialogDismissKey({ key: "Escape", isComposing: false })).toBe(true);
    expect(isDialogDismissKey({ key: "Esc", isComposing: false })).toBe(true);
    expect(isDialogDismissKey({ key: "Enter", isComposing: false })).toBe(false);
    expect(isDialogDismissKey({ key: "Escape", isComposing: true })).toBe(false);
  });

  test("preserves focus already owned by dialog content", () => {
    const child = {} as Element;
    const outside = {} as Element;
    const dialog = {
      contains(element: Node | null) {
        return element === child;
      },
    };

    expect(shouldFocusDialogContainer(dialog, child)).toBe(false);
    expect(shouldFocusDialogContainer(dialog, outside)).toBe(true);
    expect(shouldFocusDialogContainer(dialog, null)).toBe(true);
  });
});
