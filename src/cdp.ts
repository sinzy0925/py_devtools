import WebSocket from "ws";

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export class CdpSession {
  private ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  private readonly timeoutMs: number;

  private constructor(ws: WebSocket, timeoutMs: number) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.ws.on("message", (data) => {
      let msg: { id?: number; result?: Record<string, unknown>; error?: unknown };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.id == null) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new CdpError(JSON.stringify(msg.error)));
        return;
      }
      pending.resolve(msg.result ?? {});
    });
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new CdpError(`CDP websocket connect timeout: ${wsUrl}`));
      }, timeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws, timeoutMs));
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  call(method: string, params?: Record<string, JsonValue>): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`timeout waiting for ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}

async function httpJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) {
    throw new CdpError(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

export async function cdpBrowserWsUrl(host: string, port: string): Promise<string> {
  const info = (await httpJson(`http://${host}:${port}/json/version`)) as {
    webSocketDebuggerUrl?: string;
  };
  if (!info.webSocketDebuggerUrl) {
    throw new CdpError("webSocketDebuggerUrl missing from /json/version");
  }
  return info.webSocketDebuggerUrl;
}

export async function cdpPageWsUrl(host: string, port: string): Promise<string> {
  const targets = (await httpJson(`http://${host}:${port}/json/list`)) as Array<{
    type?: string;
    webSocketDebuggerUrl?: string;
  }>;
  for (const t of targets) {
    if (t.type === "page" && t.webSocketDebuggerUrl) {
      return t.webSocketDebuggerUrl;
    }
  }
  try {
    const created = (await httpJson(`http://${host}:${port}/json/new?about:blank`)) as {
      webSocketDebuggerUrl?: string;
    };
    if (created.webSocketDebuggerUrl) {
      return created.webSocketDebuggerUrl;
    }
  } catch {
    // fall through
  }
  throw new CdpError("no page target available for download");
}

export async function configureChromeDownloads(
  host: string,
  port: string,
  downloadDir: string,
): Promise<void> {
  const browser = await CdpSession.connect(await cdpBrowserWsUrl(host, port));
  try {
    await browser.call("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
  } finally {
    browser.close();
  }

  const page = await CdpSession.connect(await cdpPageWsUrl(host, port));
  try {
    try {
      await page.call("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
      });
    } catch {
      // Page.setDownloadBehavior is deprecated / may fail on some builds.
    }
  } finally {
    page.close();
  }
}

export async function downloadTextViaChrome(
  host: string,
  port: string,
  text: string,
  filename: string,
): Promise<string> {
  const session = await CdpSession.connect(await cdpPageWsUrl(host, port), 15_000);
  try {
    await session.call("Runtime.enable");
    const expression = `
      (() => {
        const text = ${JSON.stringify(text)};
        const filename = ${JSON.stringify(filename)};
        const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return filename;
      })()
    `;
    const result = await session.call("Runtime.evaluate", {
      expression,
      awaitPromise: false,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new CdpError(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    const value = (result.result as { value?: string } | undefined)?.value;
    return value || filename;
  } finally {
    session.close();
  }
}
