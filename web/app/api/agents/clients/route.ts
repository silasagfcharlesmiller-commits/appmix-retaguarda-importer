import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, verifySession } from "@/lib/session";
import { getUser } from "@/lib/users";
import { query } from "@/lib/db";
import { getAgentClient } from "@/lib/agent-client";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value);
  const user = session ? await getUser(session.email) : null;
  if (!user) return NextResponse.json({ detail: "Sessão expirada." }, { status: 401 });
  const cnpj = (request.nextUrl.searchParams.get("cnpj") || "").replace(/\D/g, "");
  if (!/^\d{14}$/.test(cnpj)) return NextResponse.json({ detail: "CNPJ inválido." }, { status: 422 });
  try {
    // Authorize before authenticating upstream; never allow arbitrary client lookups.
    const owned = await query("SELECT id FROM public.mix_agents WHERE owner_id=$1 AND cnpj=$2 LIMIT 1", [user.owner_id, cnpj]);
    if (!owned.rowCount) return NextResponse.json({ detail: "Robô não encontrado." }, { status: 404 });
    return NextResponse.json(await getAgentClient(user.owner_id, cnpj), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ detail: "Não foi possível consultar o cadastro. Verifique a credencial do App Mix ou tente novamente." }, { status: 502 });
  }
}
