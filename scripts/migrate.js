// Applies SQL migrations from db/migrations in filename order.
// Tracks applied files in the `migrations` table; safe to re-run.
//
// Usage: npm run migrate
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import { DB_CONFIG, closePool } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Connect without selecting a database first so we can create it if needed.
  const bootstrap = await mysql.createConnection({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
    multipleStatements: true
  });
  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrap.query(`USE \`${DB_CONFIG.database}\``);
  await bootstrap.query(`CREATE TABLE IF NOT EXISTS migrations (
    name VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const [appliedRows] = await bootstrap.query("SELECT name FROM migrations");
  const applied = new Set(appliedRows.map(r => r.name));

  const dir = path.join(__dirname, "..", "db", "migrations");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    process.stdout.write(`Applying ${file} ... `);
    try {
      await bootstrap.query(sql);
      await bootstrap.query("INSERT INTO migrations (name) VALUES (?)", [file]);
      console.log("ok");
      ran++;
    } catch (e) {
      console.log("FAILED");
      console.error(e.message);
      process.exitCode = 1;
      break;
    }
  }
  await bootstrap.end();
  await closePool();
  console.log(ran === 0 ? "Database is up to date." : `Applied ${ran} migration(s).`);
}

main().catch(e => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
