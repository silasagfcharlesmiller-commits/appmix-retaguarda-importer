"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Copy, Database, Play, Search } from "lucide-react";

type QueryTable = { key: string; group: string; type: "VIEW" | "TMP"; name: string };
type MachineOption = { machine_id: string; status: string; online: boolean; label: string; dialect: string };
type Options = { cnpj: string; machine_id: string; machines?: MachineOption[]; dialect: string; tables: QueryTable[]; catalog_tables: QueryTable[]; recommended_tables?: string[]; template_nome: string; max_rows: number };
type Result = { columns: string[]; rows: Record<string, unknown>[]; count: number; limited: boolean; elapsed_ms: number };

const formatCnpj = (value: string) => value.replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const words = ["SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "AND", "OR", "ORDER BY", "GROUP BY", "HAVING", "DISTINCT", "AS", "WITH", "UNION ALL", "IS NULL", "IS NOT NULL"];

export default function ConsultaSqlPage() {
  const [cnpj, setCnpj] = useState("");
  const [options, setOptions] = useState<Options>();
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsHidden, setSuggestionsHidden] = useState(false);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [machineChoices, setMachineChoices] = useState<MachineOption[]>([]);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  const selectedTables = (options?.tables || []).filter((table) => selectedNames.includes(table.name));

  const token = sql.match(/([A-Za-z_][\w$]*)$/)?.[1] || "";
  const suggestions = useMemo(() => token && !suggestionsHidden
    ? [...words, ...((options?.catalog_tables || options?.tables || []).map((table) => table.name))].filter((item) => item.toLowerCase().startsWith(token.toLowerCase()) && item.toLowerCase() !== token.toLowerCase()).slice(0, 10)
    : [], [token, suggestionsHidden, options]);

  async function locate(event?: FormEvent, selectedMachine = "") {
    event?.preventDefault(); setError(""); setResult(undefined); setOptions(undefined); setSql(""); setSelectedNames([]);
    const normalized = cnpj.replace(/\D/g, "");
    if (normalized.length !== 14) return setError("Informe um CNPJ com 14 dígitos.");
    setLoading(true);
    try {
      let response: Response; let body: (Partial<Options> & { detail?: string; pending?: boolean; machines?: MachineOption[] }) = {};
      for (let attempt = 0; ; attempt += 1) {
        const params = new URLSearchParams({ cnpj: normalized });
        if (selectedMachine) params.set("machine_id", selectedMachine);
        response = await fetch(`/api/mix/v1/consulta-sql/opcoes?${params}`, { cache: "no-store" });
        body = await response.json().catch(() => ({}));
        if (response.status !== 202 || attempt >= 20) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (!response.ok) { setMachineChoices(Array.isArray(body.machines) ? body.machines : []); return setError(body.detail || "Não foi possível localizar a máquina do cliente."); }
      setMachineChoices([]);
      setOptions(body as Options); setCnpj(normalized);
      const available = new Set((body.tables || []).map((table: QueryTable) => table.name));
      const automatic = Array.isArray(body.recommended_tables) ? body.recommended_tables.filter((name: unknown): name is string => typeof name === "string" && available.has(name)).slice(0, 8) : [];
      setSelectedNames(automatic);
    } finally { setLoading(false); }
  }

  function applySuggestion(value: string) { setSql((current) => current.replace(/([A-Za-z_][\w$]*)$/, `${value} `)); setSuggestionIndex(0); }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setSuggestionIndex((value) => (value + 1) % suggestions.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setSuggestionIndex((value) => (value - 1 + suggestions.length) % suggestions.length); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); applySuggestion(suggestions[Math.min(suggestionIndex, suggestions.length - 1)]); }
    else if (event.key === "Escape") { event.preventDefault(); setSuggestionsHidden(true); }
  }
  function count(type?: "VIEW" | "TMP") {
    const tables = selectedTables.filter((table) => !type || table.type === type);
    if (!tables.length) return setError("Selecione as tabelas atuais do cliente antes de montar a consulta.");
    setError("");
    setSql(tables.map((table) => `SELECT '${table.name.replace(/'/g, "''")}' AS TABELA, COUNT(*) AS TOTAL_LINHAS FROM ${table.name}`).join("\nUNION ALL\n"));
  }
  function tableGroup(table: QueryTable) {
    const name = table.name.toLowerCase();
    if (name.includes("pis_cofins")) return "PIS / COFINS";
    if (name.includes("icms_entrada")) return "ICMS Entrada";
    if (name.includes("icms_saida") || name.endsWith("mxf_vw_icms")) return "ICMS Saída";
    if (name.includes("ibs") || name.includes("cbs")) return "IBS / CBS";
    return table.name;
  }
  function previewQuery(tableName: string) {
    const dialect = (options?.dialect || "").toLowerCase();
    if (dialect.includes("firebird") || dialect.includes("interbase")) return `SELECT FIRST 10 * FROM ${tableName}`;
    if (dialect.includes("oracle") || dialect.includes("db2")) return `SELECT * FROM ${tableName} FETCH FIRST 10 ROWS ONLY`;
    return `SELECT * FROM ${tableName} LIMIT 10`;
  }
  function compare() {
    const dialect = (options?.dialect || "").toLowerCase();
    const dummyFrom = dialect.includes("firebird") || dialect.includes("interbase")
      ? "\nFROM RDB$DATABASE"
      : dialect.includes("oracle")
        ? "\nFROM DUAL"
        : dialect.includes("db2")
          ? "\nFROM SYSIBM.SYSDUMMY1"
          : "";
    const groups = [...new Set(selectedTables.map(tableGroup))];
    if (!selectedTables.length) return setError("Selecione as tabelas atuais do cliente antes de comparar.");
    const invalidGroup = groups.find((group) => selectedTables.filter((table) => tableGroup(table) === group && table.type === "VIEW").length !== 1 || selectedTables.filter((table) => tableGroup(table) === group && table.type === "TMP").length !== 1);
    if (invalidGroup) return setError(`Selecione exatamente uma VIEW e uma TMP para ${invalidGroup}.`);
    setSql(groups.flatMap((group) => {
      const view = selectedTables.find((table) => tableGroup(table) === group && table.type === "VIEW")!;
      const tmp = selectedTables.find((table) => tableGroup(table) === group && table.type === "TMP")!;
      return [`SELECT '${group.replace(/'/g, "''")}' AS GRUPO,
  (SELECT COUNT(*) FROM ${view.name}) AS TOTAL_VIEW,
  (SELECT COUNT(*) FROM ${tmp.name}) AS TOTAL_TMP,
  ((SELECT COUNT(*) FROM ${view.name}) - (SELECT COUNT(*) FROM ${tmp.name})) AS DIFERENCA_LINHAS,
  CASE WHEN (SELECT COUNT(*) FROM ${view.name}) = (SELECT COUNT(*) FROM ${tmp.name}) THEN 'CONTAGEM IGUAL' ELSE 'VOLUMES DIFERENTES' END AS STATUS${dummyFrom}`];
    }).join("\nUNION ALL\n"));
    setError("");
  }
  async function execute() {
    if (!options || !sql.trim()) return; setLoading(true); setError(""); setResult(undefined);
    try {
      const response = await fetch(`/api/mix/v1/consulta-sql/executar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cnpj: options.cnpj, machine_id: options.machine_id, sql }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return setError(body.detail || "A consulta remota falhou.");
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const columns = Array.isArray(body.columns) ? body.columns.map(String) : rows.length && rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]) : [];
      setResult({ columns, rows, count: Number.isFinite(Number(body.count)) ? Number(body.count) : rows.length, limited: Boolean(body.limited), elapsed_ms: Number.isFinite(Number(body.elapsed_ms)) ? Number(body.elapsed_ms) : 0 });
    } catch (failure) {
      setError(failure instanceof Error ? `Falha ao executar a consulta: ${failure.message}` : "Falha de comunicação ao executar a consulta.");
    } finally { setLoading(false); }
  }

  return <main className="standalone-sql-page">
    <header><a href="/painel"><ArrowLeft size={18} /> Voltar ao painel</a><div><span className="eyebrow dark">ACESSO RÁPIDO PELO ROBÔ</span><h1>Consulta SQL do cliente</h1><p>Informe o CNPJ. O App Mix encontra a máquina ativa e usa a conexão principal do robô, sem solicitar a senha do banco.</p></div></header>
    <form className="standalone-cnpj-search" onSubmit={locate}><label>CNPJ<input value={cnpj} onChange={(event) => setCnpj(event.target.value)} placeholder="00.000.000/0000-00" inputMode="numeric" /></label><button className="primary-button" disabled={loading}><Search size={17} /> {loading && !options ? "Localizando..." : "Localizar cliente"}</button></form>
    {error && <div className="operation-warning"><AlertTriangle size={19} /><span><strong>Não foi possível concluir</strong><small>{error}</small></span></div>}
    {machineChoices.length > 0 && <section className="standalone-query-workspace"><div className="sql-count-actions"><strong>Escolha o robô desta filial:</strong>{machineChoices.map((machine) => <button type="button" key={machine.machine_id} disabled={!machine.online || loading} onClick={() => void locate(undefined, machine.machine_id)}>{machine.label} — {machine.machine_id.slice(0,12)}... — {machine.online ? "Online" : `Offline (${machine.status})`}</button>)}</div></section>}
    {options && <section className="standalone-query-workspace">
      <div className="sql-query-meta"><span>CNPJ: <b>{formatCnpj(options.cnpj)}</b></span><span>Referência: <b>{options.template_nome}</b></span><span>Machine ID: <b>{options.machine_id.slice(0, 12)}...</b></span><span>Banco: <b>{options.dialect}</b></span></div>
      <div className="sql-query-meta"><span><b>{selectedNames.length}/8 tabelas atuais.</b> Os pares VIEW/TMP são identificados no catálogo real do banco, com suporte a Firebird, PostgreSQL, Oracle, MySQL, MariaDB e DB2.</span></div>
      <div className="sql-count-actions"><strong>Consultas rápidas:</strong><button type="button" disabled={!selectedNames.length} onClick={compare}>Contar e comparar</button><button type="button" disabled={!selectedNames.length} onClick={() => count("VIEW")}>Contar VIEWs</button><button type="button" disabled={!selectedNames.length} onClick={() => count("TMP")}>Contar TMPs</button></div>
      <div className="sql-table-shortcuts">{options.tables.filter((table) => selectedNames.includes(table.name)).slice(0,8).map((table) => <article key={table.key} className={`${table.type === "VIEW" ? "view" : "tmp"} selected`}><span>{tableGroup(table)} - {table.type}</span><code>{table.name}</code><div><button type="button" onClick={() => void navigator.clipboard.writeText(table.name)}><Copy size={14} /> Copiar</button><button type="button" onClick={() => setSql(previewQuery(table.name))}>Consultar 10</button></div></article>)}</div>
      <label className="sql-editor-label">SQL <small>Use ↑/↓ e Enter ou Tab para aceitar o autocomplete.</small><textarea className="sql-editor" rows={10} value={sql} spellCheck={false} onKeyDown={keyDown} onChange={(event) => { setSql(event.target.value); setSuggestionIndex(0); setSuggestionsHidden(false); }} /></label>
      {suggestions.length > 0 && <div className="sql-suggestions">{suggestions.map((suggestion, index) => <button type="button" className={index === suggestionIndex ? "active" : ""} key={suggestion} onClick={() => applySuggestion(suggestion)}>{suggestion}<small>{index === suggestionIndex ? "Enter" : ""}</small></button>)}</div>}
      <div className="sql-query-actions"><small>Somente SELECT/WITH nas tabelas confirmadas. Máximo de 10 linhas, adaptado automaticamente ao banco.</small><button type="button" className="primary-button" disabled={loading || !sql.trim()} onClick={() => void execute()}><Play size={16} /> {loading ? "Consultando..." : "Executar consulta"}</button></div>
      {result && <div className="sql-result sql-result-focus" ref={resultRef}><div><strong>{result.count.toLocaleString("pt-BR")} linha(s)</strong><small>Consulta concluída em {result.elapsed_ms.toLocaleString("pt-BR")} ms</small></div><div className="sql-result-table"><table><thead><tr><th className="sql-row-number">#</th>{result.columns.map((column) => <th key={column}>{column.replaceAll("_", " ")}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index} className={Number(row.DIFERENCA_LINHAS || 0) !== 0 ? "sql-divergent-row" : "sql-equal-row"}><td className="sql-row-number">{index + 1}</td>{result.columns.map((column) => { const value = row[column]; return <td key={column} className={typeof value === "number" ? "sql-number" : ""} title={value == null ? "NULL" : String(value)}>{value == null ? <span className="sql-null">NULL</span> : typeof value === "number" ? value.toLocaleString("pt-BR", { maximumFractionDigits: 10 }) : typeof value === "object" ? JSON.stringify(value) : String(value)}</td>; })}</tr>)}</tbody></table></div></div>}
    </section>}
  </main>;
}
