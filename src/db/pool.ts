import { Pool } from "pg";
import { config } from "../config";

export const pool = new Pool({ connectionString: config.database.url });

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error", err);
});
