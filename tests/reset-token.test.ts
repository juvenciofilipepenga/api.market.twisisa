import { describe, expect, it } from "vitest";
import { buildResetLink, generateResetToken, hashResetToken, isWellFormedResetToken, maskEmail, tokenPredatesPasswordChange } from "../src/lib/resetToken.js";

describe("reset token", () => {
  it("generates unique, well-formed, URL-safe tokens", () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a).not.toBe(b);
    expect(isWellFormedResetToken(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects values that can never be a token", () => {
    for (const bad of ["", "abc", "x".repeat(42), "x".repeat(44), `${"a".repeat(42)}!`, `${"a".repeat(42)} `, null, undefined, 42, {}]) {
      expect(isWellFormedResetToken(bad)).toBe(false);
    }
  });

  it("hashes deterministically and never returns the token", () => {
    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
    expect(hashResetToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResetToken(token)).not.toContain(token);
    expect(hashResetToken(token)).not.toBe(hashResetToken(generateResetToken()));
  });

  it("builds the link without double slashes", () => {
    expect(buildResetLink("https://market.twisisa.site/", "abc")).toBe("https://market.twisisa.site/redefinir?token=abc");
    expect(buildResetLink("https://market.twisisa.site", "abc")).toBe("https://market.twisisa.site/redefinir?token=abc");
  });

  it("masks emails", () => {
    expect(maskEmail("juvencio@gmail.com")).toBe("j*******@gmail.com");
    expect(maskEmail("ab@x.co")).toBe("a**@x.co");
    expect(maskEmail("nonsense")).toBe("***");
  });

  it("invalidates tokens issued before a password change, but not the ones issued after", () => {
    const changed = new Date("2026-10-16T12:00:00.500Z");
    const sec = Math.floor(changed.getTime() / 1000);
    expect(tokenPredatesPasswordChange(sec - 1, changed)).toBe(true);
    expect(tokenPredatesPasswordChange(sec, changed)).toBe(false);
    expect(tokenPredatesPasswordChange(sec + 60, changed)).toBe(false);
    expect(tokenPredatesPasswordChange(sec - 1000, null)).toBe(false);
    expect(tokenPredatesPasswordChange(undefined, changed)).toBe(false);
  });
});
