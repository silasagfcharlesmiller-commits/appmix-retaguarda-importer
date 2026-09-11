#define MyVersion GetEnv("MIX_SETUP_VERSION")
#define RuntimeDir GetEnv("MIX_SETUP_RUNTIME")
#define SourceDir GetEnv("MIX_SETUP_SOURCE")
#define OutputDir GetEnv("MIX_SETUP_OUTPUT")

[Setup]
AppId={{CA9561A5-0DA0-48D7-A295-F928082366D2}
AppName=Instalador Mix Fiscal
AppVersion={#MyVersion}
AppPublisher=Mix Fiscal
VersionInfoVersion={#MyVersion}.0
DefaultDirName={src}
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
Uninstallable=no
PrivilegesRequired=admin
MinVersion=10.0.14393
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir={#OutputDir}
OutputBaseFilename=Instalador-Mix-Fiscal
CloseApplications=no
AllowUNCPath=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "{#RuntimeDir}\*"; DestDir: "{app}\.mix-installer"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\desktop-integrador.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\Painel_Mix.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\atualizador_mix.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\monitor_mix.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\run_silent.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\integrador_version.json"; DestDir: "{app}"; Flags: ignoreversion

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Parameters: String;
begin
  if CurStep = ssPostInstall then
  begin
    Parameters := '--install-dir "' + ExpandConstant('{app}') + '"';
    if not Exec(
      ExpandConstant('{app}\.mix-installer\MixFiscal-Bootstrap.exe'),
      Parameters,
      ExpandConstant('{app}'),
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    ) then
      RaiseException('O bootstrap do WebView2 não pôde ser iniciado.');
    if ResultCode <> 0 then
      RaiseException('O WebView2 não ficou pronto. Consulte os diagnósticos da instalação.');

    if not WizardSilent then
      if not Exec(
        ExpandConstant('{app}\.mix-installer\Instalador-Mix-Fiscal-App.exe'),
        Parameters,
        ExpandConstant('{app}'),
        SW_SHOWNORMAL,
        ewNoWait,
        ResultCode
      ) then
        RaiseException('A interface do Instalador Mix Fiscal não pôde ser iniciada.');
  end;
end;
