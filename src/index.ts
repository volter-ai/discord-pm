/**
 * Single-process entry point — starts the Discord bot, transcript web UI,
 * and Activity server on one Bun HTTP server.
 */

import { config } from "dotenv";
config();

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is required. Check your .env file.");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("[warn] ANTHROPIC_API_KEY not set — summarization will be skipped.");
}
if (!process.env.WEB_PASSWORD) {
  console.error("[warn] WEB_PASSWORD is not set — transcript web UI will block all access.");
}
if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
  console.warn("[warn] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set — Activity will not work.");
}

import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { StandupBot } from "./bot";
import { createWebApp } from "./web";
import { createActivityApp } from "./activity";

const PORT = parseInt(process.env.WEB_PORT ?? "8080");

// WebSocket support for Activity real-time communication
const { upgradeWebSocket, websocket } = createBunWebSocket();

// Create the bot
const bot = new StandupBot();

// Compose Hono apps
const app = new Hono();

// Log all incoming requests for debugging
app.use("*", async (c, next) => {
  const method = c.req.method;
  const url = new URL(c.req.url);
  const path = url.pathname;
  const host = c.req.header("host") ?? "no-host";
  const origin = c.req.header("origin") ?? "no-origin";
  const xForward = c.req.header("x-forwarded-for") ?? "";
  console.log(`[http] ${method} ${path} host=${host} origin=${origin} xff=${xForward}`);
  await next();
  console.log(`[http] ${method} ${path} → ${c.res.status}`);
});

// Activity routes (no Basic Auth — uses Discord OAuth2)
const activityApp = createActivityApp(bot, upgradeWebSocket);
app.route("/activity", activityApp);

// Discord proxy sends /activity/ (trailing slash) which Hono's route() misses
app.get("/activity/", async (c) => {
  console.log("[activity] Handling trailing-slash request");
  return activityApp.request("/", { headers: c.req.raw.headers });
});

// Transcript web UI + JSON API (with Basic Auth)
app.route("/", createWebApp(bot));

// Start HTTP server
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  websocket,
  // Brief generation (GitHub fetch + Claude summarization) can take >10s;
  // Bun's 10s default cuts the connection and the fly proxy surfaces a 502.
  idleTimeout: 120,
});

console.log(`[server] HTTP server listening on :${PORT}`);

// Start the Discord bot
bot.start(process.env.DISCORD_BOT_TOKEN!).catch((e) => {
  console.error("Fatal bot startup error:", e);
  process.exit(1);
});
