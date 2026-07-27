import { z } from "zod";

const iceServerSchema = z
  .object({
    urls: z.union([z.string(), z.array(z.string()).min(1)]),
    username: z.string().optional(),
    credential: z.string().optional(),
    credentialType: z.enum(["password", "oauth"]).optional(),
  })
  .strict();

const signalingErrorCodeSchema = z.enum([
  "BAD_SLUG",
  "BAD_PASSWORD",
  "RATE_LIMITED",
  "ROOM_FULL",
  "MALFORMED",
]);
const requiredPayloadSchema = z.custom<unknown>((value) => value !== undefined);

export const signalingMessageSchema = z.union([
  z
    .object({
      t: z.literal("create"),
      password: z.string().optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal("join"),
      slug: z.string(),
      password: z.string().optional(),
      uploaderToken: z.string().optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal("signal"),
      to: z.string(),
      payload: requiredPayloadSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal("ice-config"),
    })
    .strict(),
  z
    .object({
      t: z.literal("close"),
    })
    .strict(),
  z
    .object({
      t: z.literal("stat"),
      event: z.literal("connected"),
      route: z.enum(["direct", "relay"]),
    })
    .strict(),
  z
    .object({
      t: z.literal("created"),
      slug: z.string(),
      uploaderToken: z.string(),
    })
    .strict(),
  z
    .object({
      t: z.literal("joined"),
      peerId: z.string(),
      role: z.enum(["uploader", "downloader"]),
    })
    .strict(),
  z
    .object({
      t: z.literal("peer-joined"),
      peerId: z.string(),
    })
    .strict(),
  z
    .object({
      t: z.literal("peer-left"),
      peerId: z.string(),
    })
    .strict(),
  z
    .object({
      t: z.literal("signal"),
      from: z.string(),
      payload: requiredPayloadSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal("ice-config"),
      iceServers: z.array(iceServerSchema),
    })
    .strict(),
  z
    .object({
      t: z.literal("error"),
      code: signalingErrorCodeSchema,
      message: z.string(),
    })
    .strict(),
]);

export type SignalingMessage = z.infer<typeof signalingMessageSchema>;
