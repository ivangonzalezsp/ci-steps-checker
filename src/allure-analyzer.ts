import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors.js";
import type {
  AllureAttachment,
  AllureCucumber,
  AllureError,
  AllureFailure,
  AllureFailedStep,
  AllureNormalizedValue,
  AllureStatus,
  AllureSummary,
} from "./types.js";

const execFileAsync = promisify(execFile);

export const ALLURE_LIMITS = {
  maxResultMembers: 10_000,
  maxExtractedJsonBytes: 64 * 1024 * 1024,
  maxResultJsonBytes: 4 * 1024 * 1024,
} as const;

const MAX_LIST_OUTPUT_BYTES = 64 * 1024 * 1024;
const ALLURE_STATUSES = new Set<AllureStatus>([
  "passed",
  "failed",
  "broken",
  "skipped",
  "unknown",
]);

export interface AllureArtifactAnalysis {
  summary: AllureSummary;
  failures: AllureFailure[];
}

export type AllureAnalyzer = (
  zipData: Uint8Array,
  artifactName: string,
) => Promise<AllureArtifactAnalysis>;

interface ArchiveCommandError {
  code?: string | number;
  message?: string;
}

interface AllureResult {
  [key: string]: unknown;
}

interface TgzResults {
  path: string;
  members: string[];
}

export async function analyzeAllureArtifact(
  zipData: Uint8Array,
  artifactName: string,
): Promise<AllureArtifactAnalysis> {
  let temporaryDirectory: string | undefined;

  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "ci-steps-checker-allure-"));
    const zipPath = join(temporaryDirectory, "artifact.zip");
    await writeFile(zipPath, zipData);

    const zipMembers = await listArchiveMembers("unzip", ["-Z1", zipPath]);
    const tgzMembers = zipMembers.filter((member) => member.toLowerCase().endsWith(".tgz"));
    const tgzResults: TgzResults[] = [];
    let resultMemberCount = 0;

    for (let index = 0; index < tgzMembers.length; index += 1) {
      const tgzMember = tgzMembers[index];
      if (!tgzMember) {
        continue;
      }

      const tgzData = await runCommand("unzip", ["-p", zipPath, tgzMember], MAX_LIST_OUTPUT_BYTES);
      const tgzPath = join(temporaryDirectory, `results-${index}.tgz`);
      await writeFile(tgzPath, tgzData);
      const members = await listArchiveMembers("tar", ["-tzf", tgzPath]);
      const resultNames = members.filter((member) => member.toLowerCase().endsWith("-result.json"));
      tgzResults.push({ path: tgzPath, members: resultNames });
      resultMemberCount += resultNames.length;

      if (resultMemberCount > ALLURE_LIMITS.maxResultMembers) {
        throw new AppError(
          "ALLURE_LIMIT_EXCEEDED",
          "Allure archive exceeds the maximum number of result files",
          1,
        );
      }
    }

    const summary = emptySummary();
    const failures: AllureFailure[] = [];
    let extractedJsonBytes = 0;

    for (let index = 0; index < tgzResults.length; index += 1) {
      const tgz = tgzResults[index];
      if (!tgz || tgz.members.length === 0) {
        continue;
      }
      const resultDirectory = join(temporaryDirectory, `extracted-results-${index}`);
      await mkdir(resultDirectory);
      const memberListPath = join(resultDirectory, "members.txt");
      await writeFile(memberListPath, `${tgz.members.join("\n")}\n`);
      await runCommand(
        "tar",
        ["-xzf", tgz.path, "-C", resultDirectory, "-T", memberListPath],
        MAX_LIST_OUTPUT_BYTES,
      );
      const extractedRoot = await safeRealpath(resultDirectory);

      for (const member of tgz.members) {
        const resultPath = archiveMemberPath(resultDirectory, member);
        let resultStat;
        try {
          resultStat = await lstat(resultPath);
        } catch {
          throw new AppError("ALLURE_ARCHIVE_ERROR", "Allure result member could not be extracted", 1);
        }
        if (!resultStat.isFile()) {
          throw new AppError(
            "ALLURE_ARCHIVE_ERROR",
            "Allure result member is not a regular file",
            1,
          );
        }
        const resultRealPath = await safeRealpath(resultPath);
        if (!isWithinDirectory(extractedRoot, resultRealPath)) {
          throw new AppError(
            "ALLURE_ARCHIVE_ERROR",
            "Allure result member resolves outside the temporary directory",
            1,
          );
        }
        if (resultStat.size > ALLURE_LIMITS.maxResultJsonBytes) {
          throw new AppError(
            "ALLURE_LIMIT_EXCEEDED",
            "An Allure result file exceeds the maximum size",
            1,
          );
        }

        const resultData = await readFile(resultPath);
        if (resultData.length > ALLURE_LIMITS.maxResultJsonBytes) {
          throw new AppError(
            "ALLURE_LIMIT_EXCEEDED",
            "An Allure result file exceeds the maximum size",
            1,
          );
        }

        extractedJsonBytes += resultData.length;
        if (extractedJsonBytes > ALLURE_LIMITS.maxExtractedJsonBytes) {
          throw new AppError(
            "ALLURE_LIMIT_EXCEEDED",
            "Allure result files exceed the maximum extracted JSON size",
            1,
          );
        }

        const result = parseResult(resultData);
        const status = normalizeStatus(result.status);
        summary.results += 1;
        summary[status] += 1;

        if (status === "failed" || status === "broken") {
          failures.push(mapFailure(artifactName, result, status));
        }
      }
    }

    return { summary, failures };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError("ALLURE_ARCHIVE_ERROR", "Unable to analyze the Allure archive", 1);
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function listArchiveMembers(command: "unzip" | "tar", args: string[]): Promise<string[]> {
  const output = await runCommand(command, args, MAX_LIST_OUTPUT_BYTES);
  const members = output.toString("utf8").split(/\r?\n/).filter((member) => member.length > 0);
  for (const member of members) {
    validateArchiveMemberName(member);
  }
  return members;
}

