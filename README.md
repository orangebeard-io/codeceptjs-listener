<h1 align="center">
  <br>Orangebeard.io CodeceptJS Listener<br>
</h1>

<h4 align="center">Report <a href="https://codecept.io/" target="_blank" rel="noopener">CodeceptJS</a> test results to Orangebeard.</h4>

<p align="center">
  <a href="https://www.npmjs.com/package/@orangebeard-io/codeceptjs-listener">
    <img src="https://img.shields.io/npm/v/@orangebeard-io/codeceptjs-listener.svg?style=flat-square"
      alt="NPM Version" />
  </a>
  <a href="https://github.com/orangebeard-io/codeceptjs-listener/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/orangebeard-io/codeceptjs-listener?style=flat-square"
      alt="License" />
  </a>
</p>

<div align="center">
  <h4>
    <a href="https://orangebeard.io">Orangebeard</a> |
    <a href="#installation">Installation</a> |
    <a href="#configuration">Configuration</a>
  </h4>
</div>

## Installation

### Install the npm package

```shell
npm install @orangebeard-io/codeceptjs-listener --save-dev
```

## Configuration

### 1. Orangebeard connection

Create `orangebeard.json` in your project root (or any parent directory):

```JSON
{
  "endpoint": "https://your-instance.orangebeard.app",
  "token": "your-api-token",
  "project": "your-project-name",
  "testset": "Your Test Set Name",
  "description": "CodeceptJS test run",
  "attributes": [
    {
      "key": "env",
      "value": "ci"
    }
  ]
}
```

You can also provide connection values with environment variables:

- `ORANGEBEARD_ENDPOINT`
- `ORANGEBEARD_TOKEN`
- `ORANGEBEARD_PROJECT`
- `ORANGEBEARD_TESTSET`

### 2. Configure the reporter in CodeceptJS

Set the Mocha reporter in `codecept.conf.js` or `codecept.conf.ts`:

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

### 3. Screenshots (optional)

The reporter attaches failure screenshots produced by CodeceptJS `screenshotOnFail`.

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

## Running

Run tests as usual:

```shell
npx codeceptjs run
```

Results are streamed to Orangebeard in real time.

## What gets reported

The reporter will:

- Map CodeceptJS Features to Orangebeard suites.
- Map Scenarios to Orangebeard tests.
- Report `I.*` actions as real-time steps.
- Group hook activity under `Before` / `After` parent steps.
- Group `I.say(...)` sections as parent comment steps.
- Parse tags into Orangebeard test attributes.
- Attach failure screenshots to the related test.
- Send error details and stack traces as logs.
- Log `I.executeScript(...)` source as markdown step logs.
- For HTTP request steps (`sendGetRequest`, `sendPostRequest`, etc.), keep only URL in step titles and log payload/headers as markdown.

## License

Apache-2.0 — see [LICENSE](LICENSE).
