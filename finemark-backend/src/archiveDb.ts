import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

/**
 * Separate connection pool pointed at the finemark_archive database — a
 * physically distinct database from finemark_backend, not just a schema, so
 * archive data can never accidentally be joined into a live-CRM query.
 * Mostly populated by scripts/archiveEtl.ts, but also written to directly by
 * app routes that move live data into an archive report (e.g. the retired
 * inventory sweep in routes/archive.ts) — see archiveRun below.
 */
const pool = new Pool({
  host: process.env.PG_HOST || "127.0.0.1",
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.ARCHIVE_PG_DATABASE || "finemark_archive",
  user: process.env.PG_USER || "finemark",
  password: process.env.PG_PASSWORD || "finemark_secret",
  max: 10,
});

pool.on("error", (err) => {
  console.error("Unexpected archive PG pool error", err);
});

const toPositional = (sql: string): string => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

export const archiveGet = async <T = any>(sql: string, params: any[] = []): Promise<T | undefined> => {
  const { rows } = await pool.query(toPositional(sql), params);
  return rows[0] as T | undefined;
};

export const archiveAll = async <T = any>(sql: string, params: any[] = []): Promise<T[]> => {
  const { rows } = await pool.query(toPositional(sql), params);
  return rows as T[];
};

export const archiveRun = async (sql: string, params: any[] = []): Promise<void> => {
  await pool.query(toPositional(sql), params);
};

export { pool as archivePool };
export default pool;
