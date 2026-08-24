// MySQL connection pool (Phase 3.1).
//
// Connection settings come from env vars so the same code runs locally
// (XAMPP's MySQL) and on the Hostinger VPS:
//   DB_HOST (default 127.0.0.1)   DB_PORT (default 3306)
//   DB_USER (default root)        DB_PASS (default empty — XAMPP default)
//   DB_NAME (default aar_generator)
import mysql from "mysql2/promise";

export const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS !== undefined ? process.env.DB_PASS : "",
  database: process.env.DB_NAME || "aar_generator"
};

let pool = null;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...DB_CONFIG,
      waitForConnections: true,
      connectionLimit: 10,
      // Rows with JSON columns are returned as already-parsed objects.
      namedPlaceholders: true
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
