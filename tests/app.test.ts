import { describe, expect, it, vi } from "vitest";
import { parseArguments, parseBuildId, readConfig, runCli } from "../src/app.js";
import { AppError } from "../src/errors.js";

const environment = {
  AZURE_DEVOPS_ORGANIZATION: "example-org",
  AZURE_DEVOPS_PROJECT: "example-project",
  AZURE_PERSONAL_ACCESS_TOKEN: "secret-pat",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function zipResponse(bytes: number[], status = 200): Response {
  return new Response(Uint8Array.from(bytes), {
    status,
    headers: { "Content-Type": "application/zip" },
  });
}

describe("argument and configuration validation", () => {
  it.each([
    [[], "positive integer"],
    [["--buildId", "0"], "positive safe integer"],
    [["--buildId", "-2"], "positive integer"],
    [["--buildId", "abc"], "positive integer"],
    [["--buildId", "1", "--buildId=2"], "exactly once"],
    [["--other", "1"], "Unknown argument"],
  ])("rejects invalid arguments %#", (args, expectedMessage) => {
    expect(() => parseBuildId(args)).toThrow(expectedMessage);
  });

  it("accepts both supported buildId forms", () => {
    expect(parseBuildId(["--buildId", "123"])).toBe(123);
    expect(parseBuildId(["--buildId=456"])).toBe(456);
  });

  it("accepts the allure mode without changing buildId parsing", () => {
    expect(parseArguments(["--allure", "--buildId", "123"])).toEqual({
      buildId: 123,
      allure: true,
    });
    expect(parseBuildId(["--buildId=456", "--allure"])).toBe(456);
  });

  it("requires every configuration variable", () => {
    expect(() => readConfig({ ...environment, AZURE_DEVOPS_PROJECT: "" })).toThrow(
      "AZURE_DEVOPS_PROJECT",
    );
  });
});

describe("CLI reporting", () => {
  it("downloads every matching allure artifact and writes a separate manifest", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        count: 3,
        value: [
          { name: "test-output" },
          { name: "UI-Allure-Results & smoke", resource: { type: "Container" } },
          { name: "allure-results/backend", resource: { type: "PipelineArtifact" } },
        ],
      }))
      .mockResolvedValueOnce(zipResponse([0x50, 0x4b, 0x03, 0x04]))
      .mockResolvedValueOnce(zipResponse([0x50, 0x4b, 0x05, 0x06]));
    const writes: Array<{ path: string; data: string | Uint8Array }> = [];
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli(["--buildId", "123", "--allure"], environment, {
      fetchImplementation: fetchMock,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      writeFile: async (path, data) => { writes.push({ path, data }); },
      currentWorkingDirectory: () => "/tmp/reports",
      now: () => new Date("2026-07-21T12:34:56.789Z"),
      analyzeAllureArtifact: async () => ({
        summary: { results: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 },
        failures: [],
      }),
    });

    const manifestPath = "/tmp/reports/ci-allure-2026-07-21T12-34-56-789Z-build-123.json";
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(`${manifestPath}\n`);
    expect(writes).toHaveLength(3);
    expect(writes[0]?.path).toBe("/tmp/reports/ci-allure-2026-07-21T12-34-56-789Z-build-123-1.zip");
    expect(writes[1]?.path).toBe("/tmp/reports/ci-allure-2026-07-21T12-34-56-789Z-build-123-2.zip");
    expect(writes[0]?.data).toEqual(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
    expect(writes[1]?.data).toEqual(Uint8Array.from([0x50, 0x4b, 0x05, 0x06]));
    expect(JSON.parse(String(writes[2]?.data))).toEqual({
      buildId: 123,
      matchedCount: 2,
      source: "allure",
      summary: { results: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 },
      artifacts: [
        {
          name: "UI-Allure-Results & smoke",
          type: "Container",
          path: "/tmp/reports/ci-allure-2026-07-21T12-34-56-789Z-build-123-1.zip",
          results: 0,
        },
        {
          name: "allure-results/backend",
          type: "PipelineArtifact",
          path: "/tmp/reports/ci-allure-2026-07-21T12-34-56-789Z-build-123-2.zip",
          results: 0,
        },
      ],
      failures: [],
    });

    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(listUrl.pathname).toBe("/example-org/example-project/_apis/build/builds/123/artifacts");
    expect(listUrl.searchParams.get("api-version")).toBe("7.1");
    expect(listUrl.searchParams.get("artifactName")).toBeNull();
    const firstDownloadUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    const secondDownloadUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(firstDownloadUrl.searchParams.get("artifactName")).toBe("UI-Allure-Results & smoke");
    expect(secondDownloadUrl.searchParams.get("artifactName")).toBe("allure-results/backend");
    expect(firstDownloadUrl.searchParams.get("$format")).toBe("zip");
    expect(secondDownloadUrl.searchParams.get("$format")).toBe("zip");
    expect(firstDownloadUrl.searchParams.get("api-version")).toBe("7.1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("UI-Allure-Results+%26+smoke");
  });

  it("returns an explicit error when no allure artifact matches", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      count: 1,
      value: [{ name: "test-output" }],
    }));
    let stdout = "";
    let stderr = "";
    let writes = 0;

    const exitCode = await runCli(["--buildId=123", "--allure"], environment, {
      fetchImplementation: fetchMock,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      writeFile: async () => { writes += 1; },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(writes).toBe(0);
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "NO_ALLURE_ARTIFACTS",
        message: "No build artifacts matched allure-results",
        status: null,
      },
    });
  });

  it("uses the existing redacted API error for allure downloads", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ count: 1, value: [{ name: "allure-results" }] }))
      .mockResolvedValueOnce(zipResponse([], 403));
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli(["--buildId=123", "--allure"], environment, {
      fetchImplementation: fetchMock,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "AZURE_API_ERROR",
        message: "Azure DevOps request failed with status 403",
        status: 403,
      },
    });
    expect(stderr).not.toContain("secret-pat");
  });

  it("reports analyzer failures explicitly", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ count: 1, value: [{ name: "allure-results" }] }))
      .mockResolvedValueOnce(zipResponse([0x50, 0x4b]));
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli(["--buildId=123", "--allure"], environment, {
      fetchImplementation: fetchMock,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      writeFile: async () => undefined,
      analyzeAllureArtifact: async () => {
        throw new AppError("ALLURE_ARCHIVE_ERROR", "Unable to analyze the Allure archive", 1);
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "ALLURE_ARCHIVE_ERROR",
        message: "Unable to analyze the Allure archive",
        status: null,
      },
    });
  });

  it("collects and maps selected failures from all test runs", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ uri: "vstfs:///Build/Build/123" }))
      .mockResolvedValueOnce(jsonResponse({ count: 2, value: [
        { id: 10, name: "Unit tests" },
        { id: 11, name: "Integration tests" },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ count: 2, value: [
        {
          id: 101,
          outcome: "Failed",
          durationInMs: 25,
          errorMessage: "expected true",
          stackTrace: "at example.test.ts:4",
          automatedTestName: "example works",
          automatedTestStorage: "example.test.ts",
          testCase: { name: "Example works" },
        },
        { id: 102, outcome: "Passed", testCase: { name: "Filtered locally" } },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ count: 1, value: [
        { id: 103, outcome: "timeout", durationInMs: "80" },
      ] }));
    let stdout = "";
    let stderr = "";
    let outputPath = "";
    let outputContents = "";

    const exitCode = await runCli(["--buildId", "123"], environment, {
      fetchImplementation: fetchMock,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      writeFile: async (path, data) => {
        outputPath = path;
        outputContents = data;
      },
      readDirectory: async () => ["ci-error-2026-07-21T12-34-56-789Z-build-123.json"],
      currentWorkingDirectory: () => "/tmp/reports",
      now: () => new Date("2026-07-21T12:34:56.789Z"),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("/tmp/reports/ci-error-2026-07-21T12-34-56-789Z-build-123.json\n");
    expect(outputPath).toBe("/tmp/reports/ci-error-2026-07-21T12-34-56-789Z-build-123.json");
    expect(JSON.parse(outputContents)).toEqual({
      buildId: 123,
      count: 2,
      failedTests: [
        {
          runId: 10,
          runName: "Unit tests",
          testId: 101,
          testName: "Example works",
          outcome: "Failed",
          durationMs: 25,
          errorMessage: "expected true",
          stackTrace: "at example.test.ts:4",
          automatedTestName: "example works",
          automatedTestStorage: "example.test.ts",
        },
        {
          runId: 11,
          runName: "Integration tests",
          testId: 103,
          testName: "Unknown test",
          outcome: "Timeout",
          durationMs: 80,
          errorMessage: null,
          stackTrace: null,
          automatedTestName: null,
          automatedTestStorage: null,
        },
      ],
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({
      Authorization: `Basic ${Buffer.from(":secret-pat").toString("base64")}`,
    }));
  });

  it("returns an empty report when the build has no test runs", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ uri: "vstfs:///Build/Build/9" }))
      .mockResolvedValueOnce(jsonResponse({ count: 0, value: [] }));
    let stdout = "";
    let outputContents = "";

    const exitCode = await runCli(["--buildId=9"], environment, {
      fetchImplementation: fetchMock,
      stdout: (text) => { stdout += text; },
      stderr: () => undefined,
      writeFile: async (_path, data) => { outputContents = data; },
      readDirectory: async () => ["ci-error-2026-07-21T12-34-56-789Z-build-9.json"],
      currentWorkingDirectory: () => "/tmp/reports",
      now: () => new Date("2026-07-21T12:34:56.789Z"),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("/tmp/reports/ci-error-2026-07-21T12-34-56-789Z-build-9.json\n");
    expect(JSON.parse(outputContents)).toEqual({ buildId: 9, count: 0, failedTests: [] });
  });

  it("keeps only the five newest report files", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ uri: "vstfs:///Build/Build/9" }))
      .mockResolvedValueOnce(jsonResponse({ count: 0, value: [] }));
    const removedFiles: string[] = [];

    const exitCode = await runCli(["--buildId=9"], environment, {
      fetchImplementation: fetchMock,
      stdout: () => undefined,
      stderr: () => undefined,
      writeFile: async () => undefined,
      readDirectory: async () => [
        "notes.json",
        "ci-error-2026-07-21T12-00-00-000Z-build-1.json",
        "ci-error-2026-07-21T12-10-00-000Z-build-2.json",
        "ci-error-2026-07-21T12-20-00-000Z-build-3.json",
        "ci-error-2026-07-21T12-30-00-000Z-build-4.json",
        "ci-error-2026-07-21T12-31-00-000Z-build-5.json",
        "ci-error-2026-07-21T12-32-00-000Z-build-6.json",
        "ci-error-2026-07-21T12-34-56-789Z-build-9.json",
      ],
      removeFile: async (path) => { removedFiles.push(path); },
      currentWorkingDirectory: () => "/tmp/reports",
      now: () => new Date("2026-07-21T12:34:56.789Z"),
    });

    expect(exitCode).toBe(0);
    expect(removedFiles).toEqual([
      "/tmp/reports/ci-error-2026-07-21T12-00-00-000Z-build-1.json",
      "/tmp/reports/ci-error-2026-07-21T12-10-00-000Z-build-2.json",
    ]);
  });

  it("reports file write errors without printing a success path", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ uri: "vstfs:///Build/Build/9" }))
      .mockResolvedValueOnce(jsonResponse({ count: 0, value: [] }));
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli(["--buildId=9"], environment, {
      fetchImplementation: fetchMock,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      writeFile: async () => { throw new Error("disk full"); },
      currentWorkingDirectory: () => "/tmp/reports",
      now: () => new Date("2026-07-21T12:34:56.789Z"),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "OUTPUT_WRITE_ERROR",
        message: "Unable to write report file: /tmp/reports/ci-error-2026-07-21T12-34-56-789Z-build-9.json",
        status: null,
      },
    });
  });

  it("writes JSON API errors only to stderr", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401));
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli(["--buildId", "123"], environment, {
      fetchImplementation: fetchMock,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "AZURE_API_ERROR",
        message: "Azure DevOps request failed with status 401",
        status: 401,
      },
    });
    expect(stderr).not.toContain("secret-pat");
  });

  it("uses exit code 2 for argument errors", async () => {
    let stderr = "";
    const exitCode = await runCli([], environment, {
      stdout: () => undefined,
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr).error.code).toBe("INVALID_ARGUMENT");
  });
});
