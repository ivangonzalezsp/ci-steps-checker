import { AppError } from "./errors.js";
import {
  FAILURE_OUTCOMES,
  type AzureConfig,
  type FailedTest,
  type FailureOutcome,
} from "./types.js";

const API_VERSION = "7.1";
const RUN_PAGE_SIZE = 100;
const RESULT_PAGE_SIZE = 1000;

interface AzureCollection<T> {
  count: number;
  value: T[];
}

interface AzureBuild {
  uri: string;
}

interface AzureBuildArtifact {
  name?: string;
  type?: string;
  resource?: {
    type?: string;
  };
}

interface AzureTestRun {
  id: number;
  name?: string;
}

interface AzureTestResult {
  id: number;
  outcome?: string;
  durationInMs?: number | string;
  errorMessage?: string;
  stackTrace?: string;
  automatedTestName?: string;
  automatedTestStorage?: string;
  testCase?: {
    name?: string;
  };
}

type Fetch = typeof fetch;

export interface BuildArtifact {
  name: string;
  type: string | null;
}

export class AzureDevOpsClient {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(
    private readonly config: AzureConfig,
    private readonly fetchImplementation: Fetch = fetch,
  ) {
    this.baseUrl = `https://dev.azure.com/${encodeURIComponent(config.organization)}/${encodeURIComponent(config.project)}/_apis`;
    this.authorization = `Basic ${Buffer.from(`:${config.personalAccessToken}`).toString("base64")}`;
  }

  async getFailedTests(buildId: number): Promise<FailedTest[]> {
    const build = await this.requestJson<AzureBuild>(
      `/build/builds/${buildId}`,
      new URLSearchParams({ "api-version": API_VERSION }),
    );

    if (!build || typeof build.uri !== "string" || build.uri.length === 0) {
      throw new AppError("INVALID_RESPONSE", "Azure DevOps returned an invalid build response", 1);
    }

    const runs = await this.getAllRuns(build.uri);
    const failedTests: FailedTest[] = [];

    for (const run of runs) {
      const results = await this.getAllFailedResults(run.id);
      for (const result of results) {
        const mapped = mapFailedTest(run, result);
        if (mapped) {
          failedTests.push(mapped);
        }
      }
    }

    return failedTests;
  }

  async getAllureArtifacts(buildId: number): Promise<BuildArtifact[]> {
    const response = await this.requestCollection<AzureBuildArtifact>(
      `/build/builds/${buildId}/artifacts`,
      new URLSearchParams({ "api-version": API_VERSION }),
    );

    return response.value.flatMap((artifact) => {
      if (!artifact || typeof artifact.name !== "string" || artifact.name.length === 0) {
        return [];
      }

      if (!artifact.name.toLowerCase().includes("allure-results")) {
        return [];
      }

      return [{
        name: artifact.name,
        type: typeof artifact.type === "string"
          ? artifact.type
          : typeof artifact.resource?.type === "string"
            ? artifact.resource.type
            : null,
      }];
    });
  }

  async downloadArtifactZip(buildId: number, artifactName: string): Promise<Uint8Array> {
    const query = new URLSearchParams({
      artifactName,
      "$format": "zip",
      "api-version": API_VERSION,
    });
    const url = `${this.baseUrl}/build/builds/${buildId}/artifacts?${query.toString()}`;
    const response = await this.request(url, "application/zip");

    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new AppError("INVALID_RESPONSE", "Azure DevOps returned invalid artifact data", 1);
    }
  }

  private async getAllRuns(buildUri: string): Promise<AzureTestRun[]> {
    const runs: AzureTestRun[] = [];

    for (let skip = 0; ; skip += RUN_PAGE_SIZE) {
      const page = await this.requestCollection<AzureTestRun>(
        "/test/runs",
        new URLSearchParams({
          buildUri,
          "$skip": String(skip),
          "$top": String(RUN_PAGE_SIZE),
          "api-version": API_VERSION,
        }),
      );
      runs.push(...page.value);

      if (page.value.length < RUN_PAGE_SIZE) {
        return runs;
      }
    }
  }

  private async getAllFailedResults(runId: number): Promise<AzureTestResult[]> {
    const results: AzureTestResult[] = [];

    for (let skip = 0; ; skip += RESULT_PAGE_SIZE) {
      const page = await this.requestCollection<AzureTestResult>(
        `/test/Runs/${runId}/results`,
        new URLSearchParams({
          outcomes: FAILURE_OUTCOMES.join(","),
          "$skip": String(skip),
          "$top": String(RESULT_PAGE_SIZE),
          "api-version": API_VERSION,
        }),
      );
      results.push(...page.value);

      if (page.value.length < RESULT_PAGE_SIZE) {
        return results;
      }
    }
  }

  private async requestCollection<T>(path: string, query: URLSearchParams): Promise<AzureCollection<T>> {
    const response = await this.requestJson<AzureCollection<T>>(path, query);
    if (
      !response ||
      typeof response.count !== "number" ||
      !Array.isArray(response.value)
    ) {
      throw new AppError("INVALID_RESPONSE", "Azure DevOps returned an invalid collection response", 1);
    }
    return response;
  }

  private async requestJson<T>(path: string, query: URLSearchParams): Promise<T> {
    const url = `${this.baseUrl}${path}?${query.toString()}`;
    const response = await this.request(url, "application/json");

    try {
      return (await response.json()) as T;
    } catch {
      throw new AppError("INVALID_RESPONSE", "Azure DevOps returned invalid JSON", 1);
    }
  }

  private async request(url: string, accept: string): Promise<Response> {
    let response: Response;

    try {
      response = await this.fetchImplementation(url, {
        headers: {
          Accept: accept,
          Authorization: this.authorization,
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new AppError("NETWORK_ERROR", "Unable to reach Azure DevOps", 1);
    }

    if (!response.ok) {
      throw new AppError(
        "AZURE_API_ERROR",
        `Azure DevOps request failed with status ${response.status}`,
        1,
        response.status,
      );
    }

    return response;
  }
}

function mapFailedTest(run: AzureTestRun, result: AzureTestResult): FailedTest | null {
  const outcome = normalizeOutcome(result.outcome);
  if (!outcome || !Number.isInteger(run.id) || !Number.isInteger(result.id)) {
    return null;
  }

  const duration = Number(result.durationInMs);
  return {
    runId: resultNumber(run.id),
    runName: stringOrEmpty(run.name),
    testId: resultNumber(result.id),
    testName:
      nonEmptyString(result.testCase?.name) ??
      nonEmptyString(result.automatedTestName) ??
      "Unknown test",
    outcome,
    durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
    errorMessage: stringOrNull(result.errorMessage),
    stackTrace: stringOrNull(result.stackTrace),
    automatedTestName: stringOrNull(result.automatedTestName),
    automatedTestStorage: stringOrNull(result.automatedTestStorage),
  };
}

function normalizeOutcome(value: string | undefined): FailureOutcome | null {
  if (!value) {
    return null;
  }
  return FAILURE_OUTCOMES.find((outcome) => outcome.toLowerCase() === value.toLowerCase()) ?? null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resultNumber(value: number): number {
  return value;
}
