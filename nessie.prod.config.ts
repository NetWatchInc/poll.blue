import {
    ClientPostgreSQL,
    NessieConfig,
} from "https://deno.land/x/nessie@2.0.10/mod.ts";
import { load } from "https://deno.land/std@0.186.0/dotenv/mod.ts";

const env = await load({ envPath: './.prod.env' });

const client = new ClientPostgreSQL({
    database: "db",
    hostname: Deno.env.get("DATABASE_URL") || "localhost",
    port: 25060,
    user: "db",
    password: Deno.env.get("PG_PASSWORD") || "",
    host_type: "tcp",
});

/** This is the final config object */
const config: NessieConfig = {
    client,
    migrationFolders: ["./db/migrations"],
    seedFolders: ["./db/seeds"],
};

export default config;
