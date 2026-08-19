import { NextResponse } from "next/server";
import { COOKIE_NAME, createSession } from "@/lib/session";

export async function POST(request: Request) {
  const { email, password } = await request.json().catch(() => ({}));
  const expectedEmail = process.env.APP_MIX_ADMIN_EMAIL || (process.env.NODE_ENV === "development" ? "admin@appmix.local" : "");
  const expectedPassword = process.env.APP_MIX_ADMIN_PASSWORD || (process.env.NODE_ENV === "development" ? "appmix2026" : "");
  if (!expectedEmail || !expectedPassword) return NextResponse.json({ detail: "Login ainda nao configurado no servidor." }, { status: 503 });
  if (email !== expectedEmail || password !== expectedPassword) return NextResponse.json({ detail: "E-mail ou senha incorretos." }, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, await createSession(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}
