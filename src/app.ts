import { readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AzureDevOpsClient } from "./azure-client.js";
import { analyzeAllureArtifact, type AllureAnalyzer } from "./allure-analyzer.js";
import { AppError, normalizeError } from "./errors.js";
import type { AllureReport, AllureSummary, AzureConfig, FailedTestsReport } from "./types.js";

type Environment = Record<string, string | undefined>;
type Writer = (text: string) => void;
type FileWriter = (path: string, data: string | Uint8Array) => Promise<void>;
type DirectoryReader = (path: string) => Promise<string[]>;
type FileRemover = (path: string) => Promise<void>;

const MAX_REPORT_FILES = 5;
const ALLURE_ARTIFACT_MARKER = "allure-results";

export interface ParsedArguments {
  buildId: number;
  allure: boolean;
}

export interface CliDependencies {
  fetchImplementation?: typeof fetch;
  stdout?: Writer;
  stderr?: Writer;
  writeFile?: FileWriter;
  readDirectory?: DirectoryReader;
  removeFile?: FileRemover;
  currentWorkingDirectory?: () => string;
  now?: () => Date;
  analyzeAllureArtifact?: AllureAnalyzer;
}

export function parseBuildId(args: string[]): number {
  return parseArguments(args).buildId;
}

export function parseArguments(args: string[]): ParsedArguments {
  let rawBuildId: string | undefined;
  let allure = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--buildId") {
      if (rawBuildId !== undefined) {
        throw invalidBuildId("The --buildId argument must be provided exactly once");
      }
      rawBuildId = args[index + 1];
      index += 1;
    } else if (argument?.startsWith("--buildId=")) {
      if (rawBuildId !== undefined) {
        throw invalidBuildId("The --buildId argument must be provided exactly once");
      }
      rawBuildId = argument.slice("--buildId=".length);
    } else if (argument === "--allure") {
      allure = true;
    } else {
      throw invalidBuildId(`Unknown argument: ${argument ?? ""}`);
    }
  }

  if (!rawBuildId || !/^\d+$/.test(rawBuildId)) {
    throw invalidBuildId("The --buildId argument must be a positive integer");
  }

  const buildId = Number(rawBuildId);
  if (!Number.isSafeInteger(buildId) || buildId <= 0) {
    throw invalidBuildId("The --buildId argument must be a positive safe integer");
  }

  return { buildId, allure };
}

export function readConfig(environment: Environment): AzureConfig {
  const organization = requiredVariable(environment, "AZURE_DEVOPS_ORGANIZATION");
  const project = requiredVariable(environment, "AZURE_DEVOPS_PROJECT");
  const personalAccessToken = requiredVariable(environment, "AZURE_PERSONAL_ACCESS_TOKEN");
  return { organization, project, personalAccessToken };
}

export async function createReport(
  args: string[],
  environment: Environment,
  fetchImplementation: typeof fetch = fetch,
): Promise<FailedTestsReport> {
  const buildId = parseBuildId(args);
  const config = readConfig(environment);
  const client = new AzureDevOpsClient(config, fetchImplementation);
  const failedTests = await client.getFailedTests(buildId);
  return { buildId, count: failedTests.length, failedTests };
}

export async function createAllureReport(
  buildId: number,
  environment: Environment,
  fetchImplementation: typeof fetch = fetch,
  outputDirectory = process.cwd(),
  timestamp = new Date().toISOString().replace(/[:.]/g, "-"),
  writeOutputFile: FileWriter = async (path, data) => { await writeFile(path, data); },
  analyzeArtifact: AllureAnalyzer = analyzeAllureArtifact,
): Promise<AllureReport> {
  const config = readConfig(environment);
  const client = new AzureDevOpsClient(config, fetchImplementation);
  const artifacts = await client.getAllureArtifacts(buildId);
  if (artifacts.length === 0) {
    throw new AppError(
      "NO_ALLURE_ARTIFACTS",
      `No build artifacts matched ${ALLURE_ARTIFACT_MARKER}`,
      1,
    );
  }

  const reportArtifacts = [];
  const summary: AllureSummary = {
    results: 0,
    passed: 0,
    failed: 0,
    broken: 0,
    skipped: 0,
    unknown: 0,
  };
  const failures = [];
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (!artifact) {
      continue;
    }
    const path = resolve(
      outputDirectory,
      `ci-allure-${timestamp}-build-${buildId}-${index + 1}.zip`,
    );
    const data = await client.downloadArtifactZip(buildId, artifact.name);

    try {
      await writeOutputFile(path, data);
    } catch {
      throw new AppError("OUTPUT_WRITE_ERROR", `Unable to write report file: ${path}`, 1);
    }

    let analysis;
    try {
      analysis = await analyzeArtifact(data, artifact.name);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("ALLURE_ARCHIVE_ERROR", "Unable to analyze the Allure archive", 1);
    }

    reportArtifacts.push({
      name: artifact.name,
      type: artifact.type,
      path,
      results: analysis.summary.results,
    });
    summary.results += analysis.summary.results;
    summary.passed += analysis.summary.passed;
    summary.failed += analysis.summary.failed;
    summary.broken += analysis.summary.broken;
    summary.skipped += analysis.summary.skipped;
    summary.unknown += analysis.summary.unknown;
    failures.push(...analysis.failures);
  }

  return {
    buildId,
    matchedCount: reportArtifacts.length,
    source: "allure",
    summary,
    artifacts: reportArtifacts,
    failures,
  };
}

