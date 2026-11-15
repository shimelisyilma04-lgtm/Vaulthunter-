import { describe, expect, it } from "vitest";
import { getRateLimitClientIdentity, startHttpServer } from "./server.js";

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

describe("read-only API boundary", () => {
  it("serves health and rejects unsupported write methods", async () => {
    const server = startHttpServer({} as never);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, mode: "read-only" });

      const write = await fetch(`${base}/api/v1/borrowers`, { method: "DELETE" });
      expect(write.status).toBe(405);
      expect(await write.json()).toMatchObject({ error: "method_not_allowed" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
