import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPeer, type PeerConnection, type PeerRole } from "./net/peer";
import { createSignalingClient } from "./net/signaling";
import {
  createTransferController,
  type TransferManifestInfo,
  type TransferProgress,
  type TransferResult,
} from "./net/transfer";
import { getSinkOverride, getSinkStrategy } from "./sink";
import "./styles.css";

interface RoomViewProps {
  role: PeerRole;
  slug?: string;
}

const RoomView = ({ role, slug }: RoomViewProps) => {
  const [roomSlug, setRoomSlug] = useState(slug);
  const [connectionState, setConnectionState] =
    useState<RTCPeerConnectionState>("new");
  const [iceConnectionState, setIceConnectionState] =
    useState<RTCIceConnectionState>("new");
  const [lastPong, setLastPong] = useState("—");
  const [log, setLog] = useState("Starting signaling…");
  const [transferProgress, setTransferProgress] = useState<
    TransferProgress | undefined
  >(undefined);
  const [transferResult, setTransferResult] = useState<
    TransferResult | undefined
  >(undefined);
  const [pendingManifest, setPendingManifest] = useState<
    TransferManifestInfo | undefined
  >(undefined);
  const [bufferedAmount, setBufferedAmount] = useState(0);
  const [maxBufferedAmount, setMaxBufferedAmount] = useState(0);
  const peerRef = useRef<PeerConnection | undefined>(undefined);
  const transferRef = useRef<
    ReturnType<typeof createTransferController> | undefined
  >(undefined);
  const autoPingSent = useRef(false);
  const connectionStateRef = useRef<RTCPeerConnectionState>("new");

  useEffect(() => {
    const signaling = createSignalingClient();
    const peer = createPeer(role, signaling);
    const transfer = createTransferController(role, peer, {
      onProgress: (progress) => setTransferProgress(progress),
      onManifest: (manifest) => {
        setPendingManifest(manifest);
        const override = getSinkOverride();
        if (override !== undefined && override.autoAccept !== false) {
          transferRef.current?.acceptTransfer();
        }
      },
      onResult: (result) => {
        setPendingManifest(undefined);
        setTransferResult(result);
        setLog(
          result.verified
            ? "Transfer verified."
            : "Transfer failed integrity verification.",
        );
      },
      onError: (error) => setLog(error.message),
      onCancelled: (reason) => setLog(reason),
      onBufferedAmount: (amount, max) => {
        setBufferedAmount(amount);
        setMaxBufferedAmount(max);
      },
    });
    peerRef.current = peer;
    transferRef.current = transfer;

    const sendAutoPing = (): void => {
      if (
        role === "uploader" &&
        connectionStateRef.current === "connected" &&
        !autoPingSent.current
      ) {
        try {
          peer.sendPing();
          autoPingSent.current = true;
          setLog("Ping sent.");
        } catch {
          // The ctrl channel can open just after the peer connection state.
        }
      }
    };

    const unsubscribeConnection = peer.connectionState.subscribe((state) => {
      connectionStateRef.current = state;
      setConnectionState(state);
      if (state === "connected") {
        setLog("Peer connection connected.");
      }
    });
    const unsubscribeIce = peer.iceConnectionState.subscribe(
      setIceConnectionState,
    );
    const unsubscribeCtrl = peer.on("ctrl-open", () => {
      setLog("Ctrl channel open.");
      sendAutoPing();
    });
    const unsubscribePong = peer.on("pong", ({ nonce }) => {
      setLastPong(nonce);
      setLog("Pong received.");
    });
    const unsubscribeError = peer.on("error", ({ error }) => {
      setLog(error.message);
    });

    const run = async (): Promise<void> => {
      try {
        if (role === "uploader") {
          const created = await signaling.create();
          setRoomSlug(created.slug);
          setLog("Room created. Waiting for a receiver…");
        } else if (slug !== undefined) {
          await signaling.join(slug);
          setLog("Joined room. Waiting for the sender…");
        }
        await peer.ready;
      } catch (error) {
        setLog(error instanceof Error ? error.message : "Connection failed.");
      }
    };
    void run();

    return () => {
      unsubscribeConnection();
      unsubscribeIce();
      unsubscribeCtrl();
      unsubscribePong();
      unsubscribeError();
      transfer.destroy();
      peer.close();
      signaling.close();
      peerRef.current = undefined;
      transferRef.current = undefined;
    };
  }, [role, slug]);

  const sendPing = (): void => {
    const peer = peerRef.current;
    if (peer === undefined) {
      return;
    }
    try {
      peer.sendPing();
      setLog("Ping sent.");
    } catch (error) {
      setLog(
        error instanceof Error
          ? error.message
          : "The ctrl channel is not open.",
      );
    }
  };

  const acceptTransfer = (): void => {
    transferRef.current?.acceptTransfer();
    setPendingManifest(undefined);
  };

  const rejectTransfer = (): void => {
    transferRef.current?.rejectTransfer();
    setPendingManifest(undefined);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    if (file === undefined || transferRef.current === undefined) {
      return;
    }
    setTransferResult(undefined);
    void transferRef.current.startSend(file).catch((error: unknown) => {
      setLog(
        error instanceof Error ? error.message : "Could not start transfer.",
      );
    });
  };

  const progressText =
    transferProgress === undefined
      ? "—"
      : `${transferProgress.bytesDone}/${transferProgress.totalBytes} bytes · ${Math.round(transferProgress.bytesPerSec)} B/s`;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section className="w-full max-w-xl rounded-3xl border border-[var(--mp-olive)]/20 bg-white/50 p-8 shadow-sm">
        <p className="text-sm uppercase tracking-[0.3em] opacity-60">
          mayo.pizza
        </p>
        <h1
          className="mt-3 text-4xl"
          style={{ fontFamily: "var(--mp-font-display)" }}
        >
          {role === "uploader" ? "Send a slice" : "Receive a slice"}
        </h1>
        {roomSlug !== undefined && (
          <p className="mt-4 text-lg">
            Room: <span data-testid="slug">{roomSlug}</span>
          </p>
        )}
        <dl className="mt-8 grid gap-3 text-sm">
          <div className="flex justify-between gap-4 border-b border-[var(--mp-olive)]/10 pb-2">
            <dt>Connection</dt>
            <dd data-testid="connection-state">{connectionState}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-[var(--mp-olive)]/10 pb-2">
            <dt>ICE</dt>
            <dd>{iceConnectionState}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-[var(--mp-olive)]/10 pb-2">
            <dt>Last pong</dt>
            <dd data-testid="last-pong">{lastPong}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-[var(--mp-olive)]/10 pb-2">
            <dt>Transfer</dt>
            <dd data-testid="progress">{progressText}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-[var(--mp-olive)]/10 pb-2">
            <dt>Buffered</dt>
            <dd data-testid="buffered-amount">{bufferedAmount}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-[var(--mp-olive)]/10 pb-2">
            <dt>Sink</dt>
            <dd data-testid="sink-strategy">{getSinkStrategy()}</dd>
          </div>
        </dl>
        {role === "downloader" && pendingManifest !== undefined && (
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              className="rounded-full bg-[var(--mp-olive)] px-5 py-3 text-[var(--mp-cream)]"
              data-testid="accept-transfer"
              onClick={acceptTransfer}
              type="button"
            >
              Save {pendingManifest.suggestedName}
            </button>
            <button
              className="rounded-full border border-[var(--mp-olive)] px-5 py-3"
              data-testid="reject-transfer"
              onClick={rejectTransfer}
              type="button"
            >
              Reject
            </button>
          </div>
        )}
        {role === "uploader" && (
          <div className="mt-8 flex flex-wrap gap-3">
            <button
              className="rounded-full bg-[var(--mp-olive)] px-5 py-3 text-[var(--mp-cream)] disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="ping"
              disabled={connectionState !== "connected"}
              onClick={sendPing}
              type="button"
            >
              Send ping
            </button>
            <label className="cursor-pointer rounded-full border border-[var(--mp-olive)] px-5 py-3">
              Choose file
              <input
                className="sr-only"
                data-testid="file-input"
                onChange={handleFileChange}
                type="file"
              />
            </label>
          </div>
        )}
        <p data-testid="transfer-result" className="mt-4 break-all text-sm">
          {transferResult === undefined
            ? "Transfer result: pending"
            : `Transfer result: verified=${transferResult.verified} sha256=${transferResult.sha256}`}
        </p>
        <p className="mt-2 text-xs opacity-60">
          Peak buffered: {maxBufferedAmount} bytes
        </p>
        <p data-testid="log" className="mt-6 text-sm opacity-70">
          {log}
        </p>
      </section>
    </main>
  );
};

const getRoute = (): RoomViewProps => {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
  if (path === "") {
    return { role: "uploader" };
  }
  try {
    return { role: "downloader", slug: decodeURIComponent(path) };
  } catch {
    return { role: "downloader", slug: path };
  }
};

const App = () => <RoomView {...getRoute()} />;

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The application root is missing.");
}

createRoot(rootElement).render(<App />);
