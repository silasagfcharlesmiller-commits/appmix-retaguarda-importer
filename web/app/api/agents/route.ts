import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, verifySession } from "@/lib/session";
import { getUser } from "@/lib/users";
import { listAgents, queueCommand } from "@/lib/agent-control";

export const runtime = "nodejs";

async function current(request: NextRequest) {
  const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value);
  return session ? getUser(session.email) : null;
}

export async function GET(request: NextRequest) {
  const user = await current(request);
  if (!user) return NextResponse.json({ detail: "Sessao expirada." }, { status: 401 });
  return NextResponse.json({ items: await listAgents(user.owner_id) });
}

export async function POST(request: NextRequest) {
  const user = await current(request);
  if (!user) return NextResponse.json({ detail: "Sessao expirada." }, { status: 401 });
  try {
    const body = await request.json();
    const command = await queueCommand(user.owner_id, String(body.agent_id || ""), String(body.action || ""), user.email);
    return NextResponse.json(command, { status: 201 });
  } catch (error) {
    return NextResponse.json({ detail: error instanceof Error ? error.message : "Nao foi possivel enviar o comando." }, { status: 422 });
  }
}
