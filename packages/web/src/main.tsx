import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPeer, type PeerConnection, type PeerRole } from "./net/peer";
import { createSignalingClient } from "./net/signaling";
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
  const peerRef = useRef<PeerConnection | undefined>(undefined);
  const autoPingSent = useRef(false);
  const connectionStateRef = useRef<RTCPeerConnectionState>("new");

  useEffect(() => {
    const signaling = createSignalingClient();
    const peer = createPeer(role, signaling);
    peerRef.current = peer;

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
      peer.close();
      signaling.close();
      peerRef.current = undefined;
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
        </dl>
        {role === "uploader" && (
          <button
            className="mt-8 rounded-full bg-[var(--mp-olive)] px-5 py-3 text-[var(--mp-cream)] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="ping"
            disabled={connectionState !== "connected"}
            onClick={sendPing}
            type="button"
          >
            Send ping
          </button>
        )}
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
