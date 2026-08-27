# Browser telemetry client

The browser entrypoint provides a framework-neutral imperative client without exposing Effect types.

```ts
import { createBrowserTelemetryClient } from "@equipe-tech/observability/browser/client";

const telemetry = createBrowserTelemetryClient({
  endpoint: "/_telemetry/events",
  maxBatchSize: 32,
  maxQueueSize: 256,
  flushIntervalMs: 5_000,
});

telemetry.emit("checkout.completed", { "page.path": "/checkout" });
await telemetry.flush();
await telemetry.dispose();
```

`emit` and `pending` are synchronous. `flush` and `dispose` return Promises. Concurrent flushes share one delivery operation. A rejected delivery keeps the same sanitized batch queued for a later flush. Disposal clears the client-owned interval, waits for active delivery, flushes remaining events, and is idempotent. A disposed client ignores new events and explicit flushes. A failed final delivery rejects disposal and remains visible through `pending`.

Set `disabled: true` when browser telemetry is off. A disabled client creates no interval, calls no transport, ignores events, reports zero pending events, and resolves flush and disposal.

## React startup and cleanup

Create one client alongside the React root, pass it through context, and dispose it from the owner that unmounts that root. Do not create or dispose clients during rendering. Keeping disposal at the root owner also avoids React development Strict Mode's simulated effect cleanup from terminating a live singleton.

```tsx
import { createContext } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserTelemetryClient } from "@equipe-tech/observability/browser/client";
import { App } from "./App.tsx";

export const BrowserTelemetryContext = createContext(
  createBrowserTelemetryClient({ disabled: true }),
);

export function startReactApp(container: HTMLElement) {
  const telemetry = createBrowserTelemetryClient();
  const root = createRoot(container);
  root.render(
    <BrowserTelemetryContext.Provider value={telemetry}>
      <App />
    </BrowserTelemetryContext.Provider>,
  );

  return async () => {
    root.unmount();
    await telemetry.dispose();
  };
}
```

Call the returned cleanup when the application root is permanently stopped. Repeated cleanup remains safe because disposal is idempotent.
