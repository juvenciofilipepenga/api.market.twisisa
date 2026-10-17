import { describe, expect, it, vi } from "vitest";
import { sendEmailJs } from "../src/services/emailjs.js";

const config = { serviceId: "service_x", templateReset: "template_reset", publicKey: "pub_key", privateKey: "priv_key" };

describe("EmailJS service", () => {
  it("does nothing and reports NOT_CONFIGURED without credentials", async () => {
    const fetchImpl = vi.fn();
    const result = await sendEmailJs("template_reset", {}, null, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the REST payload with the private key as accessToken", async () => {
    const fetchImpl = vi.fn(async () => new Response("OK", { status: 200 }));
    const result = await sendEmailJs("template_reset", { to_email: "a@b.co", reset_link: "https://x/redefinir?token=t" }, config, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.emailjs.com/api/v1.0/email/send");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      service_id: "service_x", template_id: "template_reset", user_id: "pub_key", accessToken: "priv_key",
      template_params: { to_email: "a@b.co", reset_link: "https://x/redefinir?token=t" }
    });
  });

  it("reports EmailJS rejections with status and detail, never the keys", async () => {
    const fetchImpl = vi.fn(async () => new Response("API calls are disabled for non-browser applications", { status: 403 }));
    const result = await sendEmailJs("template_reset", {}, config, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, reason: "REJECTED", status: 403 });
    expect(JSON.stringify(result)).not.toContain("priv_key");
  });

  it("reports network failures instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const result = await sendEmailJs("template_reset", {}, config, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "NETWORK", detail: "TypeError" });
  });
});
