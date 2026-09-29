import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config/env.js";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db", JWT_SECRET: "a".repeat(40) };

describe("env", () => {
  it("treats empty optional variables (as in .env.example) as unset", () => {
    const env = parseEnv({
      ...base,
      CLOUDINARY_CLOUD_NAME: "", CLOUDINARY_API_KEY: "", CLOUDINARY_API_SECRET: "",
      ZUMBOPAY_ENABLED: "false", ZUMBOPAY_API_BASE_URL: "", ZUMBOPAY_API_KEY: "", ZUMBOPAY_MERCHANT_ID: "", ZUMBOPAY_WEBHOOK_SECRET: ""
    });
    expect(env.CLOUDINARY_API_KEY).toBeUndefined();
    expect(env.ZUMBOPAY_API_BASE_URL).toBeUndefined();
  });

  it("rejects the placeholder JWT secret", () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: "replace-with-at-least-32-random-characters" })).toThrow();
  });

  it("rejects an empty or short JWT secret", () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: "" })).toThrow();
    expect(() => parseEnv({ ...base, JWT_SECRET: "short" })).toThrow();
  });

  it("requires a webhook secret when ZumboPay is enabled", () => {
    expect(() => parseEnv({ ...base, ZUMBOPAY_ENABLED: "true" })).toThrow();
  });

  it("defaults shipping to 0 and reads SHIPPING_FLAT_MZN", () => {
    expect(parseEnv(base).SHIPPING_FLAT_MZN).toBe(0);
    expect(parseEnv({ ...base, SHIPPING_FLAT_MZN: "150" }).SHIPPING_FLAT_MZN).toBe(150);
  });
});
