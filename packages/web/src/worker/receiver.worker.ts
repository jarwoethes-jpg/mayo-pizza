import type { ReceiverWorkerCommand, ReceiverWorkerEvent } from "./messages";
import { ReceiverProcessor } from "./receiverLogic";

interface ReceiverWorkerScope {
  onmessage: ((event: MessageEvent<ReceiverWorkerCommand>) => void) | null;
  postMessage: (
    message: ReceiverWorkerEvent,
    transfer?: Transferable[],
  ) => void;
}

const workerScope = self as unknown as ReceiverWorkerScope;
const processor = new ReceiverProcessor((message, transfer) => {
  workerScope.postMessage(message, transfer);
});

workerScope.onmessage = (event) => {
  processor.handle(event.data);
};
