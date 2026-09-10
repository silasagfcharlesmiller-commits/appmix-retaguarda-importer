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

[Run]
Filename: "{app}\.mix-installer\Instalador-Mix-Fiscal-App.exe"; Parameters: "--install-dir ""{app}"""; WorkingDir: "{app}"; Flags: nowait skipifsilent
