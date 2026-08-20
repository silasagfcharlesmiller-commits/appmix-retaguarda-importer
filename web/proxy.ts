import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, verifySession } from "@/lib/session";

export async function proxy(request: NextRequest) {
  const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value);
  if (session) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ detail: "Sessao expirada" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/painel/:path*", "/api/mix/:path*", "/api/profile/:path*"] };
