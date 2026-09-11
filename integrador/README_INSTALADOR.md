# Instalador automatizado do Integrador

O arquivo entregue ao cliente fica em:

```text
integrador\entrega\Instalador-Mix-Fiscal.exe
```

Crie a pasta definitiva na máquina, por exemplo `C:\Mix Fiscal\integrador`, coloque o setup nela e
abra-o. Ele instala todos os componentes nessa mesma pasta.

## O que ele faz

1. solicita administrador;
2. copia o Integrador, o Painel Mix, o monitor e o atualizador;
3. verifica o WebView2 e instala o Runtime oficial da Microsoft quando estiver ausente;
4. verifica se a conta elevada é a mesma conta conectada e se ela consegue usar AppData, TEMP e o
   Agendador;
5. abre a tela Go/Wails com CNPJ, login e senha protegida por olho;
6. autentica na API e no Integrador;
7. reutiliza o Machine ID local ou gera somente uma vez quando nenhum existir;
8. abre Configurações, confirma o login quando solicitado, informa CNPJ e serviço `mixfiscal`;
9. clica **Salvar Configurações** e depois **Instalar/Iniciar**;
10. instala o monitor pelo `Painel_Mix.bat` sem janela piscando;
11. confirma na API que o ID exato usado pelo robô ficou online;
12. deixa o Integrador aberto e marcado para sempre solicitar administrador.

Os dados de banco e de retaguarda continuam sendo enviados pelo site. O setup não apaga IDs de
XML ou de outras instalações. Se os dois arquivos locais tiverem IDs conflitantes, ele para e
preserva ambos para revisão.

## Nova interface e runtime

A geração `1.2` usa Go + Wails + HTML/CSS/JavaScript, a mesma base técnica do Integrador oficial.
O setup não transporta Python, PyQt, PyInstaller, Playwright ou Node e não extrai um runtime grande
no `%TEMP%`. O bootstrap Go prepara o WebView2 antes de abrir a tela.

Prévia da tela: [`go-installer/docs/preview-installer-go-wails.png`](go-installer/docs/preview-installer-go-wails.png).

Sistemas aceitos pelo setup: Windows 10 x64 build 14393 ou superior, Windows 11 x64 e Windows
Server 2016 ou superior x64. Servidores precisam de uma sessão RDP/console interativa com a mesma
conta que receber a elevação.

## Segurança e diagnóstico

A senha Mix é usada somente em memória e o campo é limpo após o fluxo. A senha do UAC pertence ao
Windows e nunca passa pelo instalador.

O botão de instalar só é liberado quando o pré-diagnóstico confirma a conta, os diretórios e o
Agendador. Logs ficam em:

```text
logs\instalacao.log
logs\diagnostico.json
painel_install_log.txt
atualizador_log.txt
```

O programa não desativa antivírus, EDR, UAC ou política corporativa. A assinatura digital de código
da Mix continua recomendada para reduzir bloqueios por reputação.

## Monitor e manutenção

Abra `Painel_Mix.bat`:

- opção 2: instalar/reativar monitoramento;
- opção 3: iniciar Integrador;
- opção 4: parar Integrador;
- opção 5: desinstalar/desativar monitoramento para manutenção.

O monitor executa invisível a cada cinco minutos, mantém o Integrador ativo e verifica atualizações.

## Atualizações

O monitor atualiza e repara o Integrador, BAT, monitor, VBS e atualizador usando HTTPS, tamanho e
SHA-256. Ao abrir o setup, a tela também consulta se existe um instalador mais recente; se houver,
baixa, valida e abre a nova versão na mesma pasta.

Para gerar uma versão, leia [`PUBLICACAO.md`](PUBLICACAO.md) e use somente:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\integrador\PUBLICAR_ATUALIZACAO.ps1 `
  -Versao 1.2.0 `
  -Executavel "C:\caminho\desktop-integrador.exe"
```

Detalhes completos de arquitetura, permissões, automação e sistema operacional estão em
[`ARQUITETURA_INSTALADOR.md`](ARQUITETURA_INSTALADOR.md).
