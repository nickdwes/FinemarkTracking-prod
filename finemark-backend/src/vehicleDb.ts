import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

/**
 * Separate connection pool pointed at the finemark_vehicles database — a
 * physically distinct database from finemark_backend (and from
 * finemark_archive), so vehicle master data from external sources can never
 * accidentally be joined into a live-CRM query. Unlike the archive database,
 * this one is actively written to by sync jobs and admin actions.
 */
const pool = new Pool({
  host: process.env.PG_HOST || "127.0.0.1",
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.VEHICLE_PG_DATABASE || "finemark_vehicles",
  user: process.env.PG_USER || "finemark",
  password: process.env.PG_PASSWORD || "finemark_secret",
  max: 10,
});

pool.on("error", (err) => {
  console.error("Unexpected vehicle PG pool error", err);
});

const toPositional = (sql: string): string => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

export const vehicleGet = async <T = any>(sql: string, params: any[] = []): Promise<T | undefined> => {
  const { rows } = await pool.query(toPositional(sql), params);
  return rows[0] as T | undefined;
};

export const vehicleAll = async <T = any>(sql: string, params: any[] = []): Promise<T[]> => {
  const { rows } = await pool.query(toPositional(sql), params);
  return rows as T[];
};

export const vehicleRun = async (sql: string, params: any[] = []): Promise<void> => {
  await pool.query(toPositional(sql), params);
};

export { pool as vehiclePool };
export default pool;