async function runCommand(command: string, args: string[], maxBuffer: number): Promise<Buffer> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "buffer",
      maxBuffer,
      timeout: 120_000,
      shell: false,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (error) {
    const commandError = error as ArchiveCommandError;
    if (commandError.code === "ENOENT") {
      throw new AppError(
        "ALLURE_ANALYZER_UNAVAILABLE",
        `Required archive command is unavailable: ${command}`,
        1,
      );
    }
    if (
      commandError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      commandError.message?.toLowerCase().includes("maxbuffer")
    ) {
      throw new AppError("ALLURE_LIMIT_EXCEEDED", "Allure archive exceeds the analysis limits", 1);
    }
    throw new AppError("ALLURE_ARCHIVE_ERROR", "Unable to analyze the Allure archive", 1);
  }
}

export function validateArchiveMemberName(member: string): void {
  if (
    member.length === 0 ||
    member.includes("\0") ||
    member.includes("\r") ||
    member.includes("\n") ||
    member.startsWith("/") ||
    member.startsWith("\\") ||
    member.startsWith("-") ||
    /^[A-Za-z]:[\\/]/.test(member)
  ) {
    throw new AppError("ALLURE_ARCHIVE_ERROR", "Allure archive contains an unsafe member name", 1);
  }

  const segments = member.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new AppError("ALLURE_ARCHIVE_ERROR", "Allure archive contains an unsafe member name", 1);
  }
}

