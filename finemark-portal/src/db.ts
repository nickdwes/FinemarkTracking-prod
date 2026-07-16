import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PG_HOST     || "127.0.0.1",
  port:     Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || "finemark_backend",
  user:     process.env.PG_USER     || "finemark",
  password: process.env.PG_PASSWORD || "finemark_secret",
  max: 10,
});

pool.on("error", (err) => {
  console.error("[portal-db] Unexpected pool error", err);
});

const toPositional = (sql: string): string => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

export const pgGet = async <T = any>(sql: string, params: any[] = []): Promise<T | undefined> => {
  const { rows } = await pool.query(toPositional(sql), params);
  return rows[0] as T | undefined;
};

export const pgAll = async <T = any>(sql: string, params: any[] = []): Promise<T[]> => {
  const { rows } = await pool.query(toPositional(sql), params);
  return rows as T[];
};

export const pgRun = async (sql: string, params: any[] = []): Promise<void> => {
  await pool.query(toPositional(sql), params);
};

export default pool;
