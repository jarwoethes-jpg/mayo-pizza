import { z } from "zod";
import { transferMessageSchema } from "./transfer.js";

const pingPongMessageSchema = z.union([
  z
    .object({
      t: z.literal("ping"),
      nonce: z.string(),
    })
    .strict(),
  z
    .object({
      t: z.literal("pong"),
      nonce: z.string(),
    })
    .strict(),
]);

/** Messages sent over the reliable `ctrl` data channel. */
export const ctrlMessageSchema = z.union([
  transferMessageSchema,
  pingPongMessageSchema,
]);

export type CtrlMessage = z.infer<typeof ctrlMessageSchema>;
