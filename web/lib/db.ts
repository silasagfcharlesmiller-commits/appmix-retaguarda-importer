import { Pool, PoolClient, QueryResultRow } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globalForDb = globalThis as unknown as { appMixPool?: Pool };

function pool() {
  const connectionString = process.env.DATABASE_URL;
  let localConfig: Record<string, string | number> | undefined;
  if (!connectionString && process.env.NODE_ENV === "development") {
    try { localConfig = JSON.parse(readFileSync(resolve(process.cwd(), "..", "config_mix.json"), "utf8")).database; }
    catch { /* A mensagem abaixo orienta a configurar DATABASE_URL. */ }
  }
  if (!connectionString && !localConfig) throw new Error("DATABASE_URL nao configurada.");
  globalForDb.appMixPool ??= new Pool({
    ...(connectionString ? { connectionString } : {
      host: String(localConfig?.host || "localhost"),
      port: Number(localConfig?.port || 5432),
      database: String(localConfig?.name || ""),
      user: String(localConfig?.user || ""),
      password: String(localConfig?.password || ""),
    }),
    max: 4,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });
  return globalForDb.appMixPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return pool().query<T>(text, values);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool().connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
