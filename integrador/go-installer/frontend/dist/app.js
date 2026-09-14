const $ = selector => document.querySelector(selector);
const backend = () => window.go?.installer?.App;
let environmentReady = false, operationRunning = false, latestReport = null;
const labels = ['Administrador', 'Conta do Windows', 'Pastas e credencial protegida', 'Agendador de Tarefas', 'WebView2', 'Antivírus e proteção', 'API do site (ida e volta)'];

function setMode(mode, message) {
  document.body.classList.remove('busy', 'ready', 'error'); document.body.classList.add(mode);
  $('#heroStateText').textContent = mode === 'busy' ? 'Operação em andamento' : mode === 'error' ? 'Ação necessária' : 'Verificação concluída';
  $('#statusMessage').textContent = message;
  $('#progressBar').classList.toggle('indeterminate', mode === 'busy');
  if (mode !== 'busy') $('#progressBar').style.width = '100%';
}
function setBusy(busy) {
  operationRunning = busy;
  for (const id of ['cnpj','username','password','togglePassword','checkButton','prepareButton','defenderExclusion']) $('#'+id).disabled = busy;
  $('#installButton').disabled = busy || !environmentReady;
  $('#agentOnlyButton').disabled = busy;
}
function showModal(title, message, error = false) {
  $('#modalTitle').textContent = title; $('#modalMessage').textContent = message;
  $('#modalIcon').textContent = error ? '!' : '✓'; $('#modal .modal').classList.toggle('error', error);
  $('#modal').hidden = false; $('#modalClose').focus();
}
function renderChecks(checks = []) {
  $('#checks').replaceChildren();
  labels.forEach((label, index) => {
    const check = checks[index] || {label, status:'pending', message:'Aguardando verificação'};
    const row = document.createElement('li'); row.className = `check-${check.status}`;
    const title = document.createElement('strong');
    title.textContent = `${({ok:'✓',error:'✕',warning:'!',pending:'○'})[check.status] || '○'} ${index+1}. ${check.label}`;
    const detail = document.createElement('span'); detail.textContent = check.message;
    row.append(title, detail); $('#checks').append(row);
  });
}
function reportText(report = latestReport) {
  if (!report) return 'O relatório estará disponível ao finalizar a verificação.';
  return (report.checks || []).map((c,i) => `${i+1}. ${c.label} — ${c.status === 'ok' ? 'APROVADO' : c.status === 'error' ? 'BLOQUEIO CONFIRMADO' : 'PENDENTE / ATENÇÃO'}\n${c.message}`).join('\n\n') + (report.warning ? '\n\nPendência da instalação:\n'+report.warning : '') + (report.preparation?.length ? '\n\nPreparação do Windows:\n' + report.preparation.join('\n') : '') + `\n\nRelatório salvo para a TI:\n${report.diagnostic || 'aguardando gravação'}`;
}
function fillReport(report) {
  latestReport = report; renderChecks(report.checks);
  const facts = {installerVersion:'installer_version',availableVersion:'available_version',webviewVersion:'webview2_version',monitorStatus:'monitor',adminStatus:'run_as_admin'};
  for (const [id,key] of Object.entries(facts)) $('#'+id).textContent = report[key] || '—';
  $('#integratorVersion').textContent = `${report.integrator_release || '—'} · ${report.integrator_file_version || '—'}`;
  $('#machineAccount').textContent = `Conta ativa: ${report.interactive_user || 'não identificada'}`;
  $('#targetDirectory').textContent = report.target_dir || ''; $('#targetDirectory').title = report.target_dir || '';
}
async function checkEnvironment() {
  if (operationRunning) return;
  environmentReady = false; setBusy(true); renderChecks();
  setMode('busy','Executando os sete testes e reunindo os resultados...');
  try {
    const report = await backend().CheckEnvironment(); fillReport(report); environmentReady = report.ready;
    setMode(report.ready ? 'ready' : 'error', report.ready ? 'Sete testes concluídos. O teste 7 confirmou o sinal e a resposta da API do site antes da instalação.' : 'Há bloqueios confirmados. Confira todos os testes e o relatório para a TI.');
    if (!report.ready) showModal('Relatório do ambiente', reportText(report), true);
  } catch (error) { setMode('error','Diagnóstico indisponível'); showModal('Diagnóstico indisponível',String(error?.message || error),true); }
  finally { setBusy(false); }
}
async function install(event, agentOnly = false) {
  event?.preventDefault(); if (operationRunning) return;
  if (!$('#cnpj').value || !$('#username').value.trim() || !$('#password').value) { showModal('Dados incompletos','Informe o CNPJ, o login e a senha do Integrador.',true); return; }
  if (agentOnly) {
    try { const selected = await backend().SelectExistingIntegrator(); if (!selected) return; await checkEnvironment(); }
    catch (error) { showModal('Seleção do Integrador',String(error?.message || error),true); return; }
  }
  if (!environmentReady) return;
  setBusy(true); setMode('busy',agentOnly ? 'Instalando Agente e Painel...' : 'Instalando todos os componentes...');
  const poll = setInterval(async () => { try { const state = await backend().State(); if (state?.message) $('#statusMessage').textContent = state.message; } catch (_) {} },700);
  try {
    const result = await backend().Install({cnpj:$('#cnpj').value,username:$('#username').value.trim(),password:$('#password').value,agent_only:agentOnly});
    latestReport = {...latestReport,checks:result.checks,diagnostic:result.diagnostic,warning:result.warning}; renderChecks(result.checks);
    const complete = result.agent_verified && !result.warning;
    setMode(complete ? 'ready' : 'error',complete ? 'Instalação concluída; início e reinício confirmados pela API.' : 'Instalado com pendência. Confira as orientações no relatório.');
    showModal(complete ? 'Instalação e controle confirmados' : 'Instalado com pendência',`CNPJ: ${result.cnpj}\nMachine ID: ${result.machine_id}\n\n${result.warning || 'O serviço recebeu e executou início e reinício pela API.'}\n\n${reportText()}`,!complete);
  } catch (error) {
    try { latestReport = await backend().LastReport(); renderChecks(latestReport.checks); } catch (_) {}
    setMode('error','A instalação encontrou um bloqueio. Confira o relatório completo.');
    showModal('Relatório da instalação',`${String(error?.message || error)}\n\n${reportText()}`,true);
  } finally { $('#password').value = ''; clearInterval(poll); setBusy(false); }
}
$('#prepareButton').addEventListener('click',async () => {
  if (operationRunning) return; setBusy(true); setMode('busy','Preparando as pastas e executando os testes...');
  try { const report = await backend().PrepareWindows($('#defenderExclusion').checked); fillReport(report); environmentReady = report.ready; setMode(report.ready ? 'ready' : 'error','Preparação finalizada. Confira o relatório.'); showModal('Resultado da preparação',reportText(report),!report.ready); }
  catch (error) { showModal('Preparação não concluída',String(error?.message || error),true); }
  finally { setBusy(false); }
});
$('#cnpj').addEventListener('input',() => { $('#cnpj').value = $('#cnpj').value.replace(/\D/g,'').slice(0,14).replace(/^(\d{2})(\d)/,'$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/,'$1.$2.$3').replace(/\.(\d{3})(\d)/,'.$1/$2').replace(/(\d{4})(\d)/,'$1-$2'); });
$('#togglePassword').addEventListener('click',() => { $('#password').type = $('#password').type === 'text' ? 'password' : 'text'; });
$('#checkButton').addEventListener('click',checkEnvironment);
$('#agentOnlyButton').addEventListener('click',event => install(event,true));
$('#installForm').addEventListener('submit',event => install(event));
$('#reportButton').addEventListener('click',() => showModal('Relatório completo para a TI',reportText()));
$('#modalClose').addEventListener('click',() => { $('#modal').hidden = true; });
$('#modal').addEventListener('click',event => { if (event.target === $('#modal')) $('#modal').hidden = true; });
window.addEventListener('DOMContentLoaded',async () => {
  renderChecks(); setBusy(true);
  try {
    for (let i=0; !backend() && i<100; i++) await new Promise(resolve => setTimeout(resolve,50));
    if (!backend()) throw new Error('A ponte local do instalador não ficou disponível.');
    try { if (await backend().CheckInstallerUpdate()) { setMode('busy','Abrindo a versão mais recente do instalador...'); return; } } catch (_) {}
    setBusy(false); await checkEnvironment();
  } catch (error) { setBusy(false); setMode('error','Falha ao iniciar'); showModal('Falha ao iniciar',String(error?.message || error),true); }
});
