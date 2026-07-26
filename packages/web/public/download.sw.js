const CACHE_NAME = "mayo-download-v1";
void CACHE_NAME;
const DOWNLOAD_PREFIX = "/__mayo-dl/";
const MAX_CREDIT_BYTES = 8 * 1024 * 1024;
const transfers = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const send = (transfer, message) => {
  transfer.source?.postMessage(message);
};

const fail = (transfer, message) => {
  if (transfer.failed) {
    return;
  }
  transfer.failed = true;
  transfer.controller?.error(new Error(message));
  send(transfer, { t: "error", id: transfer.id, message });
};

const safeFilename = (name) =>
  name.replace(/[\\"]/g, "_").replace(/[\r\n]/g, "_");

const closeIfDrained = (transfer) => {
  if (
    !transfer.closeRequested ||
    transfer.closed ||
    transfer.queue.length > 0 ||
    transfer.controller === undefined
  ) {
    return;
  }
  transfer.closed = true;
  transfer.pullResolve?.();
  transfer.pullResolve = undefined;
  transfer.controller.close();
  send(transfer, { t: "closed", id: transfer.id });
  transfers.delete(transfer.id);
};

const drain = (transfer) => {
  const controller = transfer.controller;
  if (controller === undefined) {
    return;
  }
  while (transfer.queue.length > 0 && controller.desiredSize > 0) {
    const chunk = transfer.queue.shift();
    if (chunk === undefined) {
      break;
    }
    transfer.queuedBytes -= chunk.bytes;
    controller.enqueue(new Uint8Array(chunk.buffer));
    transfer.creditBytes += chunk.bytes;
    send(transfer, {
      t: "credit",
      id: transfer.id,
      sequence: chunk.sequence,
      bytes: chunk.bytes,
    });
  }
  closeIfDrained(transfer);
};

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.t === "init") {
    const transfer = {
      id: message.id,
      name: String(message.name),
      totalBytes: Number(message.totalBytes),
      creditBytes: Math.min(MAX_CREDIT_BYTES, Number(message.creditBytes)),
      receivedBytes: 0,
      nextSequence: 0,
      source: event.source,
      controller: undefined,
      pullResolve: undefined,
      queue: [],
      queuedBytes: 0,
      closeRequested: false,
      closed: false,
      failed: false,
    };
    transfers.set(transfer.id, transfer);
    send(transfer, {
      t: "ready",
      id: transfer.id,
      creditBytes: transfer.creditBytes,
    });
    return;
  }
  if (message?.t === "ping") {
    const transfer = transfers.get(message.id);
    if (transfer !== undefined) {
      transfer.source = event.source;
      send(transfer, { t: "pong", id: transfer.id });
    }
    return;
  }

  const transfer = transfers.get(message?.id);
  if (transfer === undefined) {
    return;
  }
  transfer.source = event.source;
  if (message.t === "chunk") {
    const buffer = message.buffer;
    const byteLength = buffer?.byteLength ?? -1;
    if (message.sequence !== transfer.nextSequence) {
      fail(
        transfer,
        "The download service worker received chunks out of order.",
      );
      return;
    }
    if (byteLength < 0 || byteLength > transfer.creditBytes) {
      fail(transfer, "The download service worker credit was exceeded.");
      return;
    }
    if (transfer.receivedBytes + byteLength > transfer.totalBytes) {
      fail(transfer, "The download exceeded the manifest size.");
      return;
    }
    if (transfer.closeRequested) {
      fail(transfer, "The download received a chunk after close.");
      return;
    }
    transfer.creditBytes -= byteLength;
    transfer.receivedBytes += byteLength;
    transfer.nextSequence += 1;
    transfer.queue.push({
      sequence: message.sequence,
      buffer,
      bytes: byteLength,
    });
    transfer.queuedBytes += byteLength;
    transfer.pullResolve?.();
    transfer.pullResolve = undefined;
    return;
  }
  if (message.t === "close") {
    if (transfer.receivedBytes !== transfer.totalBytes) {
      fail(transfer, "The download closed before all bytes arrived.");
      return;
    }
    transfer.closeRequested = true;
    drain(transfer);
    return;
  }
  if (message.t === "cancel") {
    fail(transfer, String(message.reason));
    transfers.delete(transfer.id);
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    !url.pathname.startsWith(DOWNLOAD_PREFIX) ||
    url.pathname.length === DOWNLOAD_PREFIX.length ||
    url.pathname.slice(DOWNLOAD_PREFIX.length).includes("/")
  ) {
    return;
  }
  const id = decodeURIComponent(url.pathname.slice(DOWNLOAD_PREFIX.length));
  const transfer = transfers.get(id);
  if (transfer === undefined) {
    event.respondWith(new Response("Not found", { status: 404 }));
    return;
  }
  const stream = new ReadableStream({
    start(controller) {
      transfer.controller = controller;
      drain(transfer);
    },
    pull() {
      if (transfer.closed) {
        return Promise.resolve();
      }
      if (transfer.queue.length > 0 || transfer.closeRequested) {
        drain(transfer);
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        transfer.pullResolve = () => {
          resolve();
          drain(transfer);
        };
      });
    },
    cancel(reason) {
      fail(transfer, String(reason ?? "The download was cancelled."));
      transfers.delete(transfer.id);
    },
  });
  event.respondWith(
    new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFilename(transfer.name)}"`,
        "Content-Length": String(transfer.totalBytes),
      },
    }),
  );
});
