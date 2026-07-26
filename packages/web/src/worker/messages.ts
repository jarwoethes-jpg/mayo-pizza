export type SenderWorkerCommand =
  | {
      t: "start";
      file: File;
      offset: number;
      totalBytes: number;
    }
  | {
      t: "read";
      offset: number;
    }
  | {
      t: "cancel";
    };

export type SenderWorkerEvent =
  | {
      t: "slice";
      buffer: ArrayBuffer;
      bytesDone: number;
      totalBytes: number;
      done: boolean;
      sha256?: string;
    }
  | {
      t: "progress";
      bytesDone: number;
      totalBytes: number;
      bytesPerSec: number;
    }
  | {
      t: "error";
      message: string;
    };

export type ReceiverWorkerCommand =
  | {
      t: "init";
      transferId: string;
      offset: number;
      totalBytes: number;
    }
  | {
      t: "data";
      buffer: ArrayBuffer;
    }
  | {
      t: "commit";
      chunkId: string;
    }
  | {
      t: "finish";
    }
  | {
      t: "sink-error";
      message: string;
    }
  | {
      t: "cancel";
    };

export type ReceiverWorkerEvent =
  | {
      t: "progress";
      bytesDone: number;
      totalBytes: number;
      bytesPerSec: number;
    }
  | {
      t: "chunk";
      chunkId: string;
      buffer: ArrayBuffer;
      bytesDone: number;
      totalBytes: number;
    }
  | {
      t: "ack";
      receivedBytes: number;
    }
  | {
      t: "done";
      bytesDone: number;
      sha256: string;
    }
  | {
      t: "error";
      message: string;
    };