export async function runCli(
  args: string[],
  environment: Environment,
  dependencies: CliDependencies = {},
): Promise<number> {
  const writeStdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const writeStderr = dependencies.stderr ?? ((text) => process.stderr.write(text));

  try {
    const parsed = parseArguments(args);
    if (parsed.allure) {
      const timestamp = (dependencies.now ?? (() => new Date()))()
        .toISOString()
        .replace(/[:.]/g, "-");
      const outputDirectory = (dependencies.currentWorkingDirectory ?? process.cwd)();
      const report = await createAllureReport(
        parsed.buildId,
        environment,
        dependencies.fetchImplementation ?? fetch,
        outputDirectory,
        timestamp,
        dependencies.writeFile ?? (async (path, data) => { await writeFile(path, data); }),
        dependencies.analyzeAllureArtifact ?? analyzeAllureArtifact,
      );
      const filePath = resolve(outputDirectory, `ci-allure-${timestamp}-build-${report.buildId}.json`);

      try {
        await (dependencies.writeFile ?? writeFile)(filePath, `${JSON.stringify(report, null, 2)}\n`);
      } catch {
        throw new AppError(
          "OUTPUT_WRITE_ERROR",
          `Unable to write report file: ${filePath}`,
          1,
        );
      }

      writeStdout(`${filePath}\n`);
      return 0;
    }

    const report = await createReport(args, environment, dependencies.fetchImplementation ?? fetch);
    const timestamp = (dependencies.now ?? (() => new Date()))()
      .toISOString()
      .replace(/[:.]/g, "-");
    const outputDirectory = (dependencies.currentWorkingDirectory ?? process.cwd)();
    const filePath = resolve(outputDirectory, `ci-error-${timestamp}-build-${report.buildId}.json`);

    try {
      await (dependencies.writeFile ?? writeFile)(filePath, `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      throw new AppError(
        "OUTPUT_WRITE_ERROR",
        `Unable to write report file: ${filePath}`,
        1,
      );
    }

    try {
      const reportFiles = (await (dependencies.readDirectory ?? readdir)(outputDirectory))
        .filter((name) => name.startsWith("ci-error-") && name.endsWith(".json"))
        .sort();
      const obsoleteFiles = reportFiles.slice(0, -MAX_REPORT_FILES);

      await Promise.all(
        obsoleteFiles.map((name) =>
          (dependencies.removeFile ?? unlink)(resolve(outputDirectory, name)),
        ),
      );
    } catch {
      throw new AppError(
        "OUTPUT_CLEANUP_ERROR",
        `Unable to remove old report files from: ${outputDirectory}`,
        1,
      );
    }

    writeStdout(`${filePath}\n`);
    return 0;
  } catch (error) {
    const normalized = normalizeError(error);
    writeStderr(
      `${JSON.stringify(
        {
          error: {
            code: normalized.code,
            message: normalized.message,
            status: normalized.status,
          },
        },
        null,
        2,
      )}\n`,
    );
    return normalized.exitCode;
  }
}

function requiredVariable(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new AppError(
      "MISSING_CONFIGURATION",
      `Missing required environment variable: ${name}`,
      2,
    );
  }
  return value;
}

function invalidBuildId(message: string): AppError {
  return new AppError("INVALID_ARGUMENT", message, 2);
}
