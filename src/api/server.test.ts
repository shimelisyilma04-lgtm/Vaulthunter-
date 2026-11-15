import { describe, expect, it } from "vitest";
import { getRateLimitClientIdentity } from "./server.js";

describe("getRateLimitClientIdentity", () => {
  it("uses Render's trusted CF-Connecting-IP header", () => {
    const req = {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" },
      socket: { remoteAddress: "10.0.0.1" }
    } as never;
    expect(getRateLimitClientIdentity(req)).toBe("203.0.113.7");
  });

  it("ignores caller-controlled X-Forwarded-For and falls back to socket IP", () => {
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4" },
      socket: { remoteAddress: "10.0.0.1" }
    } as never;
    expect(getRateLimitClientIdentity(req)).toBe("10.0.0.1");
  });

  it("rejects malformed Cloudflare client IP values", () => {
    const req = {
      headers: { "cf-connecting-ip": "not-an-ip" },
      socket: { remoteAddress: "10.0.0.1" }
    } as never;
    expect(getRateLimitClientIdentity(req)).toBe("10.0.0.1");
  });
});
