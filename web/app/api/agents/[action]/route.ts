import { NextRequest, NextResponse } from "next/server";
import { acceptHeartbeat, authenticateAgent, completeCommand, registerAgent } from "@/lib/agent-control";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (action === "enroll") {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
      return NextResponse.json(await registerAgent(body, bearer), { status: 201 });
    }
    const agent = await authenticateAgent(
      request.headers.get("x-mix-agent-id") || "",
      request.headers.get("x-mix-agent-token") || "",
    );
    if (!agent) return NextResponse.json({ detail: "Agente nao autorizado." }, { status: 401 });
    if (action === "heartbeat") return NextResponse.json(await acceptHeartbeat(agent, body));
    if (action === "result") return NextResponse.json(await completeCommand(agent, body));
    return NextResponse.json({ detail: "Operacao inexistente." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ detail: error instanceof Error ? error.message : "Falha na API do Agente." }, { status: 422 });
  }
}
