import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";

/** Creates the Phase 0 HTTP application. */
export const createApp = (): FastifyInstance => {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  return app;
};

/** Starts the HTTP server on the requested port. */
export const startServer = async (port = 3000): Promise<string> => {
  const app = createApp();
  return app.listen({ host: "0.0.0.0", port });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  await startServer(port);
}
