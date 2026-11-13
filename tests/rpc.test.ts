import { afterEach, describe, expect, it, vi } from "vitest";
import { getEthereumRpcSnapshot } from "../src/chain/rpc.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ethereum JSON-RPC connection", () => {
  it("reads chain ID and latest block without submitting transactions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0x1234" }),
          { status: 200 }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getEthereumRpcSnapshot("https://example.invalid");

    expect(snapshot.chainId).toBe(1);
    expect(snapshot.blockNumber).toBe(4660n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: (init as RequestInit).method
    }))).toEqual([
      { url: "https://example.invalid", method: "POST" },
      { url: "https://example.invalid", method: "POST" }
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as RequestInit).body as string) as {
        method: string;
      };
      expect(["eth_chainId", "eth_blockNumber"]).toContain(body.method);
    }
  });

  it("surfaces JSON-RPC errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "upstream unavailable" }
          }),
          { status: 200 }
        )
      )
    );

    await expect(
      getEthereumRpcSnapshot("https://example.invalid")
    ).rejects.toThrow("upstream unavailable");
  });

  it("rejects malformed block numbers", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }))
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 2, result: "latest" })
          )
        )
    );

    await expect(
      getEthereumRpcSnapshot("https://example.invalid")
    ).rejects.toThrow("invalid block number");
  });
});
