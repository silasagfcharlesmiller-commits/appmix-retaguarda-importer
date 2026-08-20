import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { query } from "@/lib/db";

const scrypt = promisify(scryptCallback);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string) {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function ensureUsers() {
  await query(`CREATE TABLE IF NOT EXISTS public.web_users (
    id SERIAL PRIMARY KEY, nome VARCHAR(100) NOT NULL, email VARCHAR(180) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const email = process.env.APP_MIX_ADMIN_EMAIL;
  const password = process.env.APP_MIX_ADMIN_PASSWORD;
  if (email && password) {
    const users = await query("SELECT 1 FROM public.web_users LIMIT 1");
    if (!users.rowCount) await query("INSERT INTO public.web_users (nome,email,password_hash) VALUES ($1,$2,$3)", ["Administrador", email.toLowerCase(), await hashPassword(password)]);
  }
}

export async function authenticateUser(email: string, password: string) {
  await ensureUsers();
  const result = await query<{ id:number; nome:string; email:string; password_hash:string }>("SELECT id,nome,email,password_hash FROM public.web_users WHERE LOWER(email)=LOWER($1)", [email]);
  const user = result.rows[0];
  return user && await verifyPassword(password, user.password_hash) ? { id:user.id, nome:user.nome, email:user.email } : null;
}

export async function getUser(email: string) {
  await ensureUsers();
  const result = await query<{ id:number; nome:string; email:string }>("SELECT id,nome,email FROM public.web_users WHERE LOWER(email)=LOWER($1)", [email]);
  return result.rows[0] || null;
}

export async function updateUser(email: string, login: string, currentPassword: string, newPassword?: string) {
  const auth = await authenticateUser(email, currentPassword);
  if (!auth) throw new Error("Senha atual incorreta.");
  login = login.trim().toLowerCase();
  if (login.length < 3 || login.length > 180) throw new Error("Informe um usuario de acesso valido.");
  const duplicate = await query("SELECT 1 FROM public.web_users WHERE LOWER(email)=LOWER($1) AND id<>$2", [login, auth.id]);
  if (duplicate.rowCount) throw new Error("Este usuario de acesso ja esta em uso.");
  if (newPassword && (newPassword.length < 12 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword))) throw new Error("A nova senha precisa ter 12 caracteres, letra, numero e simbolo.");
  if (newPassword) await query("UPDATE public.web_users SET nome=$1,email=$1,password_hash=$2,atualizado_em=NOW() WHERE id=$3", [login, await hashPassword(newPassword), auth.id]);
  else await query("UPDATE public.web_users SET nome=$1,email=$1,atualizado_em=NOW() WHERE id=$2", [login, auth.id]);
  return { ...auth, nome:login, email:login };
}
