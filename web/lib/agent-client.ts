import "server-only";
import { credentialBearer } from "@/lib/credentials";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (...values: unknown[]) => values.map(value => {
  if (typeof value === "string") return value.trim();
  const item = record(value);
  return typeof item.nome === "string" ? item.nome.trim() : typeof item.name === "string" ? item.name.trim() : "";
}).find(Boolean)?.slice(0, 180) || "";

export function parseAgentClient(payload: unknown, cnpj: string) {
  const data = record(record(payload).data);
  const client = record(data.clientes_mxf_cmf);
  if (String(client.cli_cnpj || "").replace(/\D/g, "") !== cnpj)
    throw new Error("O cadastro retornado não corresponde ao CNPJ solicitado.");
  return {
    cnpj,
    client_name: label(client.cli_nome, data.cmf_cli_nome),
    retaguarda: label(data.retaguarda, client.retaguarda, data.cli_retaguarda, client.cli_retaguarda, data.cmf_cli_retaguarda),
  };
}

export async function getAgentClient(ownerId: number, cnpj: string) {
  const request = async (refresh = false) => fetch(
    `https://api.mixfiscal.com.br/cmf/v1/panel/costumer?cli_cnpj=${encodeURIComponent(cnpj)}`,
    { headers: { Authorization: `Bearer ${await credentialBearer(ownerId, refresh)}`, Accept: "application/json" },
      cache: "no-store", signal: AbortSignal.timeout(12000) },
  );
  let response = await request();
  if (response.status === 401) response = await request(true);
  if (response.status === 404) return { cnpj, client_name: "", retaguarda: "", status: "not_found" as const };
  if (!response.ok) throw new Error("Consulta de cadastro indisponível no App Mix.");
  const payload: unknown = await response.json();
  if (record(payload).data === null) return { cnpj, client_name: "", retaguarda: "", status: "not_found" as const };
  return { ...parseAgentClient(payload, cnpj), status: "loaded" as const };
}
