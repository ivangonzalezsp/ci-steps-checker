export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "MISSING_CONFIGURATION"
  | "NETWORK_ERROR"
  | "AZURE_API_ERROR"
  | "INVALID_RESPONSE"
  | "NO_ALLURE_ARTIFACTS"
  | "ALLURE_ARCHIVE_ERROR"
  | "ALLURE_LIMIT_EXCEEDED"
  | "ALLURE_ANALYZER_UNAVAILABLE"
  | "OUTPUT_WRITE_ERROR"
  | "OUTPUT_CLEANUP_ERROR";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly exitCode: 1 | 2,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("NETWORK_ERROR", "Unexpected application error", 1);
}
