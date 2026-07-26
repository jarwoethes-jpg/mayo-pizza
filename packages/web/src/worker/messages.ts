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
      t: "finish";
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
