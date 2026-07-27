import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const roomTarget = positiveInteger(process.env.ROOMS, 50);
const durationMs = positiveInteger(process.env.DURATION_MS, 600_000);
const sampleMs = positiveInteger(process.env.SAMPLE_MS, 10_000);
const messageLimit = positiveInteger(process.env.RATE_LIMIT_MESSAGE, 100);
const wsUrl = process.env.URL ?? "ws://127.0.0.1:3100/ws";
const reportPath = "/tmp/mayo-loadtest.jsonl";
const serverPid = positiveInteger(
  process.env.SERVER_PID ?? process.env.PID,
  process.pid,
);
const socketTarget = roomTarget * 2;
const safePerSocketIntervalMs = Math.max(
  1,
  Math.ceil((socketTarget * 60_000) / messageLimit),
);
const globalSendIntervalMs = Math.max(1, Math.ceil(60_000 / messageLimit));

const errorsByCode = {};
const clients = [];
const pairs = [];
const samples = [];
let fatalError;
let signalTimer;
let sampleTimer;
let lastSentAt = 0;

const noteError = (code, error) => {
  errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
  if (fatalError === undefined) {
    fatalError =
      error === undefined ? `Unexpected error frame: ${code}` : error;
  }
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const readRss = () => {
  try {
    const status = readFileSync(`/proc/${serverPid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (match !== null) {
      return Number(match[1]) * 1024;
    }
  } catch {
    // The fallback keeps the harness useful on non-Linux hosts.
  }
  return process.memoryUsage().rss;
};

const metricValue = (body, name, labels = "") => {
  const escapedLabels = labels.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(
    new RegExp(`^${name}${escapedLabels}\\s+(\\d+(?:\\.\\d+)?)$`, "m"),
  );
  return match === null ? 0 : Number(match[1]);
};

const metricsUrl = () => {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/metrics";
  url.search = "";
  return url;
};

const sample = async (phase) => {
  const url = metricsUrl();
  const headers = {};
  if (process.env.METRICS_TOKEN !== undefined) {
    headers.authorization = `Bearer ${process.env.METRICS_TOKEN}`;
  }
  let metricsBody = "";
  let metricsStatus = 0;
  try {
    const response = await fetch(url, { headers });
    metricsStatus = response.status;
    if (response.ok) {
      metricsBody = await response.text();
    } else {
      noteError("METRICS", `metrics returned HTTP ${response.status}`);
    }
  } catch (error) {
    noteError(
      "METRICS",
      error instanceof Error ? error.message : String(error),
    );
  }
  const entry = {
    ts: Date.now(),
    phase,
    serverPid,
    rss: readRss(),
    metricsStatus,
    roomsActive: metricValue(metricsBody, "mayo_rooms_active"),
    peersConnected: metricValue(metricsBody, "mayo_peers_connected"),
    transfersActive: metricValue(metricsBody, "mayo_transfers_active"),
    roomsCreated: metricValue(metricsBody, "mayo_rooms_created_total"),
    roomsReaped: metricValue(metricsBody, "mayo_rooms_reaped_total"),
  };
  samples.push(entry);
  appendFileSync(reportPath, `${JSON.stringify(entry)}\n`);
  return entry;
};

const createClient = (label) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const controls = [];
    const waiters = [];
    let settled = false;
    const client = {
      label,
      socket,
      nextControl: () => {
        const frame = controls.shift();
        if (frame !== undefined) {
          return Promise.resolve(frame);
        }
        return new Promise((nextResolve, nextReject) => {
          waiters.push({ resolve: nextResolve, reject: nextReject });
        });
      },
    };
    const fail = (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      if (!settled) {
        settled = true;
        reject(new Error(`${label}: ${reason}`));
      }
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(`${label}: ${reason}`));
      }
    };
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        noteError("MALFORMED", `${label}: invalid JSON from server`);
        return;
      }
      if (message.t === "error") {
        const code =
          typeof message.code === "string" ? message.code : "UNKNOWN";
        noteError(code);
        fail(new Error(`${label}: unexpected error frame ${code}`));
        return;
      }
      if (message.t === "signal" && typeof client.onSignal === "function") {
        void client.onSignal(message).catch((error) => fail(error));
        return;
      }
      const waiter = waiters.shift();
      if (waiter === undefined) {
        controls.push(message);
      } else {
        waiter.resolve(message);
      }
    });
    socket.once("open", () => {
      settled = true;
      resolve(client);
    });
    socket.once("error", fail);
    socket.once("close", (code) => {
      if (code !== 1000 && code !== 1001) {
        fail(new Error(`closed with ${code}`));
      }
    });
  });

const send = async (client, message) => {
  const waitMs = Math.max(0, lastSentAt + globalSendIntervalMs - Date.now());
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastSentAt = Date.now();
  client.socket.send(JSON.stringify(message));
};

const setup = async () => {
  for (let index = 0; index < roomTarget; index += 1) {
    const uploader = await createClient(`uploader-${index}`);
    clients.push(uploader);
    await send(uploader, { t: "create" });
    const created = await uploader.nextControl();
    if (created.t !== "created" || typeof created.slug !== "string") {
      throw new Error(`uploader-${index}: create did not return a room`);
    }
    const downloader = await createClient(`downloader-${index}`);
    clients.push(downloader);
    const pair = { uploader, downloader, slug: created.slug };
    pairs.push(pair);
    await send(downloader, { t: "join", slug: created.slug });
    const joined = await downloader.nextControl();
    if (joined.t !== "joined" || typeof joined.peerId !== "string") {
      throw new Error(`downloader-${index}: join did not return a peer`);
    }
    const peerJoined = await uploader.nextControl();
    if (
      peerJoined.t !== "peer-joined" ||
      typeof peerJoined.peerId !== "string"
    ) {
      throw new Error(`uploader-${index}: peer announcement was missing`);
    }
    pair.downloaderPeerId = peerJoined.peerId;
    downloader.onSignal = async (message) => {
      if (typeof message.from === "string") {
        await send(downloader, {
          t: "signal",
          to: message.from,
          payload: { loadtest: true },
        });
      }
    };
  }
};

const startSignals = () => {
  let index = 0;
  signalTimer = setInterval(() => {
    const pair = pairs[index % pairs.length];
    index += 1;
    void send(pair.uploader, {
      t: "signal",
      to: pair.downloaderPeerId,
      payload: { loadtest: true },
    }).catch((error) => noteError("SEND", String(error)));
  }, safePerSocketIntervalMs);
};

const finish = async () => {
  if (signalTimer !== undefined) {
    clearInterval(signalTimer);
  }
  if (sampleTimer !== undefined) {
    clearInterval(sampleTimer);
  }
  for (const client of clients) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.close(1000, "loadtest done");
    }
  }
};

const waitForReap = async () => {
  if (process.env.ROOM_TTL_MS === undefined) {
    return undefined;
  }
  const ttlMs = positiveInteger(process.env.ROOM_TTL_MS, 1_800_000);
  const deadline = Date.now() + ttlMs + 65_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await sample("reap-wait");
    if (latest.roomsActive === 0) {
      return true;
    }
    await sleep(Math.min(sampleMs, Math.max(250, deadline - Date.now())));
  }
  return latest?.roomsActive === 0;
};

const run = async () => {
  writeFileSync(reportPath, "");
  console.log(`Opening ${roomTarget} rooms / ${socketTarget} WebSockets.`);
  console.log(
    `Message pacing: ${safePerSocketIntervalMs}ms per socket cycle ` +
      `(${globalSendIntervalMs}ms global send interval) at RATE_LIMIT_MESSAGE=${messageLimit}.`,
  );
  console.log(`Sampling server PID ${serverPid}; report: ${reportPath}`);
  await setup();
  await sample("warmup");
  startSignals();
  sampleTimer = setInterval(() => {
    void sample("steady");
  }, sampleMs);
  await sleep(durationMs);
  await finish();
  await sleep(250);
  const reaped = await waitForReap();
  const finalSample = await sample("final");
  const warmup = samples.find((entry) => entry.phase === "warmup");
  const first = warmup ?? samples[0];
  const elapsed = finalSample.ts - (first?.ts ?? finalSample.ts);
  const rssSlope =
    first === undefined || elapsed === 0
      ? 0
      : (finalSample.rss - first.rss) / elapsed;
  const rssLimit =
    first === undefined ? Number.POSITIVE_INFINITY : first.rss * 1.5;
  const rssExceeded = finalSample.rss > rssLimit;
  const failed = fatalError !== undefined || reaped === false || rssExceeded;
  console.log(
    JSON.stringify({
      peakRss: Math.max(...samples.map((entry) => entry.rss)),
      finalRss: finalSample.rss,
      rssSlopeBytesPerMs: rssSlope,
      roomsCreated: finalSample.roomsCreated,
      errorsByCode,
      allRoomsReaped: reaped,
      rssStable: !rssExceeded,
      fatalError,
    }),
  );
  process.exitCode = failed ? 1 : 0;
};

try {
  await run();
} catch (error) {
  await finish();
  noteError("HARNESS", error instanceof Error ? error.message : String(error));
  console.log(JSON.stringify({ errorsByCode, fatalError }));
  process.exitCode = 1;
}
