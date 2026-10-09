import { describe, expect, it } from "vitest";
import { isValidNoteFileName, noteFileName } from "./fileName";

describe("noteFileName", () => {
  it("uses the title as the file name", () => {
    expect(noteFileName("训练 wheat 检测模型", [])).toBe("训练 wheat 检测模型.md");
  });

  it("adds -2, -3, … when the name is taken, ignoring case", () => {
    expect(noteFileName("日记", ["日记.md"])).toBe("日记-2.md");
    expect(noteFileName("Log", ["log.md", "LOG-2.md", "other.md"])).toBe("Log-3.md");
  });

  it("replaces characters that are not allowed in file names", () => {
    expect(noteFileName('a/b\\c:d*e?f"g<h>i|j', [])).toBe("a-b-c-d-e-f-g-h-i-j.md");
  });

  it("trims spaces and trailing dots", () => {
    expect(noteFileName("  周报...  ", [])).toBe("周报.md");
  });

  it("falls back to a default name when nothing usable is left", () => {
    expect(noteFileName(" .. ", [])).toBe("未命名.md");
  });
});

describe("isValidNoteFileName", () => {
  it("accepts a plain .md file name", () => {
    expect(isValidNoteFileName("日记.md")).toBe(true);
    expect(isValidNoteFileName("Log-2.md")).toBe(true);
    expect(isValidNoteFileName("Note.MD")).toBe(true);
  });

  it("rejects names that do not end with .md", () => {
    expect(isValidNoteFileName("日记")).toBe(false);
    expect(isValidNoteFileName("日记.txt")).toBe(false);
    expect(isValidNoteFileName(".md")).toBe(false);
  });

  it("rejects names containing path separators", () => {
    expect(isValidNoteFileName("a/b.md")).toBe(false);
    expect(isValidNoteFileName("a\\b.md")).toBe(false);
  });

  it("rejects names containing ..", () => {
    expect(isValidNoteFileName("..md")).toBe(false);
    expect(isValidNoteFileName("a..b.md")).toBe(false);
  });
});
