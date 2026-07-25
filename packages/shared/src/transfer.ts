import { z } from "zod";

const byteCountSchema = z.number().int().nonnegative();
const itemSchema = z
  .object({
    path: z.string(),
    size: byteCountSchema,
    lastModified: z.number().finite().nonnegative(),
  })
  .strict();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const transferMessageSchema = z.discriminatedUnion("t", [
  z
    .object({
      t: z.literal("manifest"),
      transferId: z.string(),
      mode: z.enum(["single", "zip"]),
      items: z.array(itemSchema),
      totalBytes: byteCountSchema,
      suggestedName: z.string(),
    })
    .strict(),
  z
    .object({
      t: z.literal("start"),
      transferId: z.string(),
      offset: byteCountSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal("done"),
      transferId: z.string(),
      sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      t: z.literal("error"),
      code: z.string(),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      t: z.literal("request"),
      transferId: z.string(),
      offset: byteCountSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal("ack"),
      receivedBytes: byteCountSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal("complete"),
      transferId: z.string(),
      verified: z.boolean(),
    })
    .strict(),
  z
    .object({
      t: z.literal("cancel"),
      reason: z.string(),
    })
    .strict(),
]);

export type TransferMessage = z.infer<typeof transferMessageSchema>;
