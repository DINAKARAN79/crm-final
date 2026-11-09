import { describe, expect, it } from "vitest";
import { orderNoteBlocksNewestFirst } from "./sticky-notes-card";

describe("orderNoteBlocksNewestFirst", () => {
  it("orders numbered notes newest first while keeping legacy blocks intact", () => {
    const notes = [
      "Legacy note without metadata",
      "Note 1: (A) - (January 01, 2026 10:00:00 AM):\nfirst",
      "Note 3: (C) - (January 03, 2026 10:00:00 AM):\nthird",
      "Note 2: (B) - (January 02, 2026 10:00:00 AM):\nsecond",
    ].join("\n\n");

    expect(orderNoteBlocksNewestFirst(notes)).toEqual([
      "Note 3: (C) - (January 03, 2026 10:00:00 AM):\nthird",
      "Note 2: (B) - (January 02, 2026 10:00:00 AM):\nsecond",
      "Note 1: (A) - (January 01, 2026 10:00:00 AM):\nfirst",
      "Legacy note without metadata",
    ]);
  });

  it("preserves stable order for legacy notes and equal note numbers", () => {
    expect(orderNoteBlocksNewestFirst("legacy note\n\nNote 1: (A) - (date):\nfirst\n\nNote 2: (B) - (date):\nsecond")).toEqual([
      "Note 2: (B) - (date):\nsecond",
      "Note 1: (A) - (date):\nfirst",
      "legacy note",
    ]);
    expect(orderNoteBlocksNewestFirst("")).toEqual([]);
  });
});
