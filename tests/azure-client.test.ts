import { describe, expect, it, vi } from "vitest";
import { AzureDevOpsClient } from "../src/azure-client.js";

const config = {
  organization: "org with spaces",
  project: "project/name",
  personalAccessToken: "pat",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AzureDevOpsClient", () => {
  it("paginates test runs when Azure returns a full page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ uri: "build-uri" }))
      .mockResolvedValueOnce(jsonResponse({ count: 100, value: firstPage }))
      .mockResolvedValueOnce(jsonResponse({ count: 0, value: [] }));

    for (let index = 0; index < 100; index += 1) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, value: [] }));
    }

    const client = new AzureDevOpsClient(config, fetchMock);
    await expect(client.getFailedTests(7)).resolves.toEqual([]);

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain("org%20with%20spaces/project%2Fname");
    expect(urls[2]).toContain("%24skip=100");
    expect(fetchMock).toHaveBeenCalledTimes(103);
  });

  it("rejects malformed collection responses", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ uri: "build-uri" }))
      .mockResolvedValueOnce(jsonResponse({ count: 1, value: null }));
    const client = new AzureDevOpsClient(config, fetchMock);

    await expect(client.getFailedTests(7)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: null,
    });
  });

  it("normalizes network failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("contains secret details"));
    const client = new AzureDevOpsClient(config, fetchMock);

    await expect(client.getFailedTests(7)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Unable to reach Azure DevOps",
    });
  });
});
