"use client";
import { useEffect, useRef, useState } from "react";
import type { Client } from "./robot-model";

export function useAgentClients(cnpjKey: string, revision: number) {
  const [clients, setClients] = useState<Record<string, Client>>({});
  const cache = useRef(new Map<string, { client: Client; expires: number; revision: number }>());
  useEffect(() => {
    const cnpjs: string[] = JSON.parse(cnpjKey);
    const controller = new AbortController();
    let running = false;
    async function refresh() {
      if (running || controller.signal.aborted) return;
      running = true;
      const queue = cnpjs.filter(cnpj => {
        const entry = cache.current.get(cnpj);
        return !entry || entry.expires <= Date.now() || entry.revision !== revision;
      });
      try {
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length && !controller.signal.aborted) {
            const cnpj = queue.shift()!;
            setClients(previous => ({ ...previous, [cnpj]: previous[cnpj] || { cnpj, client_name: "", retaguarda: "", status: "loading" } }));
            let client: Client;
            try {
              const response = await fetch(`/api/agents/clients?cnpj=${encodeURIComponent(cnpj)}`, {
                cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(55000)]),
              });
              if (response.status === 401) { window.location.href = "/login"; return; }
              const body = await response.json();
              if (!response.ok) throw new Error(body.detail || "Falha na consulta de cadastro.");
              if (body.cnpj !== cnpj || !["loaded", "not_found"].includes(body.status)) throw new Error("Cadastro inválido retornado pela API.");
              client = body as Client;
            } catch (error) {
              if (controller.signal.aborted) return;
              const previous = cache.current.get(cnpj)?.client;
              client = { cnpj, client_name: previous?.client_name || "", retaguarda: previous?.retaguarda || "", status: "error",
                error: error instanceof Error ? error.message : "Falha na consulta de cadastro." };
            }
            if (controller.signal.aborted) return;
            cache.current.set(cnpj, { client, expires: Date.now() + (client.status === "error" ? 60_000 : 300_000), revision });
            setClients(previous => ({ ...previous, [cnpj]: client }));
          }
        }));
      } finally { running = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [cnpjKey, revision]);
  return clients;
}
