export const FAILURE_OUTCOMES = [
  "Failed",
  "Error",
  "Timeout",
  "Aborted",
  "Inconclusive",
] as const;

export type FailureOutcome = (typeof FAILURE_OUTCOMES)[number];

export interface FailedTest {
  runId: number;
  runName: string;
  testId: number;
  testName: string;
  outcome: FailureOutcome;
  durationMs: number | null;
  errorMessage: string | null;
  stackTrace: string | null;
  automatedTestName: string | null;
  automatedTestStorage: string | null;
}

export interface FailedTestsReport {
  buildId: number;
  count: number;
  failedTests: FailedTest[];
}

export interface AllureArtifactReport {
  name: string;
  type: string | null;
  path: string;
  results: number;
}

export type AllureStatus = "passed" | "failed" | "broken" | "skipped" | "unknown";

export interface AllureSummary {
  results: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  unknown: number;
}

export type AllureNormalizedValue = string | string[];

export interface AllureAttachment {
  name: string | null;
  type: string | null;
  source: string | null;
}

export interface AllureError {
  message: string | null;
  trace: string | null;
}

export interface AllureCucumber {
  feature: string | null;
  scenario: string | null;
  uri: string | null;
  line: number | null;
  tags: string[];
}

export interface AllureFailedStep {
  name: string | null;
  status: AllureStatus;
  message: string | null;
  trace: string | null;
}

export interface AllureFailure {
  artifactName: string;
  uuid: string | null;
  historyId: string | null;
  name: string | null;
  status: AllureStatus;
  stage: string | null;
  start: number | null;
  stop: number | null;
  durationMs: number | null;
  error: AllureError;
  cucumber: AllureCucumber;
  parameters: Record<string, AllureNormalizedValue>;
  labels: Record<string, AllureNormalizedValue>;
  failedSteps: AllureFailedStep[];
  attachments: AllureAttachment[];
}

export interface AllureReport {
  buildId: number;
  matchedCount: number;
  source: "allure";
  summary: AllureSummary;
  artifacts: AllureArtifactReport[];
  failures: AllureFailure[];
}

export interface AzureConfig {
  organization: string;
  project: string;
  personalAccessToken: string;
}
