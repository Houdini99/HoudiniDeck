# The deck's helper on Windows: the default speakers and microphone (Core Audio), key presses
# (SendInput), media players (the media sessions Windows shows next to its volume slider) and
# sound clips for Play Sound buttons (winmm's MCI).
# The server starts one copy (see helper.ts) and talks to it in JSON lines: requests on stdin,
# answers and media updates on stdout.
#
# Runs in Windows PowerShell 5.1, which every Windows 10/11 has; PowerShell 7 can't use the media
# API. Keep this file ASCII: 5.1 reads a script without a byte order mark in the ANSI code page.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace HoudiniDeck
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    // Only the methods up to the last one used are declared; the order must match the vtable.
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void NotUsed_EnumAudioEndpoints();
        void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpointVolume);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        void NotUsed_RegisterControlChangeNotify();
        void NotUsed_UnregisterControlChangeNotify();
        void NotUsed_GetChannelCount();
        void NotUsed_SetMasterVolumeLevel();
        void SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        void NotUsed_GetMasterVolumeLevel();
        void GetMasterVolumeLevelScalar(out float level);
        void NotUsed_SetChannelVolumeLevel();
        void NotUsed_SetChannelVolumeLevelScalar();
        void NotUsed_GetChannelVolumeLevel();
        void NotUsed_GetChannelVolumeLevelScalar();
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    public static class Audio
    {
        const int E_NOTFOUND = unchecked((int)0x80070490);
        const int CLSCTX_ALL = 23;

        // The default device's volume (0..1) and mute (0 or 1), or null when there is no such device.
        public static double[] Get(bool input)
        {
            IAudioEndpointVolume volume = Open(input);
            if (volume == null) return null;
            try
            {
                float level;
                bool muted;
                volume.GetMasterVolumeLevelScalar(out level);
                volume.GetMute(out muted);
                return new double[] { Math.Round(level, 4), muted ? 1 : 0 };
            }
            finally
            {
                Marshal.ReleaseComObject(volume);
            }
        }

        // mode: mute, unmute, toggleMute, step (value: percentage points, negative turns it down), set (value: 0..1)
        public static void Set(bool input, string mode, double value)
        {
            IAudioEndpointVolume volume = Open(input);
            if (volume == null) throw new InvalidOperationException(input ? "There is no microphone" : "There are no speakers");
            try
            {
                Guid context = Guid.Empty;
                float level;
                bool muted;
                volume.GetMasterVolumeLevelScalar(out level);
                volume.GetMute(out muted);
                switch (mode)
                {
                    case "mute": volume.SetMute(true, ref context); break;
                    case "unmute": volume.SetMute(false, ref context); break;
                    case "toggleMute": volume.SetMute(!muted, ref context); break;
                    case "step": volume.SetMasterVolumeLevelScalar(Clamp(Math.Round(level * 100 + value) / 100), ref context); break;
                    case "set": volume.SetMasterVolumeLevelScalar(Clamp(value), ref context); break;
                    default: throw new ArgumentException("Unknown volume mode: " + mode);
                }
            }
            finally
            {
                Marshal.ReleaseComObject(volume);
            }
        }

        static float Clamp(double level)
        {
            return (float)Math.Max(0, Math.Min(1, level));
        }

        // The default device (the one Windows' sound settings call "default"), or null if there is none.
        static IAudioEndpointVolume Open(bool input)
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device = null;
            try
            {
                try
                {
                    // dataFlow: 0 = eRender (speakers), 1 = eCapture (microphones). role: 0 = eConsole.
                    enumerator.GetDefaultAudioEndpoint(input ? 1 : 0, 0, out device);
                }
                catch (COMException e)
                {
                    if (e.ErrorCode == E_NOTFOUND) return null;
                    throw;
                }
                Guid iid = typeof(IAudioEndpointVolume).GUID;
                object endpointVolume;
                device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out endpointVolume);
                return (IAudioEndpointVolume)endpointVolume;
            }
            finally
            {
                if (device != null) Marshal.ReleaseComObject(device);
                Marshal.ReleaseComObject(enumerator);
            }
        }
    }

    public static class Keys
    {
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        // The largest member of the union; declared so INPUT has the size SendInput expects.
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public INPUTUNION u; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint count, INPUT[] inputs, int size);

        const uint INPUT_KEYBOARD = 1, KEYEVENTF_EXTENDEDKEY = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_SCANCODE = 8;

        // events: [scan code, extended (0/1), virtual-key code (0: none), up (0/1)] for each key event.
        // Without a virtual-key code the key goes by its scan code, which Windows maps through the
        // keyboard layout like a real key. Programs that check keys now and then (OBS, games) need to see
        // them held for a moment, hence holdMs before the first release.
        public static void Send(int[] events, int gapMs, int holdMs)
        {
            for (int i = 0; i + 3 < events.Length; i += 4)
            {
                bool up = events[i + 3] != 0;
                if (i > 0) Thread.Sleep(up && events[i - 1] == 0 ? holdMs : gapMs);
                INPUT input = new INPUT();
                input.type = INPUT_KEYBOARD;
                input.u.ki.wScan = (ushort)events[i];
                input.u.ki.wVk = (ushort)events[i + 2];
                uint flags = 0;
                if (events[i + 1] != 0) flags |= KEYEVENTF_EXTENDEDKEY;
                if (up) flags |= KEYEVENTF_KEYUP;
                if (events[i + 2] == 0) flags |= KEYEVENTF_SCANCODE;
                input.u.ki.dwFlags = flags;
                if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
        }
    }

    // Sound clips (MP3, WAV) through MCI, each opened under its own alias so several can play at once.
    public static class Sound
    {
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
        static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr callback);

        [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
        static extern bool mciGetErrorString(int error, StringBuilder text, int length);

        static string Send(string command)
        {
            StringBuilder result = new StringBuilder(256);
            int error = mciSendString(command, result, result.Capacity, IntPtr.Zero);
            if (error != 0)
            {
                StringBuilder text = new StringBuilder(256);
                if (!mciGetErrorString(error, text, text.Capacity)) text.Append("MCI error " + error);
                throw new InvalidOperationException(text.ToString());
            }
            return result.ToString();
        }

        // Opens the file and starts it; returns its length in ms (0 when MCI can't tell). volume: 0..1000.
        public static int Play(string alias, string path, int volume)
        {
            Send("open \"" + path + "\" type mpegvideo alias " + alias);
            try
            {
                Send("set " + alias + " time format milliseconds");
                Send("setaudio " + alias + " volume to " + Math.Max(0, Math.Min(1000, volume)));
                int length;
                if (!int.TryParse(Send("status " + alias + " length"), out length)) length = 0;
                Send("play " + alias);
                return length;
            }
            catch
            {
                Close(alias);
                throw;
            }
        }

        public static bool Playing(string alias)
        {
            try
            {
                return Send("status " + alias + " mode") == "playing";
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        // Stops the sound and frees it; nothing happens if it is closed already.
        public static void Close(string alias)
        {
            mciSendString("close " + alias, null, 0, IntPtr.Zero);
        }
    }

    public static class Text
    {
        // JSON with everything outside printable ASCII escaped, so no code page can garble it on the way.
        public static string Ascii(string json)
        {
            StringBuilder sb = new StringBuilder(json.Length + 16);
            foreach (char c in json)
            {
                if (c > 126) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
'@

$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$script:stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$script:stdout.AutoFlush = $true

function Write-Json($value) {
  $script:stdout.WriteLine([HoudiniDeck.Text]::Ascii((ConvertTo-Json -InputObject $value -Compress -Depth 6)))
}

function Get-ErrorText($errorRecord) {
  $e = $errorRecord.Exception
  while ($null -ne $e.InnerException) { $e = $e.InnerException }
  $e.Message
}

# --- Media sessions (WinRT) -------------------------------------------------------------------

$script:mediaManager = $null
$script:asTask = $null
$script:art = @{}
$script:artDir = Join-Path ([IO.Path]::GetTempPath()) 'houdinideck-art'

# Wait for a WinRT IAsyncOperation<T> (PowerShell can't await).
function Wait-WinRT($operation, [Type]$resultType) {
  if ($null -eq $script:asTask) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
  }
  $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(5000)) { throw 'Windows did not answer in time' }
  $task.Result
}

function Get-MediaManager {
  if ($null -eq $script:mediaManager) {
    $type = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $script:mediaManager = Wait-WinRT ($type::RequestAsync()) $type
  }
  $script:mediaManager
}

# Cover art goes into a temp file per player (the server serves it from there); returns its path and
# a short hash of the picture, or $null when the player has none.
function Save-Art($properties, [string]$id) {
  if ($null -eq $properties.Thumbnail) { return $null }
  $streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $stream = Wait-WinRT ($properties.Thumbnail.OpenReadAsync()) $streamType
  try {
    $size = [uint32]$stream.Size
    if ($size -eq 0 -or $size -gt 10MB) { return $null }
    $readerType = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $reader = $readerType::new($stream)
    $null = Wait-WinRT ($reader.LoadAsync($size)) ([uint32])
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
  } finally {
    try { $stream.Dispose() } catch { }
  }
  $md5 = [Security.Cryptography.MD5]::Create()
  $hash = ([BitConverter]::ToString($md5.ComputeHash($bytes)) -replace '-', '').Substring(0, 12)
  $path = Join-Path $script:artDir (($id -replace '[^A-Za-z0-9._-]', '_') + '.img')
  $null = New-Item -ItemType Directory -Force -Path $script:artDir
  [IO.File]::WriteAllBytes($path, $bytes)
  @{ path = $path; hash = $hash }
}

# Every media session with what it plays; $withArt also saves the cover art of changed tracks.
function Get-MediaState([bool]$withArt) {
  $manager = Get-MediaManager
  $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $sessions = @()
  foreach ($session in $manager.GetSessions()) {
    $id = [string]$session.SourceAppUserModelId
    $entry = @{ id = $id; status = [string]$session.GetPlaybackInfo().PlaybackStatus; title = ''; artist = ''; art = $null; artHash = $null }
    try {
      $properties = Wait-WinRT ($session.TryGetMediaPropertiesAsync()) $propertiesType
      $entry.title = [string]$properties.Title
      $entry.artist = [string]$properties.Artist
      if ($withArt) {
        # Players often set the picture a moment after the title, so look again on the next polls.
        $key = $entry.title + "`n" + $entry.artist + "`n" + [string]$properties.AlbumTitle
        $cached = $script:art[$id]
        if ($null -eq $cached -or $cached.key -ne $key) {
          $cached = @{ key = $key; checks = 3; path = $null; hash = $null }
          $script:art[$id] = $cached
        }
        if ($cached.checks -gt 0) {
          $cached.checks = $cached.checks - 1
          try {
            $saved = Save-Art $properties $id
            if ($null -ne $saved) { $cached.path = $saved.path; $cached.hash = $saved.hash }
          } catch { }
        }
        $entry.art = $cached.path
        $entry.artHash = $cached.hash
      }
    } catch { }
    $sessions += $entry
  }
  $current = $manager.GetCurrentSession()
  $currentId = $null
  if ($null -ne $current) { $currentId = [string]$current.SourceAppUserModelId }
  @{ current = $currentId; sessions = $sessions }
}

function Invoke-MediaCommand([string]$id, [string]$command) {
  $manager = Get-MediaManager
  $session = $null
  foreach ($candidate in $manager.GetSessions()) {
    if ([string]$candidate.SourceAppUserModelId -eq $id) { $session = $candidate; break }
  }
  if ($null -eq $session) { throw 'That media player is not running anymore' }
  switch ($command) {
    'playPause' { $operation = $session.TryTogglePlayPauseAsync() }
    'next' { $operation = $session.TrySkipNextAsync() }
    'previous' { $operation = $session.TrySkipPreviousAsync() }
    'stop' { $operation = $session.TryStopAsync() }
    default { throw "Unknown media command: $command" }
  }
  @{ accepted = [bool](Wait-WinRT $operation ([bool])) }
}

$script:watchMedia = $false
$script:lastMedia = ''
$script:nextPoll = [DateTime]::MinValue

# While watched, the media state goes out whenever it changes.
function Update-Media {
  $script:nextPoll = [DateTime]::UtcNow.AddMilliseconds(1000)
  try {
    $state = Get-MediaState $true
  } catch {
    $state = @{ error = (Get-ErrorText $_) }
    $script:nextPoll = [DateTime]::UtcNow.AddSeconds(10)
  }
  $json = ConvertTo-Json -InputObject @{ event = 'media'; state = $state } -Compress -Depth 6
  if ($json -ne $script:lastMedia) {
    $script:lastMedia = $json
    $script:stdout.WriteLine([HoudiniDeck.Text]::Ascii($json))
  }
}

# --- Requests ----------------------------------------------------------------------------------

function Invoke-Request($request) {
  switch ([string]$request.op) {
    'ping' { return @{ pong = $true } }
    'volume.get' {
      $reading = [HoudiniDeck.Audio]::Get([string]$request.target -eq 'input')
      if ($null -eq $reading) { return $null }
      return @{ volume = $reading[0]; muted = ($reading[1] -ne 0) }
    }
    'volume.set' {
      [HoudiniDeck.Audio]::Set([string]$request.target -eq 'input', [string]$request.mode, [double]$request.value)
      return $null
    }
    'keys' {
      [HoudiniDeck.Keys]::Send([int[]]@($request.events), 10, 50)
      return $null
    }
    'sound.play' {
      # The alias and path become part of an MCI command string, so only safe ones get this far.
      $alias = [string]$request.alias
      $path = [string]$request.path
      if ($alias -notmatch '^[A-Za-z0-9]{1,32}$') { throw "Bad sound name: $alias" }
      if ($path.Contains('"') -or -not [IO.File]::Exists($path)) { throw "Sound file not found: $path" }
      return @{ lengthMs = [HoudiniDeck.Sound]::Play($alias, $path, [int]$request.volume) }
    }
    'sound.playing' { return [HoudiniDeck.Sound]::Playing([string]$request.alias) }
    'sound.close' {
      $alias = [string]$request.alias
      if ($alias -match '^[A-Za-z0-9]{1,32}$') { [HoudiniDeck.Sound]::Close($alias) }
      return $null
    }
    'media.state' { return Get-MediaState $false }
    'media.control' { return Invoke-MediaCommand ([string]$request.id) ([string]$request.command) }
    'media.watch' {
      $script:watchMedia = [bool]$request.on
      $script:lastMedia = ''
      $script:nextPoll = [DateTime]::MinValue
      return $null
    }
    default { throw "Unknown request: $($request.op)" }
  }
}

function Invoke-Line([string]$line) {
  try {
    $request = ConvertFrom-Json $line
  } catch {
    return
  }
  try {
    $data = Invoke-Request $request
    Write-Json @{ id = $request.id; ok = $true; data = $data }
  } catch {
    Write-Json @{ id = $request.id; ok = $false; error = (Get-ErrorText $_) }
  }
}

# Old cover art from an earlier run.
Remove-Item -Path (Join-Path $script:artDir '*') -Force -ErrorAction SilentlyContinue

Write-Json @{ event = 'ready' }

# Read requests without blocking, so the media state can be polled in between. A closed stdin (the
# server stopped) ends the helper.
$pending = $script:stdin.ReadLineAsync()
while ($true) {
  $wait = -1
  if ($script:watchMedia) { $wait = [int][Math]::Max(0, ($script:nextPoll - [DateTime]::UtcNow).TotalMilliseconds) }
  if ($pending.Wait($wait)) {
    $line = $pending.Result
    if ($null -eq $line) { break }
    $pending = $script:stdin.ReadLineAsync()
    Invoke-Line $line
  }
  if ($script:watchMedia -and [DateTime]::UtcNow -ge $script:nextPoll) { Update-Media }
}
