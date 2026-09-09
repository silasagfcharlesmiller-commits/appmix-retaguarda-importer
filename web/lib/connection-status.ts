export type ConnectionJobStatus =
  | "pendente"
  | "pausado"
  | "processando"
  | "concluido"
  | "erro"
  | "cancelado";

export function connectionStatus(status: ConnectionJobStatus, etapa = "") {
  const validadaPeloRobo = /conex[aã]o validada via rob[oô]/i.test(etapa);
  if (status === "concluido" && validadaPeloRobo)
    return { label: "Ativo", className: "active", title: "Conexão consultada e validada via robô. Clique para verificar novamente." };
  if (status === "concluido")
    return { label: "Verificar", className: "unknown", title: "O trabalho terminou, mas ainda não há validação registrada via robô. Clique para testar." };
  if (status === "erro")
    return { label: "Inativo", className: "inactive", title: "A última consulta no cliente falhou. Clique para verificar novamente." };
  if (status === "processando")
    return { label: "Verificando", className: "checking", title: "O worker está consultando a conexão no cliente." };
  if (status === "pendente")
    return { label: "Aguardando", className: "waiting", title: "A consulta da conexão está aguardando o worker." };
  if (status === "pausado")
    return { label: "Pausado", className: "waiting", title: "A consulta da conexão está pausada." };
  return { label: "Não verificado", className: "unknown", title: "A conexão não foi confirmada no cliente. Clique para verificar." };
}
