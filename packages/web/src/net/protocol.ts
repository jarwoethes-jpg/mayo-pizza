import { type CtrlMessage, ctrlMessageSchema } from "shared";

export type CtrlMessageType = CtrlMessage["t"];
export type CtrlHandler<T extends CtrlMessageType> = (
  message: Extract<CtrlMessage, { t: T }>,
) => void;

export interface CtrlProtocolOptions {
  onInvalidFrame?: (raw: unknown) => void;
}

const messageTypes: readonly CtrlMessageType[] = [
  "manifest",
  "start",
  "done",
  "error",
  "request",
  "ack",
  "complete",
  "cancel",
  "ping",
  "pong",
];

type HandlerRegistry = {
  [T in CtrlMessageType]: Set<CtrlHandler<T>>;
};

const createHandlerRegistry = (): HandlerRegistry =>
  Object.fromEntries(
    messageTypes.map((type) => [type, new Set()]),
  ) as HandlerRegistry;

/** Parses a JSON ctrl frame and rejects anything outside the shared schema. */
export const parseCtrlMessage = (raw: unknown): CtrlMessage | undefined => {
  if (typeof raw !== "string") {
    return undefined;
  }

  try {
    const parsed = ctrlMessageSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export interface CtrlProtocol {
  send(message: CtrlMessage): void;
  on<T extends CtrlMessageType>(type: T, handler: CtrlHandler<T>): () => void;
  receive(raw: unknown): CtrlMessage | undefined;
  dispose(): void;
}

/** Adds typed, schema-checked send/receive behavior to a ctrl data channel. */
export const createCtrlProtocol = (
  channel: RTCDataChannel,
  options: CtrlProtocolOptions = {},
): CtrlProtocol => {
  const handlers = createHandlerRegistry();
  const onMessage = (event: MessageEvent<unknown>): void => {
    receive(event.data);
  };

  const receive = (raw: unknown): CtrlMessage | undefined => {
    const message = parseCtrlMessage(raw);
    if (message === undefined) {
      options.onInvalidFrame?.(raw);
      return undefined;
    }

    const typedHandlers = handlers[message.t] as Set<
      CtrlHandler<typeof message.t>
    >;
    for (const handler of typedHandlers) {
      handler(message as never);
    }
    return message;
  };

  channel.addEventListener("message", onMessage);

  return {
    send(message) {
      const validated = ctrlMessageSchema.parse(message);
      channel.send(JSON.stringify(validated));
    },
    on(type, handler) {
      const typedHandlers = handlers[type] as Set<CtrlHandler<typeof type>>;
      typedHandlers.add(handler);
      return () => typedHandlers.delete(handler);
    },
    receive,
    dispose() {
      channel.removeEventListener("message", onMessage);
      for (const type of messageTypes) {
        handlers[type].clear();
      }
    },
  };
};
