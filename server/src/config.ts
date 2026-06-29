import "dotenv/config";
import { z } from "zod";

// dotenv auto-loads ./.env for local dev; in production the platform provides
// these as real environment variables (dotenv won't override existing ones).
//
// DB defaults target a DigitalOcean managed Postgres (port 25060, TLS) so an
// EXISTING DO config — which only sets PG_HOST/PG_DATABASE/PG_USERNAME/
// PG_PASSWORD (the old Deno app hardcoded the port + TLS) — works unchanged.
// A local Postgres should set PG_PORT=5432 and PG_SSL=disable in .env.
const schema = z.object({
  ENV: z.string().default("dev"),
  PORT: z.coerce.number().default(8000),
  HOSTNAME: z.string().default("poll.blue"),

  // Provide EITHER DATABASE_URL, or the PG_* fields below.
  DATABASE_URL: z.string().optional(),
  PG_HOST: z.string().default(""),
  PG_PORT: z.coerce.number().default(25060),
  PG_DATABASE: z.string().default(""),
  PG_USERNAME: z.string().default(""),
  PG_PASSWORD: z.string().default(""),
  PG_SSL: z.enum(["require", "disable"]).default("require"),

  BSKY_USERNAME: z.string().default("empty"),
  BSKY_PASSWORD: z.string().default("empty"),
  BSKY_HOST: z.string().default("https://bsky.social"),
});

export const config = schema.parse(process.env);
export type Config = typeof config;

export const isDev = config.ENV === "dev";
export const botEnabled = config.BSKY_USERNAME !== "empty" && config.BSKY_PASSWORD !== "empty";

export const dbDescription = config.DATABASE_URL
  ? "DATABASE_URL"
  : `${config.PG_HOST}:${config.PG_PORT} ssl=${config.PG_SSL}`;
