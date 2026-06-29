import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { config, dbDescription } from "./config.ts";
import { pool } from "./db.ts";
import { register } from "./routes/register.ts";
import { getResults } from "./routes/results.ts";
import { vote } from "./routes/vote.ts";
import { startBot } from "./bot.ts";

// Built Astro frontend (relative to cwd). Overridable for the Docker layout.
const WEB_DIST = process.env.WEB_DIST ?? "../web/dist";
const file = (p: string) => serveStatic({ path: `${WEB_DIST}/${p}` });

const app = new Hono();

// --- backend endpoints ------------------------------------------------------
app.get("/status", (c) => c.json({ ok: true }));

app.get("/.well-known/did.json", (c) =>
  c.json({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: `did:web:${config.HOSTNAME}`,
    service: [
      { id: "#bsky_fg", type: "BskyFeedGenerator", serviceEndpoint: `https://${config.HOSTNAME}` },
    ],
  }));

app.get("/xrpc/app.bsky.feed.getFeedSkeleton", (c) => c.json({ feed: [] }));

app.post("/api/poll/register", register);
app.get("/api/poll/:id", getResults);
// Voting is a same-origin JS POST (so firehose/crawler GETs on the link can't
// vote). The option links themselves serve the results page below.
app.post("/api/poll/:id/vote", vote);

// --- static frontend --------------------------------------------------------
app.get("/", file("index.html"));
app.get("/create", file("create/index.html"));
// Both the posted option links (/p/{id}/{n}) and the results page (/p/{id})
// serve the results page; its JS casts the vote (for /p/{id}/{n}) via POST.
app.get("/p/:id/:vote", file("results/index.html"));
app.get("/p/:id", file("results/index.html"));

app.use("/*", serveStatic({ root: WEB_DIST })); // assets, client-metadata.json, favicon
app.get("*", file("index.html")); // SPA fallback

// --- start ------------------------------------------------------------------
try {
  await pool.query("SELECT 1");
  console.log(`DB connected (${dbDescription}).`);
} catch (e) {
  console.error(`DB connection FAILED (${dbDescription}): ${(e as Error).message}`);
  console.error("→ Check DATABASE_URL or PG_* env vars. Poll registration & voting need the DB.");
}

await startBot();
serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`poll.blue server listening on http://localhost:${info.port}`);
});
