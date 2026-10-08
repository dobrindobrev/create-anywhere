import { describe, it, expect } from "vitest";
import { chunkText } from "./types.js";

describe("chunkText", () => {
  it("returns single chunk when text is under maxLen", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  it("returns single chunk when text equals maxLen", () => {
    const text = "a".repeat(50);
    expect(chunkText(text, 50)).toEqual([text]);
  });

  it("splits on newline boundary", () => {
    const text = "line one\nline two\nline three";
    const chunks = chunkText(text, 15);
    // "line one\nline " = 14 chars, so split at the \n at position 8
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
    expect(chunks.join("\n")).toContain("line one");
    expect(chunks.join("\n")).toContain("line three");
  });

  it("splits on space when no newline available", () => {
    const text = "word1 word2 word3 word4";
    const chunks = chunkText(text, 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(12);
    }
  });

  it("hard cuts when no space or newline available", () => {
    const text = "abcdefghijklmnop";
    const chunks = chunkText(text, 5);
    expect(chunks).toEqual(["abcde", "fghij", "klmno", "p"]);
  });

  it("handles empty string", () => {
    expect(chunkText("", 100)).toEqual([""]);
  });
});
