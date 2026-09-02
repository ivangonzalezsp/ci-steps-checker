import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  analyzeAllureArtifact,
  validateArchiveMemberName,
} from "../src/allure-analyzer.js";

const execFileAsync = promisify(execFile);

async function createZip(results: Record<string, unknown>[]): Promise<{
  directory: string;
  zipPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ci-steps-checker-test-"));
  const resultsDirectory = join(directory, "results");
  await execFileAsync("mkdir", [resultsDirectory]);
  for (let index = 0; index < results.length; index += 1) {
    await writeFile(
      join(resultsDirectory, `${index}-result.json`),
      `${JSON.stringify(results[index])}\n`,
    );
  }
  const tgzPath = join(directory, "allure-results.tgz");
  await execFileAsync("tar", ["-czf", tgzPath, "-C", resultsDirectory, "."]);
  const zipPath = join(directory, "artifact.zip");
  await execFileAsync("zip", ["-q", zipPath, "allure-results.tgz"], { cwd: directory });
  return { directory, zipPath };
}

describe("Allure archive analysis", () => {
  it("aggregates statuses and maps failure fields without attachment contents", async () => {
    const longMessage = "m".repeat(9 * 1024);
    const longTrace = "t".repeat(33 * 1024);
    const fixture = await createZip([
      {
        uuid: "failed-uuid",
        historyId: "history-1",
        name: "A failed scenario",
        status: "failed",
        stage: "finished",
        start: 100,
        stop: 175,
        duration: null,
        statusDetails: { message: longMessage, trace: longTrace },
        parameters: [
          { name: "browser", value: "chrome" },
          { name: "browser", value: "firefox" },
        ],
        labels: [
          { name: "feature", value: "Checkout" },
          { name: "framework", value: "cucumber" },
        ],
        attachments: [
          { name: "root screenshot", type: "image/png", source: "root.png", content: "ignored" },
        ],
        steps: [
          {
            name: "failed outer step",
            status: "failed",
            statusDetails: { message: "step message", trace: "step trace" },
            attachments: [{ name: "root screenshot", type: "image/png", source: "root.png" }],
            steps: [
              {
                name: "broken nested step",
                status: "broken",
                statusDetails: { message: "nested message" },
              },
            ],
          },
        ],
      },
      { uuid: "passed-uuid", name: "A passed scenario", status: "passed" },
      { uuid: "broken-uuid", name: "A broken scenario", status: "broken" },
      { uuid: "skipped-uuid", name: "A skipped scenario", status: "skipped" },
      { uuid: "unknown-uuid", name: "An unknown scenario", status: "future-status" },
    ]);

    try {
      const report = await analyzeAllureArtifact(
        await readFile(fixture.zipPath),
        "allure-results",
      );

      expect(report.summary).toEqual({
        results: 5,
        passed: 1,
        failed: 1,
        broken: 1,
        skipped: 1,
        unknown: 1,
      });
      expect(report.failures).toHaveLength(2);
      const failure = report.failures.find((item) => item.uuid === "failed-uuid")!;
      expect(failure).toMatchObject({
        artifactName: "allure-results",
        uuid: "failed-uuid",
        historyId: "history-1",
        name: "A failed scenario",
        status: "failed",
        stage: "finished",
        start: 100,
        stop: 175,
        durationMs: 75,
        cucumber: {
          feature: "Checkout",
          scenario: null,
          uri: null,
          line: null,
          tags: [],
        },
        parameters: { browser: ["chrome", "firefox"] },
        labels: { feature: "Checkout", framework: "cucumber" },
        failedSteps: [
          { name: "failed outer step", status: "failed", message: "step message", trace: "step trace" },
          { name: "broken nested step", status: "broken", message: "nested message", trace: null },
        ],
        attachments: [{ name: "root screenshot", type: "image/png", source: "root.png" }],
      });
      expect(failure.error.message).toHaveLength(8 * 1024);
      expect(failure.error.trace).toHaveLength(32 * 1024);
      expect(JSON.stringify(failure)).not.toContain("ignored");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("accepts a valid artifact with no result members", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-steps-checker-empty-"));
    try {
      await writeFile(join(directory, "note.txt"), "not a result");
      await execFileAsync("tar", ["-czf", join(directory, "allure-results.tgz"), "-C", directory, "note.txt"]);
      await execFileAsync("zip", ["-q", join(directory, "artifact.zip"), "allure-results.tgz"], { cwd: directory });
      const report = await analyzeAllureArtifact(
        await readFile(join(directory, "artifact.zip")),
        "empty",
      );
      expect(report).toEqual({
        summary: { results: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 },
        failures: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe archive member names", () => {
    expect(() => validateArchiveMemberName("../outside.json")).toThrow("unsafe member name");
    expect(() => validateArchiveMemberName("/absolute.json")).toThrow("unsafe member name");
    expect(() => validateArchiveMemberName("C:\\outside.json")).toThrow("unsafe member name");
  });

  it("reports malformed ZIP data as an explicit archive error", async () => {
    await expect(analyzeAllureArtifact(Uint8Array.from([1, 2, 3]), "invalid")).rejects.toMatchObject({
      code: "ALLURE_ARCHIVE_ERROR",
    });
  });

  it("rejects a result member that is not a regular file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-steps-checker-link-"));
    try {
      await symlink("missing-result.json", join(directory, "bad-result.json"));
      await execFileAsync("tar", ["-czf", join(directory, "allure-results.tgz"), "-C", directory, "bad-result.json"]);
      await execFileAsync("zip", ["-q", join(directory, "artifact.zip"), "allure-results.tgz"], { cwd: directory });
      await expect(
        analyzeAllureArtifact(await readFile(join(directory, "artifact.zip")), "link"),
      ).rejects.toMatchObject({ code: "ALLURE_ARCHIVE_ERROR" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
