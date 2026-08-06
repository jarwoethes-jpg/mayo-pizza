import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  collectDroppedFolder,
  type FolderCollection,
  mapInputFiles,
} from "./folder/entries";
import { createPeer, type PeerConnection, type PeerRole } from "./net/peer";
import {
  classifySelectedRoute,
  readSelectedRouteStats,
  type SelectedRoute,
  type SelectedRouteStats,
} from "./net/route";
import { createSignalingClient, type SignalingError } from "./net/signaling";
import {
  createTransferController,
  type TransferManifestInfo,
  type TransferProgress,
  type TransferResult,
} from "./net/transfer";
import {
  canSilentlyRemintRoom,
  resolveRoomHeartbeatInterval,
  startRoomHeartbeat,
} from "./roomLifecycle";
import { getSinkOverride, getSinkStrategy } from "./sink";
import { getFailureCopy } from "./ui/copy";
import { formatBytes, formatEta, formatTransferRate } from "./ui/format";
import { DONATE_URL, PrivacyPage } from "./ui/legal";
import {
  getPasswordPromptCopy,
  type PasswordPromptState,
  passwordPromptReducer,
} from "./ui/password";
import { makeRoomShareUrl, normalizeRoomPassword } from "./ui/room";
import { initialTransferUiState, transferUiReducer } from "./ui/state";
import { TermsPage } from "./ui/terms";
import "./styles.css";

interface RoomViewProps {
  role: PeerRole;
  slug?: string;
}

type SessionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "resuming"
  | "failed";

interface StagedSelection {
  kind: "file" | "folder";
  name: string;
  size: number;
  fileCount?: number;
}

const getSessionCopy = (
  status: SessionStatus,
  role: PeerRole,
  reason?: string,
): string => {
  if (status === "failed") {
    return getFailureCopy(reason ?? "connection failed", role).message;
  }
  if (status === "connecting") {
    return role === "uploader"
      ? "We’re warming up the oven and getting your private room ready."
      : "We’re finding the room and getting your private connection ready.";
  }
  if (status === "reconnecting") {
    return "Slice dropped! Our connection got a little messy. We’re getting a fresh one ready, but in the meantime, check your Wi-Fi!";
  }
  if (status === "resuming") {
    return "The connection is back. We’re stitching your slice back together now.";
  }
  return role === "uploader"
    ? "Your room is ready. Drop a file anywhere or choose a slice to send it straight to your receiver."
    : "You’re in. We’re waiting for the sender to drop a slice.";
};

const getTechnicalShareUrl = (slug: string): string =>
  makeRoomShareUrl(window.location.origin, slug);

const formatSelectedRoute = (
  route: SelectedRoute | undefined,
  relayProtocol: "udp" | "tcp" | undefined,
): string => {
  if (route === undefined) {
    return "—";
  }
  return route === "relay" && relayProtocol !== undefined
    ? `${route} (${relayProtocol})`
    : route;
};

const formatRoundTripTime = (seconds: number | undefined): string =>
  seconds === undefined ? "—" : `${Math.round(seconds * 1000)} ms`;

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const addQrAccessibility = (svg: string, url: string): string =>
  svg.replace(
    "<svg",
    `<svg role="img" aria-label="QR code for ${escapeAttribute(url)}"`,
  );

