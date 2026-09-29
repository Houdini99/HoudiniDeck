; The Windows installer for HoudiniDeck (Inno Setup 6). It brings its own Node.js, so nothing else
; needs to be installed. Build it with build.ps1 next to this file; CI does that in
; .github/workflows/windows-installer.yml. Keep this file ASCII.
;
; The program goes to Program Files; the deck's data (deck, settings, images, .env) lives in
; %LOCALAPPDATA%\HoudiniDeck, so updates keep it. The uninstaller asks before deleting that
; (or deletes it without asking when run with /PURGEDATA).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #error Build with build.ps1, which prepares the files and sets StageDir
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

#define AppName "HoudiniDeck"

[Setup]
; Never change AppId: Windows recognizes updates and the uninstaller by it.
AppId={{ED93638B-60CA-42FE-852B-8032525DB212}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Houdini99
AppPublisherURL=https://github.com/Houdini99/HoudiniDeck
AppSupportURL=https://github.com/Houdini99/HoudiniDeck/issues
AppComments=A Stream Deck for OBS that runs in the browser
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
; Program Files and the firewall rule need administrator rights.
PrivilegesRequired=admin
UsedUserAreasWarning=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile=..\..\..\LICENSE
SetupIconFile=app-icon.ico
UninstallDisplayIcon={app}\app-icon.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
OutputDir={#OutputDir}
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
; The installer stops a running deck itself (see PrepareToInstall below).
CloseApplications=no

[Tasks]
Name: "firewall"; Description: "Let phones and tablets on my home network connect (Windows Firewall, private networks only)"
Name: "autostart"; Description: "Start HoudiniDeck when I log in (in a minimized window)"; Flags: unchecked
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Updates start from a clean program folder, so files an older version had don't linger.
Type: filesandordirs; Name: "{app}\app"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "HoudiniDeck.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "stop-deck.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "app-icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\HoudiniDeck.cmd"; Parameters: "--open"; WorkingDir: "{app}"; IconFilename: "{app}\app-icon.ico"; Comment: "Start the deck and open it in the browser"
Name: "{autoprograms}\{#AppName} data folder"; Filename: "{app}\HoudiniDeck.cmd"; Parameters: "--data"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 3; Flags: runminimized; Comment: "Your deck, settings, images and .env file"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\HoudiniDeck.cmd"; Parameters: "--open"; WorkingDir: "{app}"; IconFilename: "{app}\app-icon.ico"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\HoudiniDeck.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\app-icon.ico"; Flags: runminimized; Tasks: autostart

[Run]
; An older rule goes first, so updates don't pile them up (and unticking the task removes it).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#AppName}"" dir=in action=allow program=""{app}\node.exe"" enable=yes profile=private"; Flags: runhidden; Tasks: firewall
Filename: "{app}\HoudiniDeck.cmd"; Parameters: "--open"; WorkingDir: "{app}"; Description: "Start HoudiniDeck now"; Flags: postinstall nowait skipifsilent runasoriginaluser shellexec
; The deck's own updates run this silently with /STARTDECK: start it again (open browsers reconnect by themselves).
Filename: "{app}\HoudiniDeck.cmd"; WorkingDir: "{app}"; Flags: nowait runasoriginaluser shellexec runminimized; Check: HasParam('/STARTDECK')

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden; RunOnceId: "DeleteFirewallRule"

[Code]
// A running deck holds its files open: stop it (its Node.js and the window it runs in) first.
procedure StopDeck(const Script: String);
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script + '" -AppDir "' + ExpandConstant('{app}') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  ExtractTemporaryFile('stop-deck.ps1');
  StopDeck(ExpandConstant('{tmp}\stop-deck.ps1'));
  Result := '';
end;

function HasParam(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then
      Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usUninstall then
    StopDeck(ExpandConstant('{app}\stop-deck.ps1'));
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\{#AppName}');
    if DirExists(DataDir) then
      if HasParam('/PURGEDATA') or
        (SuppressibleMsgBox('Also delete your deck, settings and uploaded images?' + #13#10#13#10 + DataDir + #13#10#13#10 +
          'Keep them to pick up where you left off if you install HoudiniDeck again.',
          mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES) then
        DelTree(DataDir, True, True, True);
  end;
end;
