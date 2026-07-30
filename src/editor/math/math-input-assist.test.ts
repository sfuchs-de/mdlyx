import { describe, it, expect } from "vitest";
import { expandCommand, insertScript } from "./math-input-assist";

describe("math input assist", () => {
  it("expands a bare command to its skeleton with the caret in the first slot", () => {
    const e = expandCommand("\\frac", 5)!;
    expect(e.value).toBe("\\frac{}{}");
    expect(e.value.slice(e.caret, e.caret)).toBe(""); // caret is a point
    expect(e.value[e.caret - 1]).toBe("{"); // just inside the first brace
  });

  it("expands mid-string and keeps the tail", () => {
    const e = expandCommand("a+\\sqrt", 7)!;
    expect(e.value).toBe("a+\\sqrt{}");
    expect(e.caret).toBe(8); // inside the braces
  });

  it("returns null for unknown or absent commands", () => {
    expect(expandCommand("\\wat", 4)).toBeNull();
    expect(expandCommand("abc", 3)).toBeNull();
  });

  it("inserts empty script braces with the caret inside", () => {
    const e = insertScript("x", 1, 1, "^");
    expect(e.value).toBe("x^{}");
    expect(e.caret).toBe(3); // between ^{ and }
  });

  it("wraps a selection in a script", () => {
    const e = insertScript("xyz", 1, 3, "_"); // wrap "yz"
    expect(e.value).toBe("x_{yz}");
    expect(e.caret).toBe(5); // after the wrapped content
  });
});