const RoomView = ({ role, slug }: RoomViewProps) => {
  const [roomSlug, setRoomSlug] = useState(slug);
  const [roomPassword, setRoomPassword] = useState<string | undefined>(
    undefined,
  );
  const [roomGeneration, setRoomGeneration] = useState(0);
  const [passwordAttempt, setPasswordAttempt] = useState<string | undefined>(
    undefined,
  );
  const [passwordPromptState, setPasswordPromptState] = useState<
    PasswordPromptState | undefined
  >(undefined);
  const [selectedRoute, setSelectedRoute] = useState<SelectedRoute | undefined>(
    undefined,
  );
  const [selectedRouteStats, setSelectedRouteStats] = useState<
    SelectedRouteStats | undefined
  >(undefined);
  const [observedRate, setObservedRate] = useState<number | undefined>(
    undefined,
  );
  const [connectionState, setConnectionState] =
    useState<RTCPeerConnectionState>("new");
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("connecting");
  const [iceConnectionState, setIceConnectionState] =
    useState<RTCIceConnectionState>("new");
  const [lastPong, setLastPong] = useState("—");
  const [log, setLog] = useState("Starting signaling…");
  const [transferProgress, setTransferProgress] = useState<
    TransferProgress | undefined
  >(undefined);
  const [sinkStall, setSinkStall] = useState<
    { stalled: boolean; sinceMs: number } | undefined
  >(undefined);
  const [transferResult, setTransferResult] = useState<
    TransferResult | undefined
  >(undefined);
  const [pendingManifest, setPendingManifest] = useState<
    TransferManifestInfo | undefined
  >(undefined);
  const [skippedCount, setSkippedCount] = useState<number | undefined>(
    undefined,
  );
  const [bufferedAmount, setBufferedAmount] = useState(0);
  const [maxBufferedAmount, setMaxBufferedAmount] = useState(0);
  const [transferUi, dispatchTransferUi] = useReducer(
    transferUiReducer,
    initialTransferUiState,
  );
  const [stagedSelection, setStagedSelection] = useState<
    StagedSelection | undefined
  >(undefined);
  const [sessionFailureReason, setSessionFailureReason] = useState<
    string | undefined
  >(undefined);
  const [sessionNotice, setSessionNotice] = useState<string | undefined>(
    undefined,
  );
  const [announcement, setAnnouncement] = useState(
    "Welcome in. Drop a file anywhere or choose a slice to get started.",
  );
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [qrSvg, setQrSvg] = useState<string | undefined>(undefined);
  const [qrLoading, setQrLoading] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const peerRef = useRef<PeerConnection | undefined>(undefined);
  const transferRef = useRef<
    ReturnType<typeof createTransferController> | undefined
  >(undefined);
  const autoPingSent = useRef(false);
  const connectionStateRef = useRef<RTCPeerConnectionState>("new");
  const resumePendingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const progressAnnouncedRef = useRef(false);
  const routeStatSentRef = useRef(false);
  const stagedSelectionRef = useRef(stagedSelection);
  const transferPhaseRef = useRef(transferUi.phase);
  const peerAttachedRef = useRef(false);
  const automaticRoomRemintCountRef = useRef(0);
  const silentRoomRemintPendingRef = useRef(false);
  stagedSelectionRef.current = stagedSelection;
  transferPhaseRef.current = transferUi.phase;

  // WHY: roomGeneration is an explicit lifecycle reset after an invisible room expiry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: roomGeneration intentionally restarts the room lifecycle.
  useEffect(() => {
    routeStatSentRef.current = false;
    connectionStateRef.current = "new";
    peerAttachedRef.current = false;
    silentRoomRemintPendingRef.current = false;
    setSelectedRoute(undefined);
    setSelectedRouteStats(undefined);
    setObservedRate(undefined);
    let active = true;
    let stopRoomHeartbeat = (): void => {};
    let stopStatsSampling = (): void => {};
    const signaling = createSignalingClient();
    const peer = createPeer(role, signaling);
    const transfer = createTransferController(role, peer, {
      onProgress: (progress) => {
        setTransferProgress(progress);
        dispatchTransferUi({ type: "progress" });
        if (progress.bytesDone >= progress.totalBytes) {
          progressAnnouncedRef.current = true;
          setAnnouncement("The slice made it. We’re checking every crumb now.");
        } else if (!progressAnnouncedRef.current) {
          progressAnnouncedRef.current = true;
          setAnnouncement(
            "Your slice is on the move. Keep this tab open while it travels.",
          );
        }
        if (resumePendingRef.current && progress.side === "receiver") {
          resumePendingRef.current = false;
          setSessionStatus("connected");
          setSessionNotice(undefined);
        }
      },
      onSinkStall: (stall) => {
        setSinkStall(stall);
        if (stall?.stalled) {
          setAnnouncement("Waiting for your browser's download to continue…");
          setLog("Download paused while the browser accepts data.");
        }
      },
      onManifest: (manifest) => {
        setPendingManifest(manifest);
        setSessionNotice(undefined);
        setAnnouncement(
          "A fresh slice just landed. Take a look, then grab it when you’re ready.",
        );
        const override = getSinkOverride();
        if (override !== undefined && override.autoAccept !== false) {
          transferRef.current?.acceptTransfer();
        }
      },
      onResult: (result) => {
        setPendingManifest(undefined);
        setTransferResult(result);
        dispatchTransferUi({ type: "result", result });
        if (result.verified) {
          setAnnouncement("Slice landed! It’s verified and ready to enjoy.");
          setLog("Transfer verified.");
        } else {
          setAnnouncement(
            "Slice dropped! The bytes did not line up on the way over. Try that slice again.",
          );
          setLog("Transfer failed integrity verification.");
        }
      },
      onResumeRequested: () => {
        resumePendingRef.current = true;
        setSessionStatus("resuming");
        setSessionNotice(undefined);
        setAnnouncement(
          "The connection is back. We’re stitching your slice back together now.",
        );
        setLog("Connection’s back. Resuming your slice…");
      },
      onError: (error) => {
        if (silentRoomRemintPendingRef.current) {
          return;
        }
        resumePendingRef.current = false;
        setSessionStatus("failed");
        setSessionFailureReason(error.message);
        dispatchTransferUi({ type: "error", message: error.message });
        setAnnouncement(getFailureCopy(error.message, role).message);
        setLog(error.message);
      },
      onCancelled: (reason) => {
        dispatchTransferUi({ type: "cancel" });
        setAnnouncement(getFailureCopy(reason, role).message);
        setLog(reason);
      },
      onBufferedAmount: (amount, max) => {
        setBufferedAmount(amount);
        setMaxBufferedAmount(max);
      },
    });
    peerRef.current = peer;
    transferRef.current = transfer;
    const startStatsSampling = (): void => {
      stopStatsSampling();
      let sampling = true;
      let recentSamples: Array<{ at: number; bytes: number }> = [];

      const sample = async (): Promise<void> => {
        try {
          const stats = await peer.getStats();
          if (!active || !sampling) {
            return;
          }
          const routeStats = readSelectedRouteStats(stats);
          setSelectedRouteStats(routeStats);
          if (routeStats.route !== undefined) {
            setSelectedRoute(routeStats.route);
          }
          const byteCounters = [
            routeStats.bytesSent,
            routeStats.bytesReceived,
          ].filter((bytes): bytes is number => bytes !== undefined);
          if (byteCounters.length === 0) {
            return;
          }
          const currentSample = {
            at: routeStats.timestamp ?? Date.now(),
            bytes: byteCounters.reduce((total, bytes) => total + bytes, 0),
          };
          const newestSample = recentSamples.at(-1);
          if (
            newestSample !== undefined &&
            currentSample.bytes < newestSample.bytes
          ) {
            recentSamples = [currentSample];
            setObservedRate(undefined);
            return;
          }
          recentSamples.push(currentSample);
          if (recentSamples.length > 4) {
            recentSamples.shift();
          }
          if (recentSamples.length < 2) {
            return;
          }
          const oldestSample = recentSamples[0];
          if (oldestSample === undefined) {
            return;
          }
          const elapsedSeconds = (currentSample.at - oldestSample.at) / 1000;
          const byteDelta = currentSample.bytes - oldestSample.bytes;
          if (byteDelta >= 0 && elapsedSeconds > 0) {
            setObservedRate(byteDelta / elapsedSeconds);
          }
        } catch {
          // Stats sampling is deliberately best-effort and never gates a transfer.
        }
      };

      void sample();
      const timer = window.setInterval(() => {
        void sample();
      }, 1000);
      stopStatsSampling = () => {
        sampling = false;
        window.clearInterval(timer);
      };
    };
    const unsubscribePeerJoined = signaling.on("peer-joined", () => {
      peerAttachedRef.current = true;
    });
    const unsubscribePeerLeft = signaling.on("peer-left", () => {
      peerAttachedRef.current = false;
    });

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
        if (!resumePendingRef.current) {
          setSessionStatus("connected");
          setSessionNotice(undefined);
        }
        setLog("Connected.");
      } else if (state === "new" || state === "connecting") {
        setSessionStatus("connecting");
      } else if (state === "disconnected" || state === "failed") {
        stopStatsSampling();
        setSessionStatus("reconnecting");
        setAnnouncement(
          "Slice dropped! Our connection got a little messy. We’re getting a fresh one ready, but in the meantime, check your Wi-Fi!",
        );
      }
    });
    const unsubscribeIce = peer.iceConnectionState.subscribe(
      setIceConnectionState,
    );
    const unsubscribeCtrl = peer.on("ctrl-open", () => {
      setLog("Ctrl channel open.");
      sendAutoPing();
    });
    const unsubscribeData = peer.on("data-open", () => {
      startStatsSampling();
      if (role !== "downloader" || routeStatSentRef.current) {
        return;
      }
      routeStatSentRef.current = true;
      void peer
        .getStats()
        .then((stats) => classifySelectedRoute(stats))
        .then((route) => {
          if (route === undefined) {
            return;
          }
          setSelectedRoute(route);
          return signaling.send({ t: "stat", event: "connected", route });
        })
        .catch(() => {
          // Route telemetry is deliberately best-effort and never gates a transfer.
        });
    });
    const unsubscribeReconnecting = peer.on("reconnecting", () => {
      setSessionStatus("reconnecting");
      setSessionNotice(undefined);
      setAnnouncement(
        "Slice dropped! Our connection got a little messy. We’re getting a fresh one ready, but in the meantime, check your Wi-Fi!",
      );
      setLog("Our connection hit a rough patch. Reconnecting…");
    });
    const unsubscribeResuming = peer.on("resuming", () => {
      resumePendingRef.current = true;
      setSessionStatus("resuming");
      setSessionNotice(undefined);
      setAnnouncement(
        "The connection is back. We’re stitching your slice back together now.",
      );
      setLog("Connection’s back. Resuming your slice…");
    });
    const unsubscribeExhausted = peer.on("exhausted", ({ error }) => {
      if (silentRoomRemintPendingRef.current) {
        return;
      }
      resumePendingRef.current = false;
      setSessionStatus("failed");
      const reason = error?.message ?? "connection recovery exhausted";
      setSessionFailureReason(reason);
      dispatchTransferUi({ type: "error", message: reason });
      setAnnouncement(getFailureCopy(reason, role).message);
      setLog("Slice dropped. We couldn’t recover the connection.");
    });
    const unsubscribePeerGone = peer.on("peer-gone", () => {
      const message =
        role === "downloader"
          ? "Slice is waiting! The sender stepped away before the handoff finished. Ask them to open the room again for a fresh slice."
          : "Slice is waiting! The receiver stepped away before the handoff finished. We’ll be ready when they return.";
      setSessionNotice(message);
      setAnnouncement(message);
      setLog(
        role === "downloader"
          ? "Sender left the room."
          : "Receiver left the room.",
      );
    });
    const unsubscribePong = peer.on("pong", ({ nonce }) => {
      setLastPong(nonce);
      setLog("Pong received.");
    });
    const handleExpiredRoom = (): boolean => {
      if (silentRoomRemintPendingRef.current) {
        return true;
      }
      const transferInProgress =
        transferPhaseRef.current === "staged" ||
        transferPhaseRef.current === "transferring";
      const canRemint = canSilentlyRemintRoom(
        role,
        stagedSelectionRef.current !== undefined,
        peerAttachedRef.current || connectionStateRef.current === "connected",
        transferInProgress,
        automaticRoomRemintCountRef.current,
      );
      if (!canRemint) {
        return false;
      }
      automaticRoomRemintCountRef.current += 1;
      setSessionStatus("connecting");
      setSessionFailureReason(undefined);
      setSessionNotice(undefined);
      setAnnouncement(getSessionCopy("connecting", role));
      setLog("Starting signaling…");
      silentRoomRemintPendingRef.current = true;
      setRoomGeneration((generation) => generation + 1);
      return true;
    };
    const unsubscribeError = peer.on("error", ({ error }) => {
      if (error.message.startsWith("BAD_SLUG:")) {
        if (handleExpiredRoom()) {
          return;
        }
        setSessionStatus("failed");
        setSessionFailureReason(error.message);
        setAnnouncement(getFailureCopy(error.message, role).message);
      }
      setLog(error.message);
    });

    const debugDrop = (): void => peer.debugDrop();
    // The preview server is a production build, so the explicit init-script
    // marker keeps this deterministic e2e hook out of normal deployments.
    if (import.meta.env.DEV || window.__MAYO_E2E__ === true) {
      window.__MAYO_DEBUG_DROP__ = debugDrop;
    }

    const run = async (): Promise<void> => {
      try {
        const heartbeatInterval = resolveRoomHeartbeatInterval(
          window.__MAYO_HEARTBEAT_INTERVAL_MS__,
        );
        const authenticationPassword =
          role === "uploader" ? roomPassword : passwordAttempt;
        if (role === "uploader") {
          const created = await signaling.create(authenticationPassword);
          setRoomSlug(created.slug);
          setLog("Room created. Waiting for a receiver…");
          if (active) {
            stopRoomHeartbeat = startRoomHeartbeat(
              () => signaling.isOpen,
              async () => {
                await signaling.requestIceConfig();
              },
              undefined,
              undefined,
              heartbeatInterval,
            );
          }
        } else if (slug !== undefined) {
          await signaling.join(slug, authenticationPassword);
          setPasswordPromptState(undefined);
          setLog("Joined room. Waiting for the sender…");
        }
        await peer.ready;
      } catch (error) {
        const signalingError = error as Partial<SignalingError>;
        if (
          role === "downloader" &&
          (signalingError.code === "PASSWORD_REQUIRED" ||
            signalingError.code === "BAD_PASSWORD" ||
            signalingError.code === "ROOM_LOCKED")
        ) {
          const passwordLocked =
            signalingError.code === "ROOM_LOCKED" ||
            (signalingError.code === "BAD_PASSWORD" &&
              signalingError.attemptsRemaining === 0);
          const nextState = passwordPromptReducer(
            undefined,
            signalingError.code === "PASSWORD_REQUIRED"
              ? { type: "required" }
              : passwordLocked
                ? { type: "locked" }
                : {
                    type: "wrong",
                    ...(signalingError.attemptsRemaining === undefined
                      ? {}
                      : {
                          attemptsRemaining: signalingError.attemptsRemaining,
                        }),
                  },
          );
          setPasswordPromptState(nextState);
          const copy = getPasswordPromptCopy(nextState);
          setAnnouncement(copy.message);
          setLog(error instanceof Error ? error.message : copy.message);
          return;
        }
        setSessionStatus("failed");
        const message =
          error instanceof Error ? error.message : "Connection failed.";
        setSessionFailureReason(message);
        setAnnouncement(getFailureCopy(message, role).message);
        setLog(message);
      }
    };
    void run();

    return () => {
      active = false;
      stopRoomHeartbeat();
      stopStatsSampling();
      unsubscribeConnection();
      unsubscribeIce();
      unsubscribeCtrl();
      unsubscribeData();
      unsubscribeReconnecting();
      unsubscribeResuming();
      unsubscribeExhausted();
      unsubscribePeerGone();
      unsubscribePong();
      unsubscribeError();
      unsubscribePeerJoined();
      unsubscribePeerLeft();
      if (window.__MAYO_DEBUG_DROP__ === debugDrop) {
        delete window.__MAYO_DEBUG_DROP__;
      }
      transfer.destroy();
      peer.close();
      signaling.close();
      peerRef.current = undefined;
      transferRef.current = undefined;
    };
  }, [passwordAttempt, role, roomGeneration, roomPassword, slug]);

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

  const resetTransferPresentation = (): void => {
    setTransferProgress(undefined);
    setSinkStall(undefined);
    setTransferResult(undefined);
    dispatchTransferUi({ type: "reset" });
    progressAnnouncedRef.current = false;
  };

  const acceptTransfer = (): void => {
    // This must stay the first call in the click handler: FSA needs the original gesture.
    transferRef.current?.acceptTransfer();
    setPendingManifest(undefined);
  };

  const rejectTransfer = (): void => {
    transferRef.current?.rejectTransfer();
    setPendingManifest(undefined);
  };

  const stageFolder = async (collection: FolderCollection): Promise<void> => {
    const transfer = transferRef.current;
    if (transfer === undefined) {
      return;
    }
    const files = collection.entries.filter(
      (entry) => entry.file !== undefined,
    );
    const selection: StagedSelection = {
      kind: "folder",
      name: `${collection.rootName}.zip`,
      size: files.reduce((total, entry) => total + (entry.file?.size ?? 0), 0),
      fileCount: files.length,
    };
    stagedSelectionRef.current = selection;
    setStagedSelection(selection);
    resetTransferPresentation();
    setSkippedCount(collection.skippedCount);
    setAnnouncement(
      `Nice folder! ${collection.rootName} is staged and ready to travel.`,
    );
    dispatchTransferUi({ type: "stage" });
    try {
      await transfer.startFolderSend(collection.entries, collection.rootName);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not start folder transfer.";
      dispatchTransferUi({ type: "error", message });
      setAnnouncement(getFailureCopy(message, role).message);
      setLog(message);
    }
  };

  const startFileTransfer = (file: File): void => {
    if (transferRef.current === undefined) {
      return;
    }
    const selection: StagedSelection = {
      kind: "file",
      name: file.name,
      size: file.size,
    };
    stagedSelectionRef.current = selection;
    setStagedSelection(selection);
    resetTransferPresentation();
    setSkippedCount(undefined);
    setAnnouncement(`Nice slice! ${file.name} is staged and ready to travel.`);
    dispatchTransferUi({ type: "stage" });
    void transferRef.current.startSend(file).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Could not start transfer.";
      dispatchTransferUi({ type: "error", message });
      setAnnouncement(getFailureCopy(message, role).message);
      setLog(message);
    });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    if (file !== undefined) {
      startFileTransfer(file);
    }
  };

  const handleFolderChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = event.currentTarget.files;
    if (files === null) {
      return;
    }
    try {
      void stageFolder(mapInputFiles(files));
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Could not stage the folder.";
      dispatchTransferUi({ type: "error", message });
      setAnnouncement(getFailureCopy(message, role).message);
      setLog(message);
    }
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (role !== "uploader") {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    if (role === "uploader") {
      event.preventDefault();
      setIsDragging(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (role !== "uploader") {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    if (role !== "uploader") {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    const droppedEntries = Array.from(event.dataTransfer.items)
      .map((item) =>
        (
          item as DataTransferItem & {
            webkitGetAsEntry?: () => FileSystemEntry | null;
          }
        ).webkitGetAsEntry?.(),
      )
      .filter(
        (entry): entry is FileSystemEntry =>
          entry !== null && entry !== undefined,
      );
    const directory = droppedEntries.find((entry) => entry.isDirectory);
    if (directory !== undefined) {
      setSkippedCount(undefined);
      void collectDroppedFolder(directory)
        .then(stageFolder)
        .catch((error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : "Could not stage the folder.";
          dispatchTransferUi({ type: "error", message });
          setAnnouncement(getFailureCopy(message, role).message);
          setLog(message);
        });
      return;
    }

    const file = event.dataTransfer.files[0];
    if (file !== undefined) {
      startFileTransfer(file);
    }
  };

  const shortShareUrl =
    roomSlug === undefined ? undefined : `mayo.pizza/${roomSlug}`;
  const technicalShareUrl =
    roomSlug === undefined ? undefined : getTechnicalShareUrl(roomSlug);

  useEffect(() => {
    let active = true;
    if (
      role !== "uploader" ||
      stagedSelection === undefined ||
      technicalShareUrl === undefined
    ) {
      setQrSvg(undefined);
      setQrLoading(false);
      return () => {
        active = false;
      };
    }

    setQrLoading(true);
    void import("qrcode")
      .then(async ({ toString: makeQrSvg }) => {
        const styles = getComputedStyle(document.documentElement);
        // Scanners need dark modules on a light plate, so this pair stays
        // inverted relative to the rest of the dark theme. --mp-qr-plate is the
        // palette's lightest value, matching the .qr-wrap backing behind it.
        const dark = styles.getPropertyValue("--mp-bg").trim();
        const light = styles.getPropertyValue("--mp-qr-plate").trim();
        const svg = await makeQrSvg(technicalShareUrl, {
          type: "svg",
          margin: 1,
          color: { dark, light },
        });
        if (active) {
          setQrSvg(addQrAccessibility(svg, technicalShareUrl));
          setQrLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setQrSvg(undefined);
          setQrLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [role, stagedSelection, technicalShareUrl]);

  const copyShareUrl = async (): Promise<void> => {
    if (technicalShareUrl === undefined || shortShareUrl === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(technicalShareUrl);
      setCopied(true);
      setCopyFailed(false);
      setAnnouncement("Link copied! Your slice is ready to share.");
    } catch {
      setCopied(false);
      setCopyFailed(true);
      setAnnouncement(
        "The link stayed put! Copy it from the room card and share it when you’re ready.",
      );
    }
  };

  const commitRoomPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (role !== "uploader" || passwordRoomIsActive) {
      return;
    }
    const nextPassword = normalizeRoomPassword(passwordDraft);
    automaticRoomRemintCountRef.current = 0;
    setRoomPassword(nextPassword);
    setPasswordDraft(nextPassword ?? "");
    setAnnouncement(
      nextPassword === undefined
        ? "This room stays open. No password was added."
        : "Fresh room incoming! Setting a password creates a new room and changes the slug, so update any link you have already shared.",
    );
  };

  const submitRoomPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (passwordPromptState?.view === "password-locked") {
      return;
    }
    setPasswordAttempt(passwordDraft);
    setSessionStatus("connecting");
    setAnnouncement("Checking that password before we show the slice.");
  };

  const progressText =
    transferProgress === undefined
      ? "—"
      : `${transferProgress.bytesDone}/${transferProgress.totalBytes} bytes · ${Math.round(transferProgress.bytesPerSec)} B/s`;
  const progressPercent =
    transferProgress === undefined || transferProgress.totalBytes <= 0
      ? 0
      : Math.min(
          100,
          Math.max(
            0,
            (transferProgress.bytesDone / transferProgress.totalBytes) * 100,
          ),
        );
  const remainingBytes =
    transferProgress === undefined
      ? 0
      : Math.max(0, transferProgress.totalBytes - transferProgress.bytesDone);
  const isVerifying =
    transferUi.phase === "transferring" &&
    transferProgress !== undefined &&
    transferProgress.bytesDone >= transferProgress.totalBytes;
  const failureReason = transferUi.errorMessage ?? "The transfer failed.";
  const failureCopy = getFailureCopy(failureReason, role);
  const passwordPromptCopy =
    passwordPromptState === undefined
      ? undefined
      : getPasswordPromptCopy(passwordPromptState);
  const sessionCopy =
    sessionNotice ?? getSessionCopy(sessionStatus, role, sessionFailureReason);
  const humanCopy =
    passwordPromptCopy !== undefined
      ? passwordPromptCopy.message
      : pendingManifest !== undefined
        ? "A fresh slice just landed. Check the details, then grab it when you’re ready."
        : transferUi.phase === "staged"
          ? `Nice slice! ${stagedSelection?.name ?? "Your file"} is staged and ready to travel.`
          : transferUi.phase === "complete"
            ? "Slice landed! It’s verified and ready to enjoy."
            : transferUi.phase === "failed"
              ? failureCopy.message
              : transferUi.phase === "cancelled"
                ? getFailureCopy("cancelled", role).message
                : isVerifying
                  ? "The slice made it. We’re checking every crumb now."
                  : transferUi.phase === "transferring"
                    ? "Your slice is on the move. Keep this tab open while it travels."
                    : sessionCopy;
  const viewKey =
    passwordPromptState !== undefined
      ? passwordPromptState.view
      : pendingManifest !== undefined
        ? "manifest"
        : `${role}-${transferUi.phase}`;

  useEffect(() => {
    if (viewKey !== "") {
      headingRef.current?.focus();
      if (passwordPromptState?.view === "password-wrong") {
        passwordInputRef.current?.focus();
      }
    }
  }, [passwordPromptState, viewKey]);

  const passwordRoomIsActive = roomPassword !== undefined;

  return (
    <main
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <section
        className={`drop-zone${isDragging ? " drop-zone--dragging" : ""}`}
        aria-label={
          role === "uploader"
            ? "Drop zone for sending a file"
            : "mayo.pizza receiver room"
        }
      >
        <div
          className={`room-card${role === "downloader" ? " room-card--compact" : ""}`}
        >
          <header className="brand-hero">
            <img
              className="brand-mark"
              src="/brand/logo-mark.svg"
              alt="mayo.pizza pizza portrait"
            />
            <h1 className="wordmark">mayo.pizza</h1>
            <p className="tagline">Secure. Fast. Shared.</p>
          </header>

          <div className="mt-8 grid gap-4">
            <h2 ref={headingRef} className="view-heading" tabIndex={-1}>
              {passwordPromptCopy?.heading ??
                (role === "uploader" ? "Send a slice" : "Receive a slice")}
            </h2>
            <p className="voice-copy">{humanCopy}</p>
            {isDragging && role === "uploader" && (
              <p className="status-banner" role="status">
                <span className="status-banner__label">Drop zone ready</span>
                <span>Drop it like it’s hot! Let go to stage your slice.</span>
              </p>
            )}
          </div>

          {roomSlug !== undefined && passwordPromptState === undefined && (
            <p className="mt-6 muted">
              Room:{" "}
              <span className="mono" data-testid="slug">
                {roomSlug}
              </span>
            </p>
          )}

          {role === "uploader" && (
            <div className="mt-6 grid gap-4">
              {stagedSelection === undefined && (
                <div className="file-picker-row">
                  <label
                    className="picker-label picker-label--primary"
                    data-testid="file-picker-label"
                    htmlFor="file-input"
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        fileInputRef.current?.click();
                      }
                    }}
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: the label is the visible keyboard file-picker affordance
                    tabIndex={0}
                  >
                    Choose a slice
                    <input
                      ref={fileInputRef}
                      className="visually-hidden-input"
                      data-testid="file-input"
                      id="file-input"
                      onChange={handleFileChange}
                      // The label is the keyboard affordance; the input stays operable via label clicks and setInputFiles.
                      tabIndex={-1}
                      type="file"
                    />
                  </label>
                  <label
                    className="picker-label picker-label--secondary"
                    htmlFor="folder-input"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: the label is the visible keyboard folder-picker affordance
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        document.getElementById("folder-input")?.click();
                      }
                    }}
                  >
                    Choose folder
                    <input
                      {...{ webkitdirectory: "" }}
                      className="visually-hidden-input"
                      data-testid="folder-input"
                      id="folder-input"
                      multiple
                      onChange={handleFolderChange}
                      // The label is the keyboard affordance; the input stays operable via label clicks and setInputFiles.
                      tabIndex={-1}
                      type="file"
                    />
                  </label>
                </div>
              )}

              <details
                className="password-panel"
                data-testid="password-panel"
                open={passwordRoomIsActive || undefined}
              >
                <summary>
                  {passwordRoomIsActive
                    ? "Password room is on"
                    : "Lock this room (optional)"}
                </summary>
                <form onSubmit={commitRoomPassword}>
                  <label className="password-field">
                    <span>Room password</span>
                    <input
                      aria-describedby="password-note"
                      data-testid="password-input"
                      disabled={passwordRoomIsActive}
                      onChange={(event) => setPasswordDraft(event.target.value)}
                      placeholder={
                        passwordRoomIsActive
                          ? "Password set for this room"
                          : "Set before opening a room"
                      }
                      type="password"
                      value={passwordDraft}
                    />
                  </label>
                  <p className="password-note" id="password-note">
                    {passwordRoomIsActive
                      ? "This room is protected. Setting it created a fresh room, so its slug changed."
                      : "Commit a password to create a fresh room. The slug will change, so update any link you have already shared."}
                  </p>
                  {!passwordRoomIsActive && (
                    <button
                      className="button button--secondary mt-3"
                      data-testid="password-commit"
                      type="submit"
                    >
                      Set room password
                    </button>
                  )}
                </form>
              </details>

              {skippedCount !== undefined && (
                <p className="muted" data-testid="skipped-count">
                  Skipped {skippedCount} system files
                </p>
              )}

              {stagedSelection !== undefined && (
                <div className="staged-card">
                  <div className="staged-card__header">
                    <div>
                      <p className="file-name">{stagedSelection.name}</p>
                      <p className="mono muted">
                        {formatBytes(stagedSelection.size)}
                        {stagedSelection.fileCount === undefined
                          ? ""
                          : ` · ${stagedSelection.fileCount} files`}
                      </p>
                    </div>
                    <span className="mono muted">
                      {transferUi.phase === "complete" ? "landed" : "staged"}
                    </span>
                  </div>

                  {shortShareUrl !== undefined &&
                    technicalShareUrl !== undefined && (
                      <div className="room-link">
                        <span className="muted">Share this room</span>
                        <div className="button-row">
                          <span className="room-link__value">
                            {shortShareUrl}
                          </span>
                          <button
                            className="button button--secondary"
                            onClick={() => void copyShareUrl()}
                            type="button"
                            aria-label="Copy room link"
                          >
                            {copied ? "Copied!" : "Copy link"}
                          </button>
                        </div>
                        {copyFailed && (
                          <span className="muted">
                            The link stayed put. Select it and copy it when
                            you’re ready.
                          </span>
                        )}
                      </div>
                    )}

                  <div className="staged-card__body">
                    <div>
                      <p className="muted">
                        {passwordRoomIsActive
                          ? "This room is protected. The password stays out of the room link."
                          : "Your slice is ready to travel peer to peer."}
                      </p>
                    </div>
                    <div className="qr-wrap">
                      {qrSvg !== undefined ? (
                        // The SVG is generated locally by qrcode from a validated room URL.
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: local QR SVG is generated without remote input
                        <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
                      ) : (
                        <span className="muted" role="status">
                          {qrLoading
                            ? "Making a share square…"
                            : "Share square unavailable"}
                        </span>
                      )}
                      <span className="muted">Scan to join</span>
                    </div>
                  </div>
                </div>
              )}

              {transferProgress !== undefined && (
                <section
                  className="transfer-panel"
                  aria-label="Transfer progress"
                >
                  <div className="progress-track" aria-hidden="true">
                    <div
                      className="progress-fill"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <div className="progress-stats">
                    <span className="mono">{progressText}</span>
                    <span className="mono">
                      {formatTransferRate(transferProgress.bytesPerSec)} · ETA{" "}
                      {formatEta(remainingBytes, transferProgress.bytesPerSec)}
                    </span>
                  </div>
                </section>
              )}

              <button
                className="button button--ghost"
                data-testid="ping"
                disabled={connectionState !== "connected"}
                onClick={sendPing}
                tabIndex={-1}
                type="button"
              >
                Send ping
              </button>
            </div>
          )}

          {role === "downloader" && passwordPromptState !== undefined && (
            <form
              className="password-prompt mt-6"
              data-testid="password-prompt"
              onSubmit={submitRoomPassword}
            >
              <label className="password-field">
                <span>Room password</span>
                <input
                  ref={passwordInputRef}
                  aria-describedby="password-prompt-note"
                  autoComplete="current-password"
                  data-testid="password-input"
                  disabled={passwordPromptState.view === "password-locked"}
                  onChange={(event) => setPasswordDraft(event.target.value)}
                  type="password"
                  value={passwordDraft}
                />
              </label>
              <p className="password-note" id="password-prompt-note">
                {passwordPromptCopy?.message}
              </p>
              {passwordPromptState.view !== "password-locked" && (
                <button
                  className="button button--primary"
                  data-testid="password-submit"
                  type="submit"
                >
                  Open the room
                </button>
              )}
            </form>
          )}

          {role === "downloader" &&
            passwordPromptState === undefined &&
            pendingManifest !== undefined && (
              <div className="mt-6 grid gap-4">
                <article
                  className="manifest-card"
                  data-testid="manifest-preview"
                >
                  <div className="manifest-card__header">
                    <div>
                      <p className="file-name">
                        {pendingManifest.suggestedName}
                      </p>
                      <p className="mono muted">
                        {formatBytes(pendingManifest.totalBytes)}
                      </p>
                    </div>
                    <span className="mono muted">
                      {pendingManifest.mode === "zip"
                        ? "folder slice"
                        : "file slice"}
                    </span>
                  </div>
                  {pendingManifest.mode === "zip" && (
                    <p className="mono muted">
                      <span data-testid="manifest-file-count">
                        {pendingManifest.items.length}
                      </span>{" "}
                      files · {pendingManifest.totalBytes} bytes
                    </p>
                  )}
                  <div className="button-row">
                    <button
                      className="button button--primary"
                      data-testid="accept-transfer"
                      onClick={acceptTransfer}
                      type="button"
                    >
                      Grab your slice
                    </button>
                    <button
                      className="button button--ghost"
                      data-testid="reject-transfer"
                      onClick={rejectTransfer}
                      type="button"
                    >
                      Put it back
                    </button>
                  </div>
                </article>
              </div>
            )}

          {role === "downloader" &&
            passwordPromptState === undefined &&
            transferProgress !== undefined && (
              <section
                className="mt-6 transfer-panel"
                aria-label="Transfer progress"
              >
                <div className="progress-track" aria-hidden="true">
                  <div
                    className="progress-fill"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="progress-stats">
                  <span className="mono">{progressText}</span>
                  <span className="mono">
                    {formatTransferRate(transferProgress.bytesPerSec)} · ETA{" "}
                    {formatEta(remainingBytes, transferProgress.bytesPerSec)}
                  </span>
                </div>
              </section>
            )}

          {role === "downloader" &&
            passwordPromptState === undefined &&
            sinkStall?.stalled && (
              <p
                className="status-banner mt-6"
                data-testid="sink-stall-warning"
                role="status"
              >
                <span className="status-banner__label">Download paused</span>
                <span>Waiting for your browser's download to continue…</span>
              </p>
            )}

          {passwordPromptState === undefined &&
            transferUi.phase === "failed" && (
              <div className="failure-card mt-6" role="alert">
                <h3>{failureCopy.heading}</h3>
                <p className="voice-copy">{failureCopy.message}</p>
                <details className="error-detail">
                  <summary>Show the technical crumb trail</summary>
                  <code>{failureReason}</code>
                </details>
              </div>
            )}

          {passwordPromptState === undefined && (
            <div className="result-line mt-6" data-testid="transfer-result">
              {transferUi.phase === "complete" && transferResult?.verified ? (
                `Transfer result: verified=true sha256=${transferResult.sha256}`
              ) : transferUi.phase === "failed" &&
                transferResult !== undefined ? (
                <>
                  Transfer result: failed — {failureCopy.message}{" "}
                  <details className="error-detail">
                    <summary>Technical details</summary>
                    <code>
                      verified=false sha256={transferResult.sha256}
                      {transferResult.expectedSha256 === undefined
                        ? ""
                        : ` expectedSha256=${transferResult.expectedSha256}`}
                    </code>
                  </details>
                </>
              ) : transferUi.phase === "failed" ? (
                <>
                  Transfer result: failed — {failureCopy.message}{" "}
                  <details className="error-detail">
                    <summary>Technical details</summary>
                    <code>{failureReason}</code>
                  </details>
                </>
              ) : transferUi.phase === "cancelled" ? (
                "Transfer result: cancelled"
              ) : (
                "Transfer result: pending"
              )}
            </div>
          )}

          {passwordPromptState === undefined && (
            <p className="status-banner mt-6" role="status">
              <span className="status-banner__label">Room status</span>
              <span>{humanCopy}</span>
            </p>
          )}

          {passwordPromptState === undefined && (
            <details className="mt-4">
              <summary className="muted">Under the hood</summary>
              <div className="technical-grid mt-3">
                <dl className="technical-grid__row">
                  <dt>Connection</dt>
                  <dd data-testid="connection-state">{connectionState}</dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>Session</dt>
                  <dd data-testid="session-status">{sessionStatus}</dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>ICE</dt>
                  <dd>{iceConnectionState}</dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>Route</dt>
                  <dd data-testid="selected-route">
                    {formatSelectedRoute(
                      selectedRouteStats?.route ?? selectedRoute,
                      selectedRouteStats?.relayProtocol,
                    )}
                  </dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>Transport protocol</dt>
                  <dd data-testid="transport-protocol">
                    {selectedRouteStats?.protocol ?? "—"}
                  </dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>Observed rate</dt>
                  <dd data-testid="observed-rate">
                    {observedRate === undefined
                      ? "—"
                      : formatTransferRate(observedRate)}
                  </dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>RTT</dt>
                  <dd data-testid="rtt">
                    {formatRoundTripTime(
                      selectedRouteStats?.currentRoundTripTime,
                    )}
                  </dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>Last pong</dt>
                  <dd data-testid="last-pong">{lastPong}</dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>Transfer</dt>
                  <dd data-testid="progress">{progressText}</dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>Buffered</dt>
                  <dd data-testid="buffered-amount">{bufferedAmount}</dd>
                </dl>
                <dl className="technical-grid__row">
                  <dt>Sink</dt>
                  <dd data-testid="sink-strategy">{getSinkStrategy()}</dd>
                </dl>
                <p className="muted text-xs">
                  Peak buffered:{" "}
                  <span className="mono">{maxBufferedAmount} bytes</span>
                </p>
                <p data-testid="log" className="muted text-xs">
                  {log}
                </p>
              </div>
            </details>
          )}

          <footer className="privacy-note">
            {selectedRoute === "relay" && (
              <p className="relay-note" data-testid="relay-note">
                This connection is taking the relayed route: encrypted bytes
                pass through our relay, but we still can’t read them.{" "}
                <a href="/privacy">Learn more in privacy.</a>
              </p>
            )}
            {selectedRoute !== "relay" &&
              "On a direct path, your files travel peer to peer. If we use TURN, encrypted bytes pass through our relay; we still can’t read them."}
            <span className="legal-links">
              <a href="/privacy">Privacy</a>
              <a href="/terms">Terms &amp; Abuse</a>
              <a
                href="https://github.com/jarwoethes-jpg/mayo-pizza#faq"
                target="_blank"
                rel="noopener noreferrer"
              >
                FAQ
              </a>
              <a
                href={DONATE_URL}
                className="kofi-button"
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  src="/brand/kofi-button.png"
                  height="36"
                  alt="Buy Me a Coffee at ko-fi.com"
                />
              </a>
            </span>
          </footer>
        </div>
      </section>
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
    </main>
  );
};

export { RoomView };

type AppRoute =
  | ({ kind: "room" } & RoomViewProps)
  | { kind: "privacy" }
  | { kind: "terms" };

const getRoute = (): AppRoute => {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
  if (path === "privacy") {
    return { kind: "privacy" };
  }
  if (path === "terms") {
    return { kind: "terms" };
  }
  if (path === "") {
    return { kind: "room", role: "uploader" };
  }
  try {
    return {
      kind: "room",
      role: "downloader",
      slug: decodeURIComponent(path),
    };
  } catch {
    return {
      kind: "room",
      role: "downloader",
      slug: path,
    };
  }
};

const App = () => {
  const route = getRoute();
  if (route.kind === "privacy") {
    return <PrivacyPage />;
  }
  if (route.kind === "terms") {
    return <TermsPage />;
  }
  return (
    <RoomView
      role={route.role}
      {...(route.slug === undefined ? {} : { slug: route.slug })}
    />
  );
};

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The application root is missing.");
}

createRoot(rootElement).render(<App />);
