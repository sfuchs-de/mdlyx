import { describe, expect, it } from "vitest";
import { selectionPopoverPosition } from "./selection-popover";

const viewport = { left: 0, top: 0, right: 320, bottom: 568, width: 320, height: 568 };

describe("selectionPopoverPosition", () => {
  it("centres above a selection when there is room", () => {
    expect(selectionPopoverPosition(
      { left: 120, right: 180, top: 200, bottom: 220 },
      { width: 160, height: 40 },
      viewport,
    )).toEqual({ left: 70, top: 152, placement: "above" });
  });

  it("clamps to both horizontal viewport gutters", () => {
    const left = selectionPopoverPosition(
      { left: 4, right: 14, top: 200, bottom: 220 },
      { width: 205, height: 40 },
      viewport,
    );
    const right = selectionPopoverPosition(
      { left: 306, right: 316, top: 200, bottom: 220 },
      { width: 205, height: 40 },
      viewport,
    );
    expect(left.left).toBe(8);
    expect(right.left).toBe(107);
  });

  it("flips below a top-edge selection and respects a shifted visual viewport", () => {
    expect(selectionPopoverPosition(
      { left: 130, right: 160, top: 48, bottom: 68 },
      { width: 180, height: 90 },
      { left: 0, top: 40, right: 320, bottom: 360, width: 320, height: 320 },
    )).toEqual({ left: 55, top: 76, placement: "below" });
  });

  it("keeps an oversized composer inside the visible vertical bounds", () => {
    const result = selectionPopoverPosition(
      { left: 120, right: 180, top: 210, bottom: 230 },
      { width: 240, height: 300 },
      { left: 0, top: 100, right: 320, bottom: 420, width: 320, height: 320 },
    );
    expect(result.left).toBeGreaterThanOrEqual(8);
    expect(result.top).toBeGreaterThanOrEqual(108);
    expect(result.top + 300).toBeLessThanOrEqual(412);
  });
});
