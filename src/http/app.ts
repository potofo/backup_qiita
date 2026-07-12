/**
 * Expressアプリ組み立て(静的配信 + /api ルータ)
 */
import express, { type Express, type Router } from "express";
import type { Logger } from "../config/logger.js";

export type AppDeps = {
  publicDir: string;
  logger: Logger;
  /** /api/* ルータ(タスク4で配線)。未指定時はヘルスチェックのみ */
  apiRouter?: Router;
};

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.apiRouter) {
    app.use("/api", deps.apiRouter);
  }

  app.use(express.static(deps.publicDir));
  return app;
}
