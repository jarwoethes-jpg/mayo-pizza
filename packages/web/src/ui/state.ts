import type { TransferResult } from "../net/transfer";

export type TransferUiPhase =
  | "idle"
  | "staged"
  | "transferring"
  | "complete"
  | "failed"
  | "cancelled";

export interface TransferUiState {
  phase: TransferUiPhase;
  errorMessage?: string;
  result?: TransferResult;
}

export type TransferUiEvent =
  | { type: "stage" }
  | { type: "progress" }
  | { type: "result"; result: TransferResult }
  | { type: "error"; message: string }
  | { type: "cancel" }
  | { type: "reset" };

/** Moves presentation state in response to engine events without changing transfer behavior. */
export const transferUiReducer = (
  _state: TransferUiState,
  event: TransferUiEvent,
): TransferUiState => {
  switch (event.type) {
    case "stage":
      return { phase: "staged" };
    case "progress":
      return { phase: "transferring" };
    case "result":
      return {
        phase: event.result.verified ? "complete" : "failed",
        result: event.result,
        ...(event.result.verified
          ? {}
          : { errorMessage: "The bytes did not line up after the transfer." }),
      };
    case "error":
      return { phase: "failed", errorMessage: event.message };
    case "cancel":
      return { phase: "cancelled" };
    case "reset":
      return { phase: "idle" };
  }
};

export const initialTransferUiState: TransferUiState = { phase: "idle" };
