const $ = (selector) => document.querySelector(selector);

const ui = {
  form: $('#installForm'),
  cnpj: $('#cnpj'),
  username: $('#username'),
  password: $('#password'),
  togglePassword: $('#togglePassword'),
  checkButton: $('#checkButton'),
  installButton: $('#installButton'),
  heroStateText: $('#heroStateText'),
  statusMessage: $('#statusMessage'),
  progressBar: $('#progressBar'),
  modal: $('#modal'),
  modalBox: $('#modal .modal'),
  modalTitle: $('#modalTitle'),
  modalMessage: $('#modalMessage'),
  modalIcon: $('#modalIcon'),
};

let environmentReady = false;
let operationRunning = false;
let pollTimer = null;

function backend() {
  return window.go?.installer?.App;
}

function setMode(mode, message) {
  document.body.classList.remove('busy', 'ready', 'error');
  document.body.classList.add(mode);
  ui.heroStateText.textContent = mode === 'busy' ? 'Operação em andamento' : mode === 'error' ? 'Ação necessária' : 'Ambiente preparado';
  ui.statusMessage.textContent = message;
  ui.progressBar.classList.toggle('indeterminate', mode === 'busy');
  if (mode === 'ready') ui.progressBar.style.width = '100%';
  if (mode === 'error') ui.progressBar.style.width = '100%';
}

function setBusy(busy) {
  operationRunning = busy;
  for (const element of [ui.cnpj, ui.username, ui.password, ui.togglePassword, ui.checkButton]) {
    element.disabled = busy;
  }
  ui.installButton.disabled = busy || !environmentReady;
}

function showModal(title, message, error = false) {
  ui.modalTitle.textContent = title;
  ui.modalMessage.textContent = message;
  ui.modalIcon.textContent = error ? '!' : '✓';
  ui.modalBox.classList.toggle('error', error);
  ui.modal.hidden = false;
  $('#modalClose').focus();
}

function formatCNPJ(value) {
  const digits = value.replace(/\D/g, '').slice(0, 14);
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

function fillReport(report) {
  $('#installerVersion').textContent = report.installer_version || '—';
  $('#availableVersion').textContent = report.available_version || 'indisponível';
  $('#integratorVersion').textContent = `${report.integrator_release || '—'} · ${report.integrator_file_version || '—'}`;
  $('#webviewVersion').textContent = report.webview2_version || 'não instalado';
  $('#monitorStatus').textContent = report.monitor || 'não instalado';
  $('#adminStatus').textContent = report.run_as_admin || 'não configurado';
  $('#machineAccount').textContent = `Conta ativa: ${report.interactive_user || 'não identificada'}`;
  $('#targetDirectory').textContent = report.target_dir || '';
  $('#targetDirectory').title = report.target_dir || '';
}

async function waitForBackend() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('A ponte local do instalador não ficou disponível.');
}

async function checkEnvironment() {
  if (operationRunning) return;
  setBusy(true);
  environmentReady = false;
  setMode('busy', 'Verificando conta do Windows, AppData, WebView2 e Agendador...');
  try {
    const report = await backend().CheckEnvironment();
    fillReport(report);
    environmentReady = true;
    setMode('ready', 'Ambiente liberado. Informe os dados e inicie a instalação.');
  } catch (error) {
    environmentReady = false;
    const message = String(error?.message || error || 'Não foi possível verificar o ambiente.');
    setMode('error', 'A verificação encontrou um bloqueio. Consulte a orientação exibida.');
    showModal('Ambiente não liberado', message, true);
  } finally {
    setBusy(false);
  }
}

async function pollState() {
  try {
    const state = await backend().State();
    if (state?.message && operationRunning) ui.statusMessage.textContent = state.message;
  } catch (_) {}
}

async function install(event) {
  event.preventDefault();
  if (!environmentReady || operationRunning) return;
  if (!ui.cnpj.value || !ui.username.value.trim() || !ui.password.value) {
    showModal('Dados incompletos', 'Informe o CNPJ, o login e a senha do Integrador.', true);
    return;
  }
  setBusy(true);
  setMode('busy', 'Iniciando instalação segura...');
  pollTimer = setInterval(pollState, 450);
  try {
    const result = await backend().Install({
      cnpj: ui.cnpj.value,
      username: ui.username.value.trim(),
      password: ui.password.value,
    });
    ui.password.value = '';
    environmentReady = true;
    setMode('ready', 'Instalação concluída e monitoramento ativo.');
    showModal('Instalação concluída', `CNPJ ${result.cnpj} configurado com Mix Fiscal.\n\nMachine ID: ${result.machine_id}\n\nO ID está online, o Integrador foi aberto e o monitor foi instalado.`);
    setBusy(false);
    await checkEnvironment();
  } catch (error) {
    ui.password.value = '';
    const message = String(error?.message || error || 'A instalação não foi concluída.');
    setMode('error', 'A instalação não foi concluída. Revise o diagnóstico.');
    showModal('Erro na instalação', message, true);
  } finally {
    clearInterval(pollTimer);
    pollTimer = null;
    setBusy(false);
  }
}

ui.cnpj.addEventListener('input', () => { ui.cnpj.value = formatCNPJ(ui.cnpj.value); });
ui.togglePassword.addEventListener('click', () => {
  const visible = ui.password.type === 'text';
  ui.password.type = visible ? 'password' : 'text';
  ui.togglePassword.title = visible ? 'Mostrar senha' : 'Ocultar senha';
  ui.togglePassword.setAttribute('aria-label', ui.togglePassword.title);
});
ui.checkButton.addEventListener('click', checkEnvironment);
ui.form.addEventListener('submit', install);
$('#modalClose').addEventListener('click', () => { ui.modal.hidden = true; });
ui.modal.addEventListener('click', event => { if (event.target === ui.modal) ui.modal.hidden = true; });

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await waitForBackend();
    try {
      const updating = await backend().CheckInstallerUpdate();
      if (updating) {
        setMode('busy', 'Abrindo a versão mais recente do instalador...');
        return;
      }
    } catch (_) {
      // Uma falha de atualização não impede o uso do pacote local.
    }
    await checkEnvironment();
  } catch (error) {
    setMode('error', 'O instalador não conseguiu iniciar a ponte local.');
    showModal('Falha ao iniciar', String(error?.message || error), true);
  }
});