function archiveMemberPath(directory: string, member: string): string {
  const relativeMember = member.replace(/^(?:\.\/)+/, "");
  const resultPath = resolve(directory, relativeMember);
  const directoryPath = resolve(directory);
  if (!isWithinDirectory(directoryPath, resultPath)) {
    throw new AppError("ALLURE_ARCHIVE_ERROR", "Allure archive contains an unsafe member name", 1);
  }
  if (relativeMember.length === 0) {
    throw new AppError("ALLURE_ARCHIVE_ERROR", "Allure archive contains an unsafe member name", 1);
  }
  return resultPath;
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new AppError("ALLURE_ARCHIVE_ERROR", "Allure archive contains an invalid result path", 1);
  }
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${sep}`);
}

function parseResult(data: Buffer): AllureResult {
  try {
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as AllureResult;
  } catch {
    throw new AppError("ALLURE_ARCHIVE_ERROR", "Allure archive contains invalid result JSON", 1);
  }
}

function emptySummary(): AllureSummary {
  return { results: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
}

function mapFailure(artifactName: string, result: AllureResult, status: AllureStatus): AllureFailure {
  const labels = normalizeValues(result.labels);
  const start = safeNumber(result.start);
  const stop = safeNumber(result.stop);
  const duration = safeNumber(result.duration);
  const statusDetails = asRecord(result.statusDetails);

  return {
    artifactName,
    uuid: stringOrNull(result.uuid),
    historyId: stringOrNull(result.historyId),
    name: stringOrNull(result.name),
    status,
    stage: stringOrNull(result.stage),
    start,
    stop,
    durationMs: duration ?? derivedDuration(start, stop),
    error: {
      message: truncate(stringOrNull(statusDetails?.message), 8 * 1024),
      trace: truncate(stringOrNull(statusDetails?.trace), 32 * 1024),
    },
    cucumber: mapCucumber(result.cucumber, labels),
    parameters: normalizeValues(result.parameters),
    labels,
    failedSteps: mapFailedSteps(result.steps),
    attachments: mapAttachments(result),
  };
}

function mapCucumber(value: unknown, labels: Record<string, AllureNormalizedValue>): AllureCucumber {
  const cucumber = asRecord(value);
  const directTags = Array.isArray(cucumber?.tags)
    ? cucumber.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  return {
    feature: stringOrNull(cucumber?.feature) ?? firstValue(labels.feature),
    scenario: stringOrNull(cucumber?.scenario) ?? firstValue(labels.scenario),
    uri: stringOrNull(cucumber?.uri) ?? firstValue(labels.uri),
    line: safeNumber(cucumber?.line),
    tags: directTags,
  };
}

function mapFailedSteps(value: unknown): AllureFailedStep[] {
  const failures: AllureFailedStep[] = [];
  visitSteps(value, (step, status) => {
    if (status === "failed" || status === "broken") {
      const details = asRecord(step.statusDetails);
      failures.push({
        name: stringOrNull(step.name),
        status,
        message: truncate(stringOrNull(details?.message), 8 * 1024),
        trace: truncate(stringOrNull(details?.trace), 32 * 1024),
      });
    }
  });
  return failures;
}

function mapAttachments(result: AllureResult): AllureAttachment[] {
  const attachments: AllureAttachment[] = [];
  const seen = new Set<string>();

  const add = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const attachment = value as Record<string, unknown>;
    const mapped = {
      name: stringOrNull(attachment.name),
      type: stringOrNull(attachment.type),
      source: stringOrNull(attachment.source),
    };
    const key = `${mapped.name}\0${mapped.type}\0${mapped.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      attachments.push(mapped);
    }
  };

  if (Array.isArray(result.attachments)) {
    result.attachments.forEach(add);
  }
  visitSteps(result.steps, (step) => {
    if (Array.isArray(step.attachments)) {
      step.attachments.forEach(add);
    }
  });
  return attachments;
}

function visitSteps(
  value: unknown,
  visit: (step: Record<string, unknown>, status: AllureStatus) => void,
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    const step = asRecord(item);
    if (!step) {
      continue;
    }
    const status = normalizeStatus(step.status);
    visit(step, status);
    visitSteps(step.steps, visit);
  }
}

function normalizeStatus(value: unknown): AllureStatus {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.trim().toLowerCase() as AllureStatus;
  return ALLURE_STATUSES.has(normalized) ? normalized : "unknown";
}

function normalizeValues(value: unknown): Record<string, AllureNormalizedValue> {
  const normalized: Record<string, AllureNormalizedValue> = {};
  const add = (name: unknown, rawValue: unknown): void => {
    if (typeof name !== "string" || name.length === 0) {
      return;
    }
    const values = toStrings(rawValue);
    if (values.length === 0) {
      return;
    }
    const existing = normalized[name];
    if (existing === undefined) {
      normalized[name] = values.length === 1 ? values[0]! : values;
    } else {
      const existingValues = Array.isArray(existing) ? existing : [existing];
      normalized[name] = [...existingValues, ...values];
    }
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      const pair = asRecord(item);
      if (pair) {
        add(pair.name, pair.value);
      }
    }
  } else {
    const record = asRecord(value);
    if (record) {
      for (const [name, rawValue] of Object.entries(record)) {
        add(name, rawValue);
      }
    }
  }
  return normalized;
}

function toStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }
    if (typeof item === "number" || typeof item === "boolean") {
      return [String(item)];
    }
    return [];
  });
}

function firstValue(value: AllureNormalizedValue | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.[0] ?? null;
}

function derivedDuration(start: number | null, stop: number | null): number | null {
  if (start === null || stop === null || stop < start) {
    return null;
  }
  const duration = stop - start;
  return Number.isSafeInteger(duration) ? duration : null;
}

function safeNumber(value: unknown): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function truncate(value: string | null, maxBytes: number): string | null {
  if (value === null || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
