# Orangebeard CodeceptJS Listener

A [CodeceptJS](https://codecept.io/) Mocha reporter that sends test results to [Orangebeard](https://orangebeard.io).

## What gets reported

| CodeceptJS concept | Orangebeard entity |
|---|---|
| Feature | Suite |
| Scenario | Test |
| `I.*` steps | Steps (with actual execution times) |
| BeforeSuite / AfterSuite | BEFORE / AFTER test items |
| Tags (`@tag`) | Test attributes |
| Failure screenshots | Attachments |
| Error details | Log entries (with stack traces) |

## Installation

```bash
npm install @orangebeard-io/codeceptjs-listener --save-dev
```

## Configuration

### 1. Orangebeard connection (`orangebeard.json`)

Create an `orangebeard.json` in your project root (or any parent directory):

```json
{
  "endpoint": "https://your-instance.orangebeard.app",
  "token": "your-api-token",
  "project": "your-project-name",
  "testset": "Your Test Set Name",
  "description": "CodeceptJS test run",
  "attributes": [
    { "key": "env", "value": "ci" }
  ]
}
```

Alternatively, use environment variables:

| Variable | Description |
|---|---|
| `ORANGEBEARD_ENDPOINT` | Orangebeard instance URL |
| `ORANGEBEARD_TOKEN` | API access token |
| `ORANGEBEARD_PROJECT` | Project name |
| `ORANGEBEARD_TESTSET` | Test set name |

### 2. CodeceptJS reporter (`codecept.conf.js` / `codecept.conf.ts`)

```js
exports.config = {
  // ...your existing config...
  mocha: {
    reporter: '@orangebeard-io/codeceptjs-listener',
    reporterOptions: {
      // Optional: override orangebeard.json settings
      // endpoint: 'https://...',
      // token: '...',
      // project: '...',
      // testset: '...',
    },
  },
};
```

### Screenshots

The reporter automatically picks up failure screenshots created by CodeceptJS's
built-in `screenshotOnFail` plugin and attaches them to the corresponding test
in Orangebeard.

Make sure the plugin is enabled (it is by default):

```js
exports.config = {
  // ...
  plugins: {
    screenshotOnFail: {
      enabled: true,
    },
  },
};
```

## Usage

Run your tests as usual:

```bash
npx codeceptjs run
```

Results will be reported to Orangebeard in real time.

## License

Apache-2.0 — see [LICENSE](LICENSE).
