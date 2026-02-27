import { config } from "dotenv";
config();

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is required. Check your .env file.");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("[warn] ANTHROPIC_API_KEY not set — summarization will be skipped.");
}

import { StandupBot } from "./bot";

const bot = new StandupBot();

bot.start(process.env.DISCORD_BOT_TOKEN!).catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
