interface Window {
  __MAYO_SIGNALING_URL__?: string;
  __MAYO_HEARTBEAT_INTERVAL_MS__?: number;
  __MAYO_FORCE_RELAY__?: boolean;
  __MAYO_CORRUPT_FRAME__?: boolean;
  __MAYO_SINK__?: unknown;
  __MAYO_SINK_STRATEGY__?: "fsa" | "sw" | "blob" | "null";
  __MAYO_OPFS_FILE__?: string;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<FileSystemFileHandle>;
  __MAYO_TRANSFER_STATS__?: {
    bufferedAmount: number;
    maxBufferedAmount: number;
  };
  __MAYO_E2E__?: boolean;
  __MAYO_DEBUG_DROP__?: () => void;
  __cspViolations?: {
    violatedDirective: string;
    blockedURI: string;
    sourceFile: string;
  }[];
}
