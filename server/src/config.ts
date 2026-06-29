import "dotenv/config";
import { z } from "zod";

// dotenv auto-loads ./.env for local dev; in production the platform provides
// these as real environment variables (dotenv won't override existing ones).
const schema = z.object({
  ENV: z.string().default("dev"),
  PORT: z.coerce.number().default(8000),
  HOSTNAME: z.string().default("poll.blue"),

  PG_HOST: z.string(),
  PG_PORT: z.coerce.number().default(5432),
  PG_DATABASE: z.string(),
  PG_USERNAME: z.string(),
  PG_PASSWORD: z.string().default(""),
  PG_SSL: z.enum(["require", "disable"]).default("disable"),

  BSKY_USERNAME: z.string().default("empty"),
  BSKY_PASSWORD: z.string().default("empty"),
  BSKY_HOST: z.string().default("https://bsky.social"),
});

export const config = schema.parse(process.env);
export type Config = typeof config;

export const isDev = config.ENV === "dev";
export const botEnabled = config.BSKY_USERNAME !== "empty" && config.BSKY_PASSWORD !== "empty";
