import { describe, expect, it } from "vitest";
import { detectMime } from "../src/lib/files.js";

describe("detectMime", () => {
  it("recognises real image and PDF signatures", () => {
    expect(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
    expect(detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe("image/png");
    expect(detectMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(detectMime(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
  });

  it("rejects content that only claims to be an image", () => {
    expect(detectMime(Buffer.from("<script>alert(1)</script>"))).toBeNull();
    expect(detectMime(Buffer.from("GIF89a"))).toBeNull();
    expect(detectMime(Buffer.alloc(0))).toBeNull();
  });
});
