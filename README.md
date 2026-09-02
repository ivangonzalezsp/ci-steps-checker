# CI Steps Checker

A small TypeScript CLI that writes published failing test cases for an Azure DevOps pipeline build to a JSON file.

## Requirements

- Node.js 20 or newer
- An Azure DevOps PAT with **Build (Read)** (`vso.build`) and **Test Management (Read)** (`vso.test`) access

## Setup

```sh
pnpm install
pnpm add --global .
export AZURE_DEVOPS_ORGANIZATION="your-organization"
export AZURE_DEVOPS_PROJECT="your-project"
export AZURE_PERSONAL_ACCESS_TOKEN="your-pat"
```

Keep the PAT in the environment. Do not add it to `.env` files committed to source control.

## Usage

```sh
pipeline-errors --buildId 12345
```

To download every build artifact whose name contains `allure-results` (case-insensitive) as a ZIP and write a manifest, add `--allure`:

```sh
pipeline-errors --buildId 12345 --allure
```

The global install runs the TypeScript build automatically. Run `pnpm add --global .` again after changing the source, or use `pnpm link --global` during active development.

Success writes the JSON report to `ci-error-{timestamp}-build-{buildId}.json` in the current working directory. After writing, the command keeps only the five newest `ci-error-*.json` reports and removes older ones. Other files are not affected. Stdout contains only the absolute path to the generated file:

```text
/current/directory/ci-error-2026-07-21T12-34-56-789Z-build-12345.json
```

The generated file contains:

```json
{
  "buildId": 12345,
  "count": 1,
  "failedTests": [
    {
      "runId": 45,
      "runName": "Unit tests",
      "testId": 100001,
      "testName": "checkout rejects an expired card",
      "outcome": "Failed",
      "durationMs": 125,
      "errorMessage": "Expected 402 but received 200",
      "stackTrace": "...",
      "automatedTestName": "checkout rejects an expired card",
      "automatedTestStorage": "checkout.test.js"
    }
  ]
}
```

In Allure mode, stdout contains the absolute path to a `ci-allure-*.json` manifest. Each matching artifact is downloaded to a separately named `ci-allure-*.zip` file. The manifest keeps the artifact name, type, local ZIP path, and number of result files, and also contains the aggregate result summary and failures from all artifacts. The analyzer follows the supported Azure artifact layout (ZIP -> TGZ -> `*-result.json`) and only extracts the explicit result JSON members into a temporary directory; attachment and `environment.properties` contents are never read. If no artifact name matches `allure-results`, the command exits with an error.

The Allure summary contains `results`, `passed`, `failed`, `broken`, `skipped`, and `unknown`. Both `failed` and `broken` results are included in `failures`. Failure entries include the result identity/timing, truncated status details, normalized parameters and labels, available Cucumber fields, recursively collected failed steps, and attachment metadata (`name`, `type`, and `source`) only. Missing Cucumber `uri`, `line`, and `tags` remain `null`, `null`, and `[]` respectively. Analysis rejects unsafe archive member names and stops on more than 10,000 result members, 64 MiB of extracted result JSON, or a 4 MiB individual result JSON.

An invalid ZIP/TGZ/result JSON, an archive limit violation, or an unavailable `unzip`/`tar` command is reported explicitly on stderr. A valid artifact with no result members contributes `results: 0` and does not prevent other matching artifacts from being analyzed.

The Allure manifest has this shape (values are illustrative):

```json
{
  "buildId": 12345,
  "matchedCount": 1,
  "source": "allure",
  "summary": {
    "results": 2,
    "passed": 1,
    "failed": 1,
    "broken": 0,
    "skipped": 0,
    "unknown": 0
  },
  "artifacts": [
    {
      "name": "allure-results",
      "type": "Container",
      "path": "/current/directory/ci-allure-2026-07-21T12-34-56-789Z-build-12345-1.zip",
      "results": 2
    }
  ],
  "failures": []
}
```

The reported terminal outcomes are `Failed`, `Error`, `Timeout`, `Aborted`, and `Inconclusive`. A build with no published test failures returns an empty `failedTests` array.

Errors write only JSON to stderr. Invalid input or configuration exits with code 2; Azure API, response, and network failures exit with code 1.

```json
{
  "error": {
    "code": "AZURE_API_ERROR",
    "message": "Azure DevOps request failed with status 401",
    "status": 401
  }
}
```

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```
