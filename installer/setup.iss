; Inno Setup Script for Jinx - 3D Anime AI Companion
; Produces a modern, lightweight Windows Setup executable

#define MyAppName "Jinx - 3D Anime AI Companion"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Jinx AI Team"
#define MyAppURL "https://github.com/hm831989-bot/anime-companion"
#define MyAppExeName "Jinx.exe"

[Setup]
AppId={{8F8B70A2-0266-4F15-B61E-7D472D437A91}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\Jinx Anime Companion
DefaultGroupName=Jinx Anime Companion
AllowNoIcons=yes
OutputDir=..\release\installer
OutputBaseFilename=Jinx-Companion-Setup-v1.0.0
SetupIconFile=..\build\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "Wake Jinx on Windows boot (Start automatically when your PC turns on)"; GroupDescription: "Companion Behavior:"

[Files]
Source: "..\release\portable\Jinx\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "JinxAnimeCompanion"; ValueData: """{app}\{#MyAppExeName}"" --tray"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
