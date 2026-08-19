# Manual de instalação do App Mix em outra máquina

## 1. Preparar a pasta para copiar

Na máquina de desenvolvimento, abra o PowerShell dentro da pasta do projeto e execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\preparar_pasta_teste.ps1
```

Será criada a pasta `pacote_teste` com os arquivos necessários.

O preparador inclui `config_mix.json`, que contém credenciais. Proteja a pasta e confira os dados antes de entregá-la a outra pessoa.

Não são copiados:

- `.venv` ou `.venv-1`;
- `playwright-profile` e sua sessão pessoal;
- `playwright-browsers`;
- logs, screenshots, executáveis antigos e arquivos de backup.

## 2. Copiar para a máquina virtual

Copie a pasta `pacote_teste` inteira para a máquina virtual. Renomeá-la é permitido.

A máquina virtual precisa ter:

- Windows 10 ou superior;
- Python 3.11 ou superior;
- internet durante a primeira instalação;
- acesso ao banco PostgreSQL e ao portal Mix Fiscal.

Para conferir o Python:

```powershell
py --version
```

Se `py` não existir, tente:

```powershell
python --version
```

## 3. Primeira execução pela interface

### Opção automática — arquivo BAT

Clique duas vezes em `INSTALAR_LIMPO.bat` ou execute:

```bat
INSTALAR_LIMPO.bat
```

Digite `INSTALAR` quando solicitado. O BAT apaga somente `.venv`, `playwright-browsers`, `playwright-profile`, `__pycache__`, `erros_automacao` e `worker_mix.log` dentro da pasta atual. Em seguida instala tudo novamente e abre a interface. O login anterior será removido.

### Opção PowerShell

Abra o PowerShell dentro da pasta copiada e execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\primeira_execucao.ps1 -Modo interface
```

O processo criará `.venv`, instalará as bibliotecas e baixará o Chromium local. Na primeira vez isso pode demorar alguns minutos.

Entre com o usuário que será utilizado na máquina virtual. A sessão será gravada em um novo `playwright-profile` pertencente a esse usuário.

Não copie seu `playwright-profile` pessoal para outro login.

## 4. Testar a automação pela interface

1. Confirme a conexão na aba de banco.
2. Selecione um template.
3. Adicione um CNPJ de teste.
4. Marque a opção de mostrar o navegador.
5. Inicie a automação.
6. Confira no log `8/8 tabelas` e depois `Configurações salvas`.
7. Feche completamente a interface antes de iniciar o worker.

O botão **Inserir Nome Empresa** adiciona `{nome_empresa}` ao template. Durante a execução, `Empresa da Empresa Variável` será substituído por `empresa_da_empresa_variavel`.

## 5. Primeira execução do worker

No PowerShell, dentro da mesma pasta:

```powershell
powershell -ExecutionPolicy Bypass -File .\primeira_execucao.ps1 -Modo worker
```

O worker abre em headless por padrão e reutiliza as bibliotecas, o Chromium e a sessão preparados anteriormente.

Para testar o worker com navegador visível:

```powershell
$env:WORKER_HEADLESS = "false"
.\.venv\Scripts\python.exe .\worker_mix.py
```

Para voltar ao headless:

```powershell
Remove-Item Env:WORKER_HEADLESS -ErrorAction SilentlyContinue
.\.venv\Scripts\python.exe .\worker_mix.py
```

## 6. Execuções seguintes

Interface:

```powershell
.\.venv\Scripts\python.exe .\appmix.pyw
```

Worker:

```powershell
.\.venv\Scripts\python.exe .\worker_mix.py
```

Também é possível continuar usando `primeira_execucao.ps1`; ele não reinstala o que já estiver atualizado.

## 7. Arquivos obrigatórios na pasta

```text
appmix.pyw
worker_mix.py
automacao_core.py
automacao_login.py
automacao_tabela.py
automacao_compara_divergencia.py
comparar_divergencia_widget.py
database.py
mapeamento_portal_mix.json
mapeamento_configuracoes.json
requirements.txt
primeira_execucao.ps1
INSTALAR_LIMPO.bat
config_mix.json
```

Arquivos recomendados:

```text
cache_modais.json
README.md
MANUAL_INSTALACAO.md
```

## 8. Resultado esperado

Durante a automação:

```text
Resumo: 8/8 tabelas preenchidas com sucesso.
Acessando a área de 'Configuração' do cliente...
Formulário de Configuração aberto para edição.
Configurações salvas...
```

Se ocorrer erro, consulte `erros_automacao` e, no worker, `worker_mix.log`.

## 9. Cuidados

- Não abra interface e worker ao mesmo tempo.
- Não compartilhe `config_mix.json` publicamente.
- Não apague `playwright-profile` depois de salvar o login da máquina virtual.
- Não apague `playwright-browsers`, senão o Chromium será baixado novamente.
