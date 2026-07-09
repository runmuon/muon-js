# Muon Node SDK

**Throw-safe product analytics for Node.js services, workers and CLIs.**

`@runmuon/node` sends events to Muon without adding runtime dependencies or
letting analytics failures break the host process. It buffers events, persists
them to disk, retries failed flushes and can capture distilled process errors.

## Install

```bash
npm install @runmuon/node
```

## Usage

```ts
import * as muon from "@runmuon/node";

muon.init("YOUR_PROJECT_ID", "https://analytics.example.com", {
  captureErrors: true,
  release: process.env.GIT_SHA,
});

muon.pageView("/pricing", "Pricing");
muon.track("signup_completed", { plan: "pro" });
muon.identify("user_123");

await muon.shutdown();
```

## Why Use It

- **Never throws into your app.** Every public method is wrapped; returned
  promises resolve even when analytics is misconfigured or offline.
- **Keeps events through outages.** The queue is persisted to disk and retried
  later, capped so a long outage cannot grow without bound.
- **Works in real Node processes.** Flush by count, interval or shutdown; request
  timeouts and retry backoff are built in.
- **Captures useful failures, not secrets.** Error reporting sends distilled
  type/message context, release and page/service hints, not full stack traces.
- **Zero runtime dependencies.** The published package ships compiled ESM/CJS
  output and TypeScript types.

## API

```ts
muon.init(projectId, host, options);
muon.track(name, properties);
muon.pageView(path, title);
muon.identify(distinctId);
muon.setRelease(version);
muon.captureError(error, page);
await muon.flush();
await muon.shutdown();
```

## Options

| Option | Default | Description |
| --- | ---: | --- |
| `flushAt` | `20` | Flush after this many buffered events. |
| `flushInterval` | `15000` | Flush interval in milliseconds. |
| `maxQueueEvents` | `10000` | Hard cap; oldest queued events are dropped past it. |
| `requestTimeout` | `10000` | Per-request timeout in milliseconds. |
| `captureErrors` | `false` | Install uncaught-exception and rejection hooks. |
| `release` | auto | Release/version attached to events. |
| `disabled` | `false` | Make the SDK inert. |
| `debug` | `false` | Emit one warning per misconfiguration. |
| `queueDir` | `~/.muon` | Persistent queue directory. |
| `maxErrorsPerRun` | `100` | Error-event flood cap. |
| `maxDuplicateErrors` | `5` | Duplicate type/message cap. |

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
```

## License

MIT.
