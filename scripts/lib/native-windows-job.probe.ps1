<#
.SYNOPSIS
Exercises native Job ownership and failure evidence on a disposable Windows host.
.EXAMPLE
pwsh -NoProfile -File scripts/lib/native-windows-job.probe.ps1 -OutDirectory C:\evidence\native-probes -BunPath C:\tools\bun.exe
#>
param([Parameter(Mandatory=$true)][string]$OutDirectory, [Parameter(Mandatory=$true)][string]$BunPath)

$ErrorActionPreference = 'Stop'
$OutDirectory = [IO.Path]::GetFullPath($OutDirectory)
[IO.Directory]::CreateDirectory($OutDirectory) | Out-Null
$results = [Collections.Generic.List[object]]::new()
$receiptPath = Join-Path $OutDirectory 'probe-receipt.json'
$receipt = [ordered]@{ status = 'running'; startedAt = [DateTime]::UtcNow.ToString('o'); powerShellVersion = $PSVersionTable.PSVersion.ToString(); helperSha256 = $null; tests = $results; errors = @() }
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))

<#
.SYNOPSIS
Asserts the intended native invariant with evidence-specific error text.
.EXAMPLE
Assert-NativeProbe $snapshot.Empty 'exact job should be empty after verified member exit'
#>
function Assert-NativeProbe([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Native probe assertion failed: $Message" }
}

<#
.SYNOPSIS
Persists each bounded probe outcome without hiding later tests behind an earlier failure.
.EXAMPLE
Invoke-NativeProbe 'late orphan is owned' { Assert-NativeProbe $true 'owned' }
#>
function Invoke-NativeProbe([string]$Name, [scriptblock]$Body) {
    $result = [ordered]@{ name = $Name; passed = $false; at = [DateTime]::UtcNow.ToString('o'); evidence = $null; error = $null }
    try { $result.evidence = & $Body; $result.passed = $true } catch { $result.error = $_.Exception.ToString() }
    $results.Add([pscustomobject]$result)
    Write-NativeJobJson $receiptPath $receipt
    [Console]::WriteLine("probe $Name passed=$($result.passed)")
}

<#
.SYNOPSIS
Builds a strict synthetic command request with a fresh evidence directory and exact child environment.
.EXAMPLE
$request = New-NativeProbeRequest 'late-orphan' C:\evidence\orphan.mjs
#>
function New-NativeProbeRequest([string]$Name, [string]$Fixture, [string[]]$Extra = @(), [int]$TimeoutSeconds = 8) {
    $environment = [ordered]@{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        if ($entry.Key -ne 'MUST_NOT_LEAK') { $environment[$entry.Key] = [string]$entry.Value }
    }
    $environment.PROBE_VALUE = "spaces quote`" Unicode$([char]0x6c49)$([char]0x5b57)"
    $application = $BunPath; $command = @('bun', $Fixture) + $Extra
    if ([IO.Path]::GetExtension($Fixture) -eq '.ps1') {
        $application = (Get-Process -Id $PID).Path
        $command = @($application, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Fixture, '-BunPath', $BunPath, '-NativeHelper', (Join-Path $PSScriptRoot 'native-windows-job.ps1')) + $Extra
    }
    return [pscustomobject]@{
        label = $Name; application = $application; command = $command
        root = $OutDirectory; out = (Join-Path $OutDirectory $Name); environment = [pscustomobject]$environment
        mode = 'strict'; timeoutSeconds = $TimeoutSeconds; observationMs = 1000
        sourceSha = 'synthetic-probe-only'; workflowSha = $env:GITHUB_SHA; expectedVctip = $null
    }
}

<#
.SYNOPSIS
Exercises the actual Windows PowerShell5.1 request-file boundary with private UTF8 JSON and bounded own-wrapper cleanup.
.EXAMPLE
$execution = Invoke-NativeProbeRequestFile $request C:\tooling\native-windows-job.ps1
#>
function Invoke-NativeProbeRequestFile([object]$Request, [string]$Helper) {
    $privateDirectory = Join-Path ([IO.Path]::GetTempPath()) "mango-native-job-request-$([Guid]::NewGuid().ToString('N'))"
    foreach ($directory in @($Request.root, $Request.out)) {
        $prefix = [IO.Path]::GetFullPath([string]$directory).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        Assert-NativeProbe (-not $privateDirectory.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) "private request directory $privateDirectory must be outside source and evidence $directory"
    }
    $requestPath = Join-Path $privateDirectory 'request.json'
    $shell = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'WindowsPowerShell\v1.0\powershell.exe'
    $process = $null; $stdoutTask = $null; $stderrTask = $null; $result = $null
    try {
        [IO.Directory]::CreateDirectory($privateDirectory) | Out-Null
        [IO.File]::WriteAllText($requestPath, (ConvertTo-Json -InputObject $Request -Depth 40), [Text.UTF8Encoding]::new($false))
        $argv = @('-Version', '5.1', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Helper, '-RequestPath', $requestPath)
        $start = [Diagnostics.ProcessStartInfo]::new($shell, [Mango.NativeJobProbe.JobProcess]::CommandLine([string[]]$argv))
        $start.UseShellExecute = $false; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($start)
        $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
        $timeoutMs = [int]($Request.timeoutSeconds * 1000 + $Request.observationMs + 30000)
        Assert-NativeProbe ($process.WaitForExit($timeoutMs)) "Windows PowerShell5.1 helper must exit within ${timeoutMs}ms"
        Assert-NativeProbe ($process.ExitCode -eq 0) "Windows PowerShell5.1 helper exit $($process.ExitCode); expected exit0"
        $result = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText((Join-Path $Request.out 'job-receipt.json'), [Text.UTF8Encoding]::new($false, $true))) -ErrorAction Stop
    } finally {
        try {
            if ($process -and -not $process.HasExited) { $process.Kill(); Assert-NativeProbe ($process.WaitForExit(5000)) 'retained helper wrapper must exit within5000ms after own-object termination' }
            if ($stdoutTask -and $stderrTask) {
                $logsReady = [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask), 5000)
                Assert-NativeProbe $logsReady 'Windows PowerShell5.1 wrapper stdout/stderr must reach EOF within5000ms'
                [IO.Directory]::CreateDirectory($Request.out) | Out-Null
                [IO.File]::WriteAllText((Join-Path $Request.out 'wrapper.stdout.log'), $stdoutTask.GetAwaiter().GetResult(), [Text.UTF8Encoding]::new($false))
                [IO.File]::WriteAllText((Join-Path $Request.out 'wrapper.stderr.log'), $stderrTask.GetAwaiter().GetResult(), [Text.UTF8Encoding]::new($false))
            }
        } finally {
            try { if ($process) { $process.Dispose() } }
            finally { if ([IO.Directory]::Exists($privateDirectory)) { [IO.Directory]::Delete($privateDirectory, $true) } }
        }
    }
    Assert-NativeProbe (-not [IO.Directory]::Exists($privateDirectory)) 'private full-environment request must be deleted before returning'
    return [pscustomobject]@{ receipt = $result; wrapperPath = $shell; wrapperVersion = '5.1'; privateRequestDeleted = $true }
}

<#
.SYNOPSIS
Creates named compiler receipt fakes for pure eligibility tests without authorizing synthetic process cleanup.
.EXAMPLE
$fake = New-FakeCompilerEligibility C:\evidence\compiler-json.log
#>
function New-FakeCompilerEligibility([string]$StdoutPath) {
    $path = 'C:\Program Files\Microsoft Visual Studio\18\Enterprise\VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64\vctip.exe'
    $tool = [pscustomobject]@{ path = $path; fileVersion = '14.51.36260.0'; productVersion = '14.51.36260.0'; sha256 = ('a' * 64) }
    $rows = @(
        [pscustomobject]@{ reason = 'compiler-artifact'; package_id = 'registry+sdk#mango-external-agents@1'; target = @{ name = 'mango_external_agents'; kind = @('lib') }; features = @('stdio') },
        [pscustomobject]@{ reason = 'compiler-artifact'; package_id = 'path+runtime#mangostudio-runtime@1'; target = @{ name = 'mangostudio-runtime'; kind = @('bin') }; executable = 'C:\evidence\runtime.exe'; features = @() },
        [pscustomobject]@{ reason = 'build-finished'; success = $true }
    )
    [IO.File]::WriteAllLines($StdoutPath, @($rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 10 }), [Text.UTF8Encoding]::new($false))
    $member = [pscustomobject]@{ Pid = 42; Created = '2026-10-09T00:00:00.0000001Z'; CreationFileTime = '134043552000000001'; Identity = '42:2026-10-09T00:00:00.0000001Z'; Path = $path; IsMember = $true; Alive = $true; Tool = $tool }
    return [pscustomobject]@{
        request = [pscustomobject]@{ mode = 'msvc-compile'; application = 'C:\rustup\cargo.exe'; command = @('cargo', 'build', '-p', 'mangostudio-runtime', '--bin', 'mangostudio-runtime', '--locked', '--message-format=json'); expectedVctip = @($tool) }
        snapshot = [pscustomobject]@{ Stable = $true; Assigned = 1; Returned = 1; ActiveAfter = 1; Members = @($member) }
        rows = $rows
    }
}

<#
.SYNOPSIS
Supplies named current process-object identity fakes for precision/reuse mapping tests without native I/O.
.EXAMPLE
$verifier = New-FakeCensusVerifier $member
#>
function New-FakeCensusVerifier([object]$Member) {
    $fake = [pscustomobject]@{ member = $Member }
    $fake | Add-Member -MemberType ScriptMethod -Name CensusIdentity -Value { param($processId) return $this.member }
    return $fake
}

<#
.SYNOPSIS
Returns a named queued full-census fake for final-boundary tests.
.EXAMPLE
$rows = Get-FakeBoundaryCensus $context
#>
function Get-FakeBoundaryCensus([object]$Context) {
    return ,$Context.censuses.Dequeue()
}

<#
.SYNOPSIS
Observes the exact status persisted before final containment in a named fake job.
.EXAMPLE
$job = New-FakeBoundaryJob $snapshot $receipt
#>
function New-FakeBoundaryJob([object]$Snapshot, [object]$Receipt) {
    $fake = [pscustomobject]@{ snapshot = $Snapshot; receipt = $Receipt; outcomeAtClose = $null; closed = $false }
    $fake | Add-Member -MemberType ScriptMethod -Name Query -Value { return $this.snapshot }
    $fake | Add-Member -MemberType ScriptMethod -Name CloseJob -Value { $this.closed = $true; $this.outcomeAtClose = $this.receipt.status }
    $fake | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
    return $fake
}

<#
.SYNOPSIS
Waits for a complete positive native root proof before acquiring any diagnostic process handle.
.EXAMPLE
$proof = Read-NativeProbeRootProof C:\evidence\root.json 10000
#>
function Read-NativeProbeRootProof([string]$Path, [int]$TimeoutMs, [scriptblock]$Decode = $null) {
    $timer = [Diagnostics.Stopwatch]::StartNew(); $last = 'file absent'
    do {
        try {
            $text = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true))
            $proof = if ($Decode) { & $Decode $text } else { ConvertFrom-Json -InputObject $text -ErrorAction Stop }
            if ($proof.root.Created -is [DateTime]) { $proof.root.Created = $proof.root.Created.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) }
            if (-not $proof.root -or $proof.root.Pid -le 0 -or -not $proof.root.Created -or
                $proof.root.CreationFileTime -notmatch '^[1-9][0-9]+$' -or $proof.root.Identity -ne "$($proof.root.Pid):$($proof.root.Created)") { throw "Invalid root proof $text; expected positive PID and full creation identity" }
            return $proof
        } catch { $last = $_.Exception.Message }
        Start-Sleep -Milliseconds 10
    } while ($timer.ElapsedMilliseconds -lt $TimeoutMs)
    throw "Root proof unavailable after ${TimeoutMs}ms: $last; expected complete positive PID and full creation identity before witness"
}

<#
.SYNOPSIS
Supplies a named JSON timestamp coercion fake matching hosted PowerShell without native process effects.
.EXAMPLE
$proof = Read-NativeProbeRootProof C:\evidence\root.json 100 ${function:Convert-FakeNativeProofDateJson}
#>
function Convert-FakeNativeProofDateJson([string]$Json) {
    $proof = ConvertFrom-Json -InputObject $Json -ErrorAction Stop
    if ($proof.root.Created -isnot [DateTime]) { $proof.root.Created = [DateTime]::Parse($proof.root.Created, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
    return $proof
}

<#
.SYNOPSIS
Always releases the fixture's witness and exact Job even when proof publication fails, then preserves the first error.
.EXAMPLE
Complete-NativeBirthProbe $proof $witness $child C:\evidence
#>
function Complete-NativeBirthProbe([object]$Proof, [object]$Witness, [object]$Child, [string]$Out, [scriptblock]$Writer = ${function:Write-NativeJobJson}, [scriptblock]$Census = ${function:Get-NativeJobCensus}, [object]$Context = $null) {
    $firstError = $null
    try { & $Writer (Join-Path $Out 'birth-race-proof.json') $Proof $Context }
    catch { $firstError = $_ }
    finally {
        try { if ($Witness) { $Witness.Dispose() } }
        catch { if (-not $firstError) { $firstError = $_ } }
        finally {
            try { $Child.Dispose() }
            catch { if (-not $firstError) { $firstError = $_ } }
        }
    }
    try { $rows = & $Census $Context; Assert-NativeJobCensus $rows; & $Writer (Join-Path $Out 'birth-race-post-close.json') $rows $Context }
    catch { if (-not $firstError) { $firstError = $_ } }
    if ($firstError) { throw $firstError }
}

<#
.SYNOPSIS
Supplies named disposable resource fakes to prove cleanup runs without native process effects.
.EXAMPLE
$witness = New-FakeNativeBirthScope 'witness' $true
#>
function New-FakeNativeBirthScope([string]$Role, [bool]$Fail) {
    $fake = [pscustomobject]@{ role = $Role; fail = $Fail; disposed = $false }
    $fake | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposed = $true; if ($this.fail) { throw "expected fixture $($this.role) dispose failure" } }
    return $fake
}

<#
.SYNOPSIS
Supplies a named first-write failure fake while retaining subsequent diagnostic publication attempts.
.EXAMPLE
Invoke-FakeNativeBirthWrite C:\evidence\proof.json $proof $context
#>
function Invoke-FakeNativeBirthWrite([string]$Path, [object]$Value, [object]$Context) {
    $Context.writes.Add($Path)
    if ($Context.failWrite -and $Context.writes.Count -eq 1) { throw 'expected birth proof write failure' }
}

<#
.SYNOPSIS
Compiles named image-query fakes which exercise the same production retry policy without native effects.
.EXAMPLE
Initialize-FakeNativeImageQuery
$fake = [Mango.NativeImageFakes.FakeImageProcess]::new()
#>
function Initialize-FakeNativeImageQuery {
    if ('Mango.NativeImageFakes.FakeImageProcess' -as [type]) { return }
    if ('Mango.NativeJobProbe.JobProcess' -as [type]) { throw 'Invalid already compiled helper; expected named fakes and helper compiled together before native fixtures' }
    $fakeCode = @'
namespace Mango.NativeImageFakes {
    using System;
    using System.Collections.Generic;
    using System.ComponentModel;
    using System.Globalization;
    using Mango.NativeJobProbe;
    public sealed class FakeClock { public long Now; }
    public sealed class FakeImageProcess {
        public readonly FakeClock Clock;
        public readonly Queue<Member> States=new Queue<Member>();
        public readonly Queue<ImageResult> Images=new Queue<ImageResult>();
        public readonly Queue<bool> Waits=new Queue<bool>();
        public Member Current;
        public int Reads,Queries,WaitCalls,FailReadAt,FailWaitAt;
        public bool PersistentFailure,Signaled;
        public FakeImageProcess() : this(new FakeClock()) {}
        public FakeImageProcess(FakeClock clock) { Clock=clock; Current=State(42,134359891225276227,true); }
        public static Member State(uint pid,long created,bool member) {
            string date=DateTime.FromFileTimeUtc(created).ToString("o",CultureInfo.InvariantCulture);
            return new Member {Pid=pid,Identity=pid+":"+date,CreationFileTime=created.ToString(CultureInfo.InvariantCulture),Created=date,IsMember=member,Alive=true};
        }
        public Member Read() {
            Reads++; if(Reads==FailReadAt) throw new Win32Exception(6,"named GetProcessTimes failure for " + Current.Identity);
            if(States.Count>0) Current=States.Dequeue();
            return State(Current.Pid,Int64.Parse(Current.CreationFileTime),Current.IsMember);
        }
        public ImageResult Query() {
            Queries++; if(Images.Count>0) return Images.Dequeue();
            if(PersistentFailure) return new ImageResult {Success=false,Error=5,Characters=32768};
            const string path=@"C:\tools\owned.exe"; return new ImageResult {Success=true,Characters=(uint)path.Length,Path=path};
        }
        public bool Wait(int milliseconds) {
            WaitCalls++; if(WaitCalls==FailWaitAt) throw new Win32Exception(6,"named WaitForSingleObject failure for " + Current.Identity);
            Clock.Now+=milliseconds; if(Waits.Count>0 && Waits.Dequeue()) Signaled=true; return Signaled;
        }
        public Member Resolve(ImageQueryBudget budget,List<ImageAttempt> diagnostics,string identity,string image) {
            return ImageQueryPolicy.Resolve(Read,Query,Wait,budget,diagnostics,identity,image,true);
        }
    }
}
'@
    $queryStart = $script:NativeWindowsJobCode.IndexOf('        public Snapshot Query() {', [StringComparison]::Ordinal)
    $queryEnd = $script:NativeWindowsJobCode.IndexOf('        /// <summary>Terminate only one retained identity', $queryStart, [StringComparison]::Ordinal)
    if ($queryStart -lt 0 -or $queryEnd -le $queryStart) { throw 'Invalid query source boundaries; expected exact production Query method for named kernel caller fakes' }
    $queryMethod = $script:NativeWindowsJobCode.Substring($queryStart, $queryEnd - $queryStart)
    $callerCode = @'
namespace Mango.NativeImageCallerFakes {
    using System;
    using System.Collections.Generic;
    using System.ComponentModel;
    using System.Runtime.InteropServices;
    using System.Threading;
    using Mango.NativeJobProbe;
    using Mango.NativeImageFakes;
    internal sealed class HeldProcess { internal IntPtr Handle; internal Member Member; }
    internal static class Win32 {
        internal const uint QueryProcess=0x1000,Synchronize=0x100000;
        internal struct Accounting { internal uint Active,Total; }
        internal static QueryFixture Fixture;
        internal static IntPtr OpenProcess(uint access,bool inherit,uint pid) { return Fixture.Open(pid); }
        internal static void Close(ref IntPtr handle) { Fixture.Events.Add("close:"+handle); handle=IntPtr.Zero; }
    }
    public sealed class QueryFixture {
        private IntPtr job=new IntPtr(1);
        private readonly Dictionary<string,HeldProcess> held=new Dictionary<string,HeldProcess>();
        public readonly FakeClock Clock=new FakeClock();
        public readonly Queue<uint[]> Lists=new Queue<uint[]>();
        public readonly Queue<uint> Counts=new Queue<uint>();
        public readonly Queue<IntPtr> OpenOrder=new Queue<IntPtr>();
        public readonly Dictionary<IntPtr,FakeImageProcess> Processes=new Dictionary<IntPtr,FakeImageProcess>();
        public readonly List<string> Events=new List<string>();
        public readonly List<ImageAttempt> Diagnostics=new List<ImageAttempt>();
        public IntPtr Open(uint pid) { IntPtr token=OpenOrder.Count>0?OpenOrder.Dequeue():new IntPtr(1); Events.Add("open:"+pid+":"+token); return token; }
        private ImageQueryBudget NewImageBudget() { return new ImageQueryBudget(2000,()=>Clock.Now); }
        private bool Alive(IntPtr token) { return !Processes[token].Wait(0); }
        private void ReleaseExited() {
            var remove=new List<string>();
            foreach(var pair in held) if(!Alive(pair.Value.Handle)) { Win32.Close(ref pair.Value.Handle); remove.Add(pair.Key); }
            foreach(string identity in remove) held.Remove(identity);
        }
        private Win32.Accounting Accounting() { Events.Add("complete-accounting"); return new Win32.Accounting {Active=Counts.Count>0?Counts.Dequeue():1,Total=2}; }
        private uint[] ProcessList(out int bytes) { Events.Add("complete-list"); uint[] list=Lists.Count>0?Lists.Dequeue():new uint[]{42}; bytes=8+list.Length*IntPtr.Size; return list; }
        private Member Attest(IntPtr token,uint pid,string expected,ImageQueryBudget budget,string image=null) { return Processes[token].Resolve(budget,Diagnostics,expected,image); }
        public Snapshot Run() { Win32.Fixture=this; return Query(); }
'@
    Add-Type -TypeDefinition ($script:NativeWindowsJobCode + "`n" + $fakeCode + "`n" + $callerCode + $queryMethod + "`n    }`n}")
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64 -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [Runtime.InteropServices.Architecture]::X64) { throw 'Invalid probe host; expected actual Windows x64 and a 64-bit PowerShell process' }
    $helper = Join-Path $PSScriptRoot 'native-windows-job.ps1'
    . $helper
    $receipt.helperSha256 = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
    Initialize-FakeNativeImageQuery
    Initialize-NativeWindowsJob
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { $environment.Add($entry.Key, [string]$entry.Value) }
    $descendantFixture = Join-Path $OutDirectory 'descendant.ps1'
    $descendantProgram = @'
param($BunPath, $NativeHelper, $PipeMode = 'closed', $ChildProof, $BirthSignal, $BirthProof)
$ErrorActionPreference = 'Stop'
. $NativeHelper
if($PipeMode -eq 'closed') {
    # Redirecting a child alone does not exclude other inheritable parent handles.
    # Clear only this fixture root's captured writer inheritance before direct child creation.
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NativeDescendantPipeFixture {
    [DllImport("kernel32.dll",SetLastError=true)] private static extern IntPtr GetStdHandle(uint id);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool GetHandleInformation(IntPtr handle,out uint flags);
    /// <summary>Make only this fixture process's captured standard writers noninheritable without closing them.</summary>
    /// <example>NativeDescendantPipeFixture.ClearParentWriterInheritance();</example>
    public static void ClearParentWriterInheritance() {
        foreach(int id in new[]{-11,-12}) {
            IntPtr handle=GetStdHandle(unchecked((uint)id)); uint flags;
            if(handle==IntPtr.Zero || handle==new IntPtr(-1) || !SetHandleInformation(handle,1,0) || !GetHandleInformation(handle,out flags)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Invalid fixture standard writer "+id+"; expected valid handle and cleared inheritance");
            if((flags&1)!=0) throw new InvalidOperationException("Fixture writer "+id+" retained inheritance; expected zero");
        }
    }
}
"@
    [NativeDescendantPipeFixture]::ClearParentWriterInheritance()
}
if($BirthSignal) {
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while(-not (Test-Path -LiteralPath $BirthSignal) -and $timer.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 10 }
    if(-not (Test-Path -LiteralPath $BirthSignal)) { throw 'Missing birth signal after selection query' }
}
$start=[Diagnostics.ProcessStartInfo]::new($BunPath, '-e "await Bun.sleep(60000)"')
$start.UseShellExecute=$false
$start.RedirectStandardInput=$true
if($PipeMode -eq 'closed') { $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true }
$startedChild=[Diagnostics.Process]::Start($start)
$startedChild.StandardInput.Close()
$created=$startedChild.StartTime.ToUniversalTime()
$childEvidence=@{root=@{Pid=$startedChild.Id;Created=$created.ToString('o',[Globalization.CultureInfo]::InvariantCulture);Identity=([string]$startedChild.Id+':'+$created.ToString('o',[Globalization.CultureInfo]::InvariantCulture));CreationFileTime=$created.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)};live=(-not $startedChild.HasExited);pipeMode=$PipeMode;authority='retained .NET Process.Start object; exact job query independently proves membership'}
if(-not $childEvidence.live) { throw 'Descendant exited before live creation proof' }
if($ChildProof) { Write-NativeJobJson $ChildProof $childEvidence }
if($BirthProof) { Write-NativeJobJson $BirthProof $childEvidence; Start-Sleep -Seconds 60 }
[Console]::WriteLine((ConvertTo-Json -InputObject @{pid=$startedChild.Id} -Compress))
# Keep both objects live long enough for the independent exact-job query; the probe asserts that overlap.
Start-Sleep -Seconds 1
if($PipeMode -eq 'closed') { $startedChild.StandardOutput.Close(); $startedChild.StandardError.Close() }
$startedChild.Dispose()
'@
    [IO.File]::WriteAllText($descendantFixture, $descendantProgram, [Text.UTF8Encoding]::new($false))

    Invoke-NativeProbe 'UTF8 request decoding preserves Unicode with optional BOM and rejects malformed bytes' {
        $directory = Join-Path $OutDirectory 'request-decoding'; [IO.Directory]::CreateDirectory($directory) | Out-Null
        $unicode = [string][char]0x6c49 + [char]0x5b57 + [char]::ConvertFromUtf32(0x1f600)
        $expected = [pscustomobject]@{ command = @('bun', '', $unicode); environment = [pscustomobject]@{ PROBE_VALUE = $unicode } }
        $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes((ConvertTo-Json -InputObject $expected -Depth 10))
        foreach ($bom in @($false, $true)) {
            $path = Join-Path $directory "valid-bom-$bom.json"
            $inputBytes = if ($bom) { [byte[]](@(0xef, 0xbb, 0xbf) + $bytes) } else { $bytes }
            [IO.File]::WriteAllBytes($path, $inputBytes)
            $decoded = Read-NativeJobRequest $path
            Assert-NativeProbe (($decoded.command -join [char]0) -ceq ($expected.command -join [char]0) -and $decoded.environment.PROBE_VALUE -ceq $unicode) "UTF8 request with BOM=$bom must preserve exact Unicode argv and environment"
        }
        $malformed = @(
            @{ name = 'bad-continuation'; bytes = [byte[]]@(0xc3, 0x28) },
            @{ name = 'truncated'; bytes = [byte[]]@(0xf0, 0x9f, 0x98) },
            @{ name = 'overlong'; bytes = [byte[]]@(0xc0, 0xaf) },
            @{ name = 'utf16-bom'; bytes = [byte[]]@(0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00) }
        )
        foreach ($sample in $malformed) {
            $path = Join-Path $directory "$($sample.name).json"; [IO.File]::WriteAllBytes($path, $sample.bytes)
            $errorText = $null; try { Read-NativeJobRequest $path | Out-Null } catch { $errorText = $_.Exception.Message }
            Assert-NativeProbe ($errorText -eq "Invalid request encoding at $path; expected valid UTF8 JSON with optional UTF8 BOM") "$($sample.name) must fail at strict UTF8 decoding before any native launch"
        }
        $path = Join-Path $directory 'invalid-json.json'; $privateValue = 'private-decoder-marker'
        [IO.File]::WriteAllText($path, ('{"environment":{"PROBE_VALUE":"' + $privateValue + '"}'), [Text.UTF8Encoding]::new($false))
        $errorText = $null; try { Read-NativeJobRequest $path | Out-Null } catch { $errorText = $_.Exception.Message }
        Assert-NativeProbe ($errorText -eq "Invalid request JSON at $path; expected valid UTF8 JSON without exposing private request values" -and -not $errorText.Contains($privateValue)) 'malformed private request JSON must fail without leaking its environment value'
        return @{ validCases = 2; malformedUtf8Cases = $malformed.Count; privateJsonErrorRedacted = $true; nativeLaunches = 0 }
    }

    Invoke-NativeProbe 'argv environment cwd raw pipes and natural exit' {
        $fixture = Join-Path $OutDirectory 'contract.mjs'
        [IO.File]::WriteAllText($fixture, 'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),value:process.env.PROBE_VALUE,modulePath:process.env.PSModulePath??null,missing:process.env.MUST_NOT_LEAK??null})+"\n"); process.stdout.write(Buffer.from([0,255,1,13,10])); process.stderr.write(Buffer.from([255,0,2,13,10]));', [Text.UTF8Encoding]::new($false))
        $args = @('a b', 'quote"inside', 'backslash ending\', '', ([string][char]0x6c49 + [char]0x5b57 + [char]::ConvertFromUtf32(0x1f600)))
        $env:MUST_NOT_LEAK = 'should be absent from exact environment'
        try { $request = New-NativeProbeRequest 'contract' $fixture $args; $execution = Invoke-NativeProbeRequestFile $request $helper; $result = $execution.receipt } finally { Remove-Item Env:MUST_NOT_LEAK -ErrorAction SilentlyContinue }
        Assert-NativeProbe ($result.status -eq 'naturally-settled' -and $result.exitCode -eq 0 -and $result.stdoutEof -and $result.stderrEof -and $result.postCleanup.Empty) 'root exit0 and both closed raw pipes with empty exact job'
        $bytes = [IO.File]::ReadAllBytes((Join-Path $request.out 'logs/stdout.log'))
        $newline = [Array]::IndexOf($bytes, [byte]10)
        $decoded = [Text.Encoding]::UTF8.GetString($bytes, 0, $newline) | ConvertFrom-Json
        Assert-NativeProbe (($decoded.argv -join [char]0) -ceq ($args -join [char]0)) 'Windows quoted/empty/Unicode argv round trip'
        Assert-NativeProbe ($decoded.cwd -ieq $OutDirectory -and $decoded.value -eq $request.environment.PROBE_VALUE -and $null -eq $decoded.missing) 'original cwd and exact copied child environment'
        Assert-NativeProbe ($decoded.modulePath -ceq $request.environment.PSModulePath) 'engine-bundled wrapper modules must preserve the original child PSModulePath exactly'
        Assert-NativeProbe ([Convert]::ToBase64String($bytes[($newline + 1)..($bytes.Length - 1)]) -eq 'AP8BDQo=') 'stdout bytes including invalid UTF8 unchanged'
        Assert-NativeProbe ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $request.out 'logs/stderr.log'))) -eq '/wACDQo=') 'stderr bytes including invalid UTF8 unchanged'
        Assert-NativeProbe (-not $result.job.inherited -and $result.job.limitFlags -eq 0x2000 -and $result.job.atomicJobList) 'private no-breakaway noninherited job assigned atomically'
        Assert-NativeProbe ($execution.privateRequestDeleted -and $result.finalClose.preClose.Empty) 'PowerShell5.1 private request is deleted and final open Job is empty before close'
        return @{ receipt = (Join-Path $request.out 'job-receipt.json'); root = $result.rootIdentity.Identity; wrapperPath = $execution.wrapperPath; wrapperVersion = $execution.wrapperVersion; privateRequestDeleted = $execution.privateRequestDeleted }
    }

    Invoke-NativeProbe 'nonzero root exit remains failed despite empty job' {
        $fixture = Join-Path $OutDirectory 'nonzero.mjs'
        [IO.File]::WriteAllText($fixture, 'console.log("stdout before failure"); console.error("stderr before failure"); process.exitCode=23;', [Text.UTF8Encoding]::new($false))
        $request = New-NativeProbeRequest 'nonzero' $fixture
        $result = Invoke-NativeWindowsJob $request
        Assert-NativeProbe ($result.status -eq 'failed' -and $result.exitCode -eq 23 -and $result.postCleanup.Empty -and -not $result.cleanupActions.Count) 'original exit23 retained as failure, with no successful compiler cleanup'
        return @{ receipt = (Join-Path $request.out 'job-receipt.json'); expectedFailure = 'exit23' }
    }

    Invoke-NativeProbe 'late orphan with closed pipes is caught after root exit' {
        $childProof = Join-Path $OutDirectory 'orphan.child.json'
        $request = New-NativeProbeRequest 'orphan' $descendantFixture @('-PipeMode', 'closed', '-ChildProof', $childProof)
        $result = Invoke-NativeWindowsJob $request
        $proof = Read-NativeProbeRootProof $childProof 100
        $childPid = $proof.root.Pid
        $overlap = @([IO.File]::ReadAllLines((Join-Path $request.out 'job-members.jsonl')) | ForEach-Object { ConvertFrom-Json -InputObject $_ } | Where-Object { $rootPresent = @($_.Members | Where-Object Identity -EQ $result.rootIdentity.Identity).Count; $childPresent = @($_.Members | Where-Object { $_.Identity -eq $proof.root.Identity -and $_.IsMember -and $_.Alive }).Count; $rootPresent -and $childPresent })
        Assert-NativeProbe ($proof.live -and $overlap.Count) 'live child process-object identity and exact kernel membership are recorded before parent exit'
        Assert-NativeProbe ($result.exitCode -eq 0 -and $result.stdoutEof -and $result.stderrEof -and $result.status -eq 'failed') 'closed-pipe root success does not hide surviving grandchild'
        Assert-NativeProbe (@($result.preCleanup.Members | Where-Object Pid -EQ $childPid).Count -eq 1 -and -not $result.preCleanup.Empty) 'current kernel job membership includes the orphan after its parent is gone'
        Assert-NativeProbe ($result.finalClose.outcomeBeforeClose -eq 'failed' -and -not $result.cleanupActions.Count) 'strict settlement failure persisted before scoped failure containment'
        Assert-NativeProbe (-not @($result.postCloseCensus | Where-Object { $_.identity -in $result.preCleanup.Members.CensusIdentity }).Count) 'post-close independent snapshot has no failed-command orphan census identity'
        return @{ receipt = (Join-Path $request.out 'job-receipt.json'); ownedOrphan = $result.preCleanup.Members.Identity; failureBeforeClose = $result.finalClose.outcomeBeforeClose }
    }

    Invoke-NativeProbe 'held inherited pipes prevent successful compiler eligibility' {
        $childProof = Join-Path $OutDirectory 'held-pipes.child.json'
        $request = New-NativeProbeRequest 'held-pipes' $descendantFixture @('-PipeMode', 'inherited', '-ChildProof', $childProof) 4
        $result = Invoke-NativeWindowsJob $request
        $proof = Read-NativeProbeRootProof $childProof 100
        $liveChild = @($result.finalClose.preClose.Members | Where-Object { $_.Identity -eq $proof.root.Identity -and $_.IsMember -and $_.Alive })
        Assert-NativeProbe ($proof.live -and $proof.pipeMode -eq 'inherited' -and $liveChild.Count -eq 1) 'exact live child inherited the captured handles and remains after parent exit'
        Assert-NativeProbe ($result.exitCode -eq 0 -and $result.rootExitAt -and $result.status -eq 'failed' -and $result.timedOut -and -not $result.stdoutEof -and -not $result.stderrEof -and -not $result.cleanupActions.Count) 'root exit0 with open child pipes remains a timed-out failure'
        return @{ receipt = (Join-Path $request.out 'job-receipt.json'); expectedFailure = 'root success but open pipes' }
    }

    Invoke-NativeProbe 'live outsider survives unrelated private job failure containment' {
        $outsider = [Mango.NativeJobProbe.JobProcess]::new($BunPath, [string[]]@('bun', '-e', 'await Bun.sleep(60000)'), $OutDirectory, $environment, (Join-Path $OutDirectory 'outsider-logs'))
        try {
            $outsider.Resume(); $outside = $outsider.Query().Members[0]
            $request = New-NativeProbeRequest 'orphan-with-outsider' $descendantFixture @('-PipeMode', 'closed', '-ChildProof', (Join-Path $OutDirectory 'outsider-orphan.child.json'))
            $result = Invoke-NativeWindowsJob $request
            $stillLive = $outsider.VerifyIdentity($outside.Identity)
            Write-NativeJobJson (Join-Path $OutDirectory 'outsider-live-proof.json') @{ before = $outside; after = $stillLive }
            Assert-NativeProbe $stillLive.Alive 'another exact job close cannot kill live outsider handle'
            Assert-NativeProbe ($result.status -eq 'failed') 'unrelated strict command retains its surviving-descendant failure'
            Assert-NativeProbe (@($result.before | Where-Object identity -EQ $outside.CensusIdentity).Count -eq 1 -and @($result.postCloseCensus | Where-Object identity -EQ $outside.CensusIdentity).Count -eq 1) 'microsecond census identity supports the still-live full100ns outsider handle'
            return @{ outsiderIdentity = $outside.Identity; receipt = (Join-Path $request.out 'job-receipt.json') }
        } finally { $outsider.Dispose() }
    }

    Invoke-NativeProbe 'CIM precision mapping preserves full identity and rejects outside PID reuse' {
        $full = [pscustomobject]@{ Pid = 42; Identity = '42:2026-10-09T00:00:00.0000001Z'; CensusIdentity = '42:2026-10-09T00:00:00.0000000Z'; CreationFileTime = '134043552000000001'; Path = 'C:\tools\vctip.exe'; IsMember = $true; Alive = $true }
        $row = [pscustomobject]@{ pid = 42; name = 'vctip.exe'; identity = $full.CensusIdentity; path = $full.Path; command = '"C:\tools\vctip.exe"'; created = '2026-10-09T00:00:00.0000000Z' }
        $verifier = New-FakeCensusVerifier $full
        $mappings = [Collections.Generic.List[object]]::new()
        $unknown = @(Find-NativeJobAmbiguity @() @($row) @($full) $verifier $mappings)
        Assert-NativeProbe ($unknown.Count -eq 0 -and $mappings.Count -eq 1 -and $mappings[0].nativeIdentity -eq $full.Identity) 'microsecond CIM row maps only through the fresh exact-job full100ns object'
        $reused = [pscustomobject]@{ Pid = 42; Identity = '42:2026-10-09T00:00:00.0000002Z'; CensusIdentity = $full.CensusIdentity; CreationFileTime = '134043552000000002'; Path = $full.Path; IsMember = $false; Alive = $true }
        $verifier = New-FakeCensusVerifier $reused
        $unknown = @(Find-NativeJobAmbiguity @() @($row) @($full) $verifier)
        Assert-NativeProbe ($unknown.Count -eq 1) 'even colliding coarse timestamp cannot adopt an outside-job reused PID'
        $reused.IsMember = $true
        $unknown = @(Find-NativeJobAmbiguity @() @($row) @($full) $verifier)
        Assert-NativeProbe ($unknown.Count -eq 1) 'new full100ns process identity must match retained member, even inside same job'
        return @{ fullRetainedIdentity = $full.Identity; censusIdentity = $row.identity; reusedOutsideIdentity = $reused.Identity; precisionMapping = $mappings[0] }
    }

    Invoke-NativeProbe 'final member and full-census boundaries fail before containment' {
        $date = '2026-10-09T00:00:00.0000000Z'
        $observer = [pscustomobject]@{ pid = $PID; name = 'pwsh.exe'; identity = "${PID}:$date"; created = $date; path = 'C:\pwsh.exe'; command = 'observer' }
        $helperRow = [pscustomobject]@{ pid = 42; name = 'vctip.exe'; identity = "42:$date"; created = $date; path = 'C:\vctip.exe'; command = 'vctip.exe' }
        foreach ($case in @('new-final-member', 'new-post-close-helper', 'empty-census', 'missing-observer', 'missing-name')) {
            $dir = Join-Path $OutDirectory "boundary-$case"; [IO.Directory]::CreateDirectory($dir) | Out-Null
            $state = [ordered]@{ status = 'naturally-settled'; errors = @(); finalClose = $null; postCloseCensus = @() }
            $snapshot = [pscustomobject]@{ Empty = $true; Stable = $true; Assigned = 0; Returned = 0; ActiveBefore = 0; ActiveAfter = 0; Members = @() }
            $context = [pscustomobject]@{ censuses = [Collections.Generic.Queue[object]]::new() }
            switch ($case) {
                'new-final-member' { $snapshot.Empty = $false; $snapshot.Assigned = 1; $snapshot.Returned = 1; $snapshot.ActiveBefore = 1; $snapshot.ActiveAfter = 1; $snapshot.Members = @($helperRow); $context.censuses.Enqueue(@($observer)) }
                'new-post-close-helper' { $context.censuses.Enqueue(@($observer)); $context.censuses.Enqueue(@($observer, $helperRow)) }
                'empty-census' { $context.censuses.Enqueue(@()); $context.censuses.Enqueue(@($observer)) }
                'missing-observer' { $context.censuses.Enqueue(@($helperRow)); $context.censuses.Enqueue(@($observer)) }
                'missing-name' { $bad = [pscustomobject]@{ pid = $PID; identity = "${PID}:$date"; created = $date; name = $null }; $context.censuses.Enqueue(@($bad)); $context.censuses.Enqueue(@($observer)) }
            }
            $fake = New-FakeBoundaryJob $snapshot $state
            Complete-NativeJobEvidence $state $fake @($observer) $dir ${function:Get-FakeBoundaryCensus} $context
            Assert-NativeProbe ($state.status -eq 'failed' -and $state.errors.Count -gt 0) "$case must invalidate completed settlement"
            if ($case -ne 'new-post-close-helper') { Assert-NativeProbe ($fake.outcomeAtClose -eq 'failed' -and $state.finalClose.outcomeBeforeClose -eq 'failed') "$case failure must be persisted before final containment" }
        }
        return @{ controlledBoundaryFailures = 5; nativeAPIInvocations = 0 }
    }

    Invoke-NativeProbe 'atomic proof publication and incomplete JSON cannot publish PID0' {
        $path = Join-Path $OutDirectory 'publication-proof.json'
        foreach ($text in @('', '{"root":', '{"root":{"Pid":0}}')) {
            [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
            $rejected = $false
            try { Read-NativeProbeRootProof $path 50 | Out-Null } catch { $rejected = $_.Exception.ToString() -match 'expected complete positive PID and full creation identity before witness' }
            Assert-NativeProbe $rejected 'empty/partial/nonpositive JSON cannot authorize a witness lookup'
        }
        $value = @{ root = @{ Pid = 42; Created = '2026-10-09T00:00:00.0000001Z'; Identity = '42:2026-10-09T00:00:00.0000001Z'; CreationFileTime = '134043552000000001' } }
        Write-NativeJobJson $path $value
        $proof = Read-NativeProbeRootProof $path 100
        Assert-NativeProbe ($proof.root.Pid -eq 42 -and $proof.root.Identity -eq $value.root.Identity) 'atomic replacement publishes complete full identity bytes'
        $coerced = Read-NativeProbeRootProof $path 100 ${function:Convert-FakeNativeProofDateJson}
        Assert-NativeProbe ($coerced.root.Created -ceq $value.root.Created -and $coerced.root.Identity -ceq $value.root.Identity) 'default JSON DateTime decoding preserves full100ns UTC identity after normalization'
        Assert-NativeProbe (-not @(Get-ChildItem -LiteralPath $OutDirectory -Filter 'publication-proof.json.*.tmp').Count) 'atomic writer removes all unpublished temporary files'
        return @{ rejectedIncompleteProofs = 3; validProof = $proof; coercedDateProof = $coerced; nativeProcessEffects = $false }
    }

    Invoke-NativeProbe 'birth evidence write failure cannot skip scoped fixture disposal' {
        $date = '2026-10-09T00:00:00.0000000Z'
        $observer = [pscustomobject]@{ pid = $PID; name = 'pwsh.exe'; identity = "${PID}:$date"; created = $date }
        foreach ($case in @('write-failure', 'witness-failure', 'clean')) {
            $context = [pscustomobject]@{ failWrite = ($case -eq 'write-failure'); writes = [Collections.Generic.List[string]]::new(); censuses = [Collections.Generic.Queue[object]]::new() }
            $context.censuses.Enqueue(@($observer))
            $witness = New-FakeNativeBirthScope 'witness' ($case -eq 'witness-failure')
            $child = New-FakeNativeBirthScope 'exact-job' $false
            $failure = $null
            try { Complete-NativeBirthProbe @{} $witness $child $OutDirectory ${function:Invoke-FakeNativeBirthWrite} ${function:Get-FakeBoundaryCensus} $context }
            catch { $failure = $_.Exception.ToString() }
            Assert-NativeProbe ($witness.disposed -and $child.disposed -and $context.censuses.Count -eq 0 -and $context.writes.Count -eq 2) "$case attempts both scoped disposals and post-close evidence"
            if ($case -eq 'write-failure') { Assert-NativeProbe ($failure -match 'expected birth proof write failure') 'original publication error is preserved after cleanup and post-census' }
            elseif ($case -eq 'witness-failure') { Assert-NativeProbe ($failure -match 'expected fixture witness dispose failure') 'witness error cannot prevent exact Job disposal' }
            else { Assert-NativeProbe (-not $failure) 'valid scoped fixture completion succeeds without native effects' }
        }
        return @{ pureCleanupCases = 3; nativeProcessEffects = $false }
    }

    Invoke-NativeProbe 'identity mismatch and reused historical PPID never grant ownership' {
        $child = [Mango.NativeJobProbe.JobProcess]::new($BunPath, [string[]]@('bun', '-e', 'await Bun.sleep(60000)'), $OutDirectory, $environment, (Join-Path $OutDirectory 'identity-logs'))
        try {
            $child.Resume(); $member = $child.Query().Members[0]
            $bad = "$($member.Pid):2026-10-09T00:00:00.0000000Z"; $rejected = $false
            try { $child.VerifyIdentity($bad) | Out-Null } catch { $rejected = $_.Exception.ToString() -match 'expected retained creation identity' }
            Assert-NativeProbe $rejected 'same PID with another creation time must not adopt retained identity'
            $before = @([pscustomobject]@{ identity = '4008:2026-10-09T01:25:34.7778010Z'; pid = 4008; name = 'link.exe' })
            $current = @([pscustomobject]@{ identity = '4008:2026-10-09T01:28:08.5064100Z'; pid = 4008; parentPid = 1; name = 'pwsh.exe'; path = ''; command = '' }, [pscustomobject]@{ identity = '4020:2026-10-09T01:25:37.3676670Z'; pid = 4020; parentPid = 4008; name = 'vctip.exe'; path = 'C:\tools\vctip.exe'; command = '' })
            $unknown = @(Find-NativeJobAmbiguity $before $current @())
            Assert-NativeProbe ($unknown.Count -eq 1 -and $unknown[0].pid -eq 4020) 'historical parent PID does not turn new VCTIP into exact-job ownership'
            return @{ retainedIdentity = $member.Identity; rejectedIdentity = $bad; rawPolicyPidReuse = $current[0].identity; ambiguity = $unknown }
        } finally { $child.Dispose() }
    }

    Invoke-NativeProbe 'bounded image retries preserve same-object identity and fail closed on unknown metadata' {
        $clock = [Mango.NativeImageFakes.FakeClock]::new()
        $fake = [Mango.NativeImageFakes.FakeImageProcess]::new($clock)
        $attempts = [Collections.Generic.List[Mango.NativeJobProbe.ImageAttempt]]::new()
        $budget = [Mango.NativeJobProbe.ImageQueryBudget]::new(2000, [Func[long]]{ return $clock.Now })
        $fake.Images.Enqueue([Mango.NativeJobProbe.ImageResult]@{ Success = $false; Error = 5; Characters = 32768 })
        $resolved = $fake.Resolve($budget, $attempts, $fake.Current.Identity, 'C:\tools\owned.exe')
        Assert-NativeProbe ($resolved.Identity -eq $fake.Current.Identity -and $fake.Queries -eq 2 -and $clock.Now -eq 10 -and $attempts.Count -eq 2) 'live image error recovers only by querying the same owned object'
        Assert-NativeProbe ($attempts[0].NativeError -eq 5 -and $attempts[0].Before.CreationFileTime -eq $resolved.CreationFileTime -and $attempts[1].Outcome -eq 'recovered-same-owned-handle') 'recovered metadata errors retain first failure and final full-identity evidence separately from qualification errors'
        $recovery = @($attempts)
        foreach ($case in @('persistent-live', 'outside', 'reused-identity', 'lost-membership', 'wait-error', 'identity-error', 'empty-image', 'changed-image', 'short-image')) {
            $fake = [Mango.NativeImageFakes.FakeImageProcess]::new()
            $clock = $fake.Clock; $expected = $fake.Current.Identity
            $attempts = [Collections.Generic.List[Mango.NativeJobProbe.ImageAttempt]]::new()
            $budget = [Mango.NativeJobProbe.ImageQueryBudget]::new(2000, [Func[long]]{ return $clock.Now })
            $pattern = ''; $image = 'C:\tools\owned.exe'
            switch ($case) {
                'persistent-live' { $fake.PersistentFailure = $true; $pattern = 'Image query budget exhausted after 2000ms at image retry wait\(42:.*Win32Error=5 attempt=200' }
                'outside' { $fake.Current.IsMember = $false; $pattern = 'expected exact-job membership' }
                'reused-identity' {
                    $fake.Images.Enqueue([Mango.NativeJobProbe.ImageResult]@{ Success = $false; Error = 5; Characters = 32768 })
                    $fake.States.Enqueue($fake.Current); $fake.States.Enqueue($fake.Current)
                    $fake.States.Enqueue([Mango.NativeImageFakes.FakeImageProcess]::State(42, 134359891225276228, $true))
                    $pattern = 'expected same retained object'
                }
                'lost-membership' {
                    $fake.States.Enqueue($fake.Current); $fake.States.Enqueue($fake.Current)
                    $fake.States.Enqueue([Mango.NativeImageFakes.FakeImageProcess]::State(42, 134359891225276227, $false))
                    $pattern = 'expected exact-job membership'
                }
                'wait-error' { $fake.PersistentFailure = $true; $fake.FailWaitAt = 2; $pattern = 'named WaitForSingleObject failure' }
                'identity-error' { $fake.PersistentFailure = $true; $fake.FailReadAt = 3; $pattern = 'named GetProcessTimes failure' }
                'empty-image' { $fake.Images.Enqueue([Mango.NativeJobProbe.ImageResult]@{ Success = $true; Characters = 0; Path = '' }); $pattern = 'expected nonempty complete absolute Win32 image' }
                'changed-image' { $image = 'C:\tools\previous.exe'; $pattern = 'Invalid changed image.*expected C:' }
                'short-image' { $fake.Images.Enqueue([Mango.NativeJobProbe.ImageResult]@{ Success = $true; Characters = 1; Path = 'C:\tools\owned.exe' }); $pattern = 'expected nonempty complete absolute Win32 image' }
            }
            $failure = $null
            try { $fake.Resolve($budget, $attempts, $expected, $image) | Out-Null } catch { $failure = $_.Exception.ToString() }
            Assert-NativeProbe ($failure -match $pattern) "$case must reject the intended invalid metadata or authority"
            if ($case -eq 'persistent-live') { Assert-NativeProbe ($fake.Queries -eq 200 -and $attempts.Count -eq 200 -and $clock.Now -eq 2000 -and $attempts[199].NativeError -eq 5 -and $attempts[199].Outcome -eq 'failed-closed') 'sustained live unknown image is retried to the end of the shared budget and remains failed' }
            if ($case -in @('wait-error', 'identity-error', 'reused-identity')) { Assert-NativeProbe ($fake.Queries -eq 1 -and $attempts[0].StateError -match $pattern) 'state/native failures never enter a generic metadata retry' }
            if ($case -in @('wait-error', 'identity-error')) { Assert-NativeProbe ($attempts[0].StateNativeError -eq 6) 'native state error codes remain numeric evidence even when localized exception text omits them' }
            if ($case -eq 'outside') { Assert-NativeProbe ($fake.Queries -eq 0) 'outside object cannot enter the image retry policy' }
        }
        $fake = [Mango.NativeImageFakes.FakeImageProcess]::new(); $fake.Current.IsMember = $false; $clock = $fake.Clock
        $attempts = [Collections.Generic.List[Mango.NativeJobProbe.ImageAttempt]]::new()
        $budget = [Mango.NativeJobProbe.ImageQueryBudget]::new(2000, [Func[long]]{ return $clock.Now })
        $read = [Func[Mango.NativeJobProbe.Member]]{ return $fake.Read() }; $query = [Func[Mango.NativeJobProbe.ImageResult]]{ return $fake.Query() }; $wait = [Func[int,bool]]{ param($milliseconds) return $fake.Wait($milliseconds) }
        $outside = [Mango.NativeJobProbe.ImageQueryPolicy]::Resolve($read, $query, $wait, $budget, $attempts, [NullString]::Value, [NullString]::Value, $false)
        Assert-NativeProbe (-not $outside.IsMember -and $outside.Alive -and $fake.Queries -eq 1) 'query-only census mapping reports an outsider without granting membership or retry authority'
        $fake.PersistentFailure = $true; $failure = $null
        try { [Mango.NativeJobProbe.ImageQueryPolicy]::Resolve($read, $query, $wait, $budget, $attempts, [NullString]::Value, [NullString]::Value, $false) | Out-Null } catch { $failure = $_.Exception.ToString() }
        Assert-NativeProbe ($failure -match 'QueryFullProcessImageNameW PID=42' -and $fake.Queries -eq 2 -and $clock.Now -eq 0) 'outside census image failure is immediately fatal without retry sleeps'
        return @{ liveRecovery = $recovery; rejectedCases = 9; outsideSingleQuery = $outside; nativeAPIInvocations = 0 }
    }
    Invoke-NativeProbe 'image exit requires fresh complete membership and one shared retry budget' {
        $clock = [Mango.NativeImageFakes.FakeClock]::new()
        $fake = [Mango.NativeImageFakes.FakeImageProcess]::new($clock)
        $attempts = [Collections.Generic.List[Mango.NativeJobProbe.ImageAttempt]]::new()
        $budget = [Mango.NativeJobProbe.ImageQueryBudget]::new(2000, [Func[long]]{ return $clock.Now })
        $fake.PersistentFailure = $true
        $fake.Waits.Enqueue($false); $fake.Waits.Enqueue($false); $fake.Waits.Enqueue($true)
        $exited = $false
        try { $fake.Resolve($budget, $attempts, $fake.Current.Identity, 'C:\tools\owned.exe') | Out-Null } catch { $exited = $_.Exception.ToString() -match 'MemberExitedException.*|Exact member.*signaled exit' }
        Assert-NativeProbe ($exited -and $attempts.Count -eq 1 -and $attempts[0].SameHandleExited -and $attempts[0].Outcome -eq 'same-handle-exit-requires-complete-refresh') 'failed image plus exact handle exit requests complete refresh instead of yielding empty metadata'
        $exitEvidence = @($attempts)
        $clock = [Mango.NativeImageFakes.FakeClock]::new()
        $budget = [Mango.NativeJobProbe.ImageQueryBudget]::new(25, [Func[long]]{ return $clock.Now })
        $first = [Mango.NativeImageFakes.FakeImageProcess]::new($clock)
        1..2 | ForEach-Object { $first.Images.Enqueue([Mango.NativeJobProbe.ImageResult]@{ Success = $false; Error = 5; Characters = 32768 }) }
        $attempts = [Collections.Generic.List[Mango.NativeJobProbe.ImageAttempt]]::new()
        $first.Resolve($budget, $attempts, $first.Current.Identity, 'C:\tools\owned.exe') | Out-Null
        Assert-NativeProbe ($clock.Now -eq 20) 'first member consumes the shared monotonic retry budget'
        $second = [Mango.NativeImageFakes.FakeImageProcess]::new($clock); $second.PersistentFailure = $true
        $failure = $null
        try { $second.Resolve($budget, $attempts, $second.Current.Identity, 'C:\tools\owned.exe') | Out-Null } catch { $failure = $_.Exception.ToString() }
        Assert-NativeProbe ($failure -match 'Image query budget exhausted' -and $clock.Now -eq 25 -and $second.Queries -eq 1) 'a second member cannot reset or multiply the complete-query deadline'
        return @{ sameHandleExit = $exitEvidence; sharedBudgetMilliseconds = 25; elapsedMilliseconds = $clock.Now; attempts = @($attempts); nativeAPIInvocations = 0 }
    }
    Invoke-NativeProbe 'exact query caller refreshes complete accounting and never drops a still-present member' {
        $cases = [Collections.Generic.List[object]]::new()
        foreach ($case in @('complete-empty-refresh', 'new-live-member-after-refresh', 'still-present-exited-member')) {
            $fixture = [Mango.NativeImageCallerFakes.QueryFixture]::new()
            $old = [Mango.NativeImageFakes.FakeImageProcess]::new($fixture.Clock); $old.PersistentFailure = $true
            $old.Waits.Enqueue($false); $old.Waits.Enqueue($false); $old.Waits.Enqueue($false); $old.Waits.Enqueue($true)
            $fixture.Processes.Add([IntPtr]::new(1), $old)
            $fixture.OpenOrder.Enqueue([IntPtr]::new(1))
            $fixture.Lists.Enqueue([uint32[]]@(42)); $fixture.Counts.Enqueue(1)
            switch ($case) {
                'complete-empty-refresh' { $fixture.Lists.Enqueue([uint32[]]@()); $fixture.Counts.Enqueue(0); $fixture.Counts.Enqueue(0) }
                'new-live-member-after-refresh' {
                    $fresh = [Mango.NativeImageFakes.FakeImageProcess]::new($fixture.Clock)
                    $fresh.Current = [Mango.NativeImageFakes.FakeImageProcess]::State(42, 134359891225276228, $true)
                    $fixture.Processes.Add([IntPtr]::new(2), $fresh); $fixture.OpenOrder.Enqueue([IntPtr]::new(2))
                    $fixture.Lists.Enqueue([uint32[]]@(42)); $fixture.Counts.Enqueue(1); $fixture.Counts.Enqueue(1)
                }
            }
            $snapshot = $null; $failure = $null
            try { $snapshot = $fixture.Run() } catch { $failure = $_.Exception.ToString() }
            if ($case -eq 'complete-empty-refresh') {
                Assert-NativeProbe (-not $failure -and $snapshot.Empty -and $snapshot.Stable -and $snapshot.Races -eq 1 -and $snapshot.Assigned -eq 0 -and $snapshot.ActiveBefore -eq 0 -and $snapshot.ActiveAfter -eq 0) 'only a new complete PID list and both accounting snapshots can establish empty after same-handle exit'
                Assert-NativeProbe (@($fixture.Events | Where-Object { $_ -eq 'complete-list' }).Count -eq 2 -and @($fixture.Events | Where-Object { $_ -eq 'complete-accounting' }).Count -eq 3) 'production Query caller performs fresh native list and accounting after the refresh signal'
            } elseif ($case -eq 'new-live-member-after-refresh') {
                Assert-NativeProbe (-not $failure -and -not $snapshot.Empty -and $snapshot.Members.Count -eq 1 -and $snapshot.Members[0].Identity -eq $fresh.Current.Identity -and $snapshot.Races -eq 1) 'a fresh still-present process is independently attested and remains visible after refresh, even with reused PID'
            } else {
                Assert-NativeProbe ($failure -match 'Unstable member identity after12 refreshes' -and -not $snapshot) 'a kernel list which still contains the exited object cannot be converted into an empty census'
            }
            $cases.Add([pscustomobject]@{ name = $case; snapshot = $snapshot; error = $failure; events = @($fixture.Events); diagnostics = @($fixture.Diagnostics) })
        }
        return @{ cases = @($cases); exactProductionQueryExtracted = $true; nativeAPIInvocations = 0 }
    }
    Invoke-NativeProbe 'native query error and short process lists never report empty' {
        $child = [Mango.NativeJobProbe.JobProcess]::new($BunPath, [string[]]@('bun', '-e', 'await Bun.sleep(60000)'), $OutDirectory, $environment, (Join-Path $OutDirectory 'query-error-logs'))
        $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(32)
        try {
            $child.Resume()
            $field = $child.GetType().GetField('job', [Reflection.BindingFlags]'Instance,NonPublic')
            $valid = $field.GetValue($child); $failed = $false
            try { $field.SetValue($child, [IntPtr]::new(-1)); $child.Query() | Out-Null } catch { $failed = $_.Exception.ToString() -match 'QueryInformationJobObject\(Accounting\)' } finally { $field.SetValue($child, $valid) }
            Assert-NativeProbe $failed 'native invalid-handle query must throw with API context'
            [Runtime.InteropServices.Marshal]::WriteInt32($buffer, 0, 2); [Runtime.InteropServices.Marshal]::WriteInt32($buffer, 4, 1)
            $short = $false; try { [Mango.NativeJobProbe.JobProcess]::DecodeProcessList($buffer, 32, 16) | Out-Null } catch { $short = $_.Exception.ToString() -match 'expected complete bounded PID array' }
            Assert-NativeProbe $short 'assigned2/returned1 must fail before treating data as complete'
            [Runtime.InteropServices.Marshal]::WriteInt32($buffer, 0, 1)
            $truncated = $false; try { [Mango.NativeJobProbe.JobProcess]::DecodeProcessList($buffer, 32, 8) | Out-Null } catch { $truncated = $_.Exception.ToString() -match 'expected complete bounded PID array' }
            Assert-NativeProbe $truncated 'header-only response cannot claim one attested member'
            $duplicate = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal); $duplicate.Add('Path','a'); $duplicate.Add('PATH','b')
            $invalidEnv = $false; try { [Mango.NativeJobProbe.JobProcess]::EnvironmentBlock($duplicate) | Out-Null } catch { $invalidEnv = $_.Exception.ToString() -match 'duplicate environment key PATH' }
            Assert-NativeProbe $invalidEnv 'case-insensitive environment duplicates are rejected'
            $invalidArg = $false; try { [Mango.NativeJobProbe.JobProcess]::CommandLine([string[]]@("bad$([char]0)value")) | Out-Null } catch { $invalidArg = $_.Exception.ToString() -match 'expected NUL-free string' }
            Assert-NativeProbe $invalidArg 'NUL arguments are rejected before command effects'
            return @{ queryErrorRejected = $failed; partialRejected = $short; truncatedRejected = $truncated; environmentDuplicateRejected = $invalidEnv; nulArgumentRejected = $invalidArg }
        } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer); $child.Dispose() }
    }

    Invoke-NativeProbe 'compiler cleanup eligibility rejects incomplete or broader setup' {
        $path = Join-Path $OutDirectory 'fake-compiler-json.log'
        $fake = New-FakeCompilerEligibility $path
        $allowed = Get-NativeJobCompilerEligibility $fake.request $fake.snapshot 0 $true @() $path @()
        Assert-NativeProbe $allowed.eligible 'pure valid compiler metadata/JSON policy fixture should be eligible without any process effects'
        foreach ($case in @('nonzero', 'pipes', 'query-error', 'unknown-helper', 'strict-command', 'unknown-daemon', 'testing-feature', 'unfinished-json', 'flag-change', 'tool-mismatch')) {
            $fake = New-FakeCompilerEligibility $path; $code = 0; $pipes = $true; $errors = @(); $unknown = @()
            switch ($case) {
                'nonzero' { $code = 9 }
                'pipes' { $pipes = $false }
                'query-error' { $errors = @('native query failed') }
                'unknown-helper' { $unknown = @([pscustomobject]@{ identity = '8:unknown' }) }
                'strict-command' { $fake.request.mode = 'strict' }
                'unknown-daemon' { $fake.snapshot.Members[0].Path = 'C:\build-script-daemon.exe' }
                'testing-feature' { $fake.rows[0].features = @('stdio', 'testing'); [IO.File]::WriteAllLines($path, @($fake.rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 10 })) }
                'unfinished-json' { [IO.File]::WriteAllLines($path, @($fake.rows[0..1] | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 10 })) }
                'flag-change' { $fake.request.command += '--no-default-features' }
                'tool-mismatch' { $fake.snapshot.Members[0].Tool = [pscustomobject]@{ Path = $fake.request.expectedVctip[0].path; FileVersion = 'different'; ProductVersion = 'different'; Sha256 = ('b' * 64) } }
            }
            $denied = Get-NativeJobCompilerEligibility $fake.request $fake.snapshot $code $pipes $errors $path $unknown
            Assert-NativeProbe (-not $denied.eligible -and $denied.reasons.Count -gt 0) "$case must deny compiler setup cleanup"
        }
        return @{ positivePureFixture = $allowed; negativeCases = 10; syntheticProcessCleanup = $false }
    }

    Invoke-NativeProbe 'runtime and fake compiler features remain separate' {
        $path = Join-Path $OutDirectory 'fake-agent-compiler-json.log'
        $fake = New-FakeCompilerEligibility $path
        $fake.request.command = @('cargo', 'build', '-p', 'mangostudio-runtime', '--example', 'fake_cursor_agent', '--locked', '--message-format=json')
        $fake.rows[0].features = @('stdio', 'testing')
        $fake.rows[1].target = @{ name = 'fake_cursor_agent'; kind = @('example') }
        [IO.File]::WriteAllLines($path, @($fake.rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 10 }), [Text.UTF8Encoding]::new($false))
        $allowed = Get-NativeJobCompilerEligibility $fake.request $fake.snapshot 0 $true @() $path @()
        Assert-NativeProbe ($allowed.eligible -and $allowed.buildTarget -eq 'fake') 'original fake-agent example permits its intentional SDK testing feature'
        $fake.rows[0].features = @('stdio')
        [IO.File]::WriteAllLines($path, @($fake.rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 10 }), [Text.UTF8Encoding]::new($false))
        Assert-NativeProbe (-not (Get-NativeJobCompilerEligibility $fake.request $fake.snapshot 0 $true @() $path @()).eligible) 'fake setup cannot substitute the production-only SDK feature graph'
        $fake.rows[0].features = @('stdio', 'testing'); $fake.rows[1].features = @('different')
        [IO.File]::WriteAllLines($path, @($fake.rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 10 }), [Text.UTF8Encoding]::new($false))
        Assert-NativeProbe (-not (Get-NativeJobCompilerEligibility $fake.request $fake.snapshot 0 $true @() $path @()).eligible) 'primary example features must remain the original default empty set'
        return @{ positiveFakeFixture = $allowed; deniedFeatureGraphs = 2; syntheticProcessCleanup = $false }
    }

    Invoke-NativeProbe 'compiler inventory permits actual toolsets and rejects ambiguous paths' {
        $path = Join-Path $OutDirectory 'installed-tool-policy-json.log'
        $fake = New-FakeCompilerEligibility $path
        $tool = $fake.request.expectedVctip[0]
        $tool.path = 'D:\Custom VS\VC\Tools\MSVC\14.99.12345\bin\Hostx64\x64\vctip.exe'
        $fake.snapshot.Members[0].Path = $tool.path
        $allowed = Get-NativeJobCompilerEligibility $fake.request $fake.snapshot 0 $true @() $path @()
        Assert-NativeProbe $allowed.eligible 'policy accepts an independently attested alternate installation without a fixed VS version'
        $fake.request.expectedVctip = @($tool, $tool)
        Assert-NativeProbe (-not (Get-NativeJobCompilerEligibility $fake.request $fake.snapshot 0 $true @() $path @()).eligible) 'duplicate attestation paths cannot authorize cleanup'
        $fake.request.expectedVctip = @()
        Assert-NativeProbe (-not (Get-NativeJobCompilerEligibility $fake.request $fake.snapshot 0 $true @() $path @()).eligible) 'empty tool inventory cannot authorize cleanup'
        return @{ alternateInstalledPath = $allowed; deniedInventories = 2; syntheticProcessCleanup = $false }
    }

    Invoke-NativeProbe 'installed MSVC inventory matches actual files' {
        $inventory = Get-NativeJobToolInventory
        Assert-NativeProbe ($inventory.os64Bit -and $inventory.process64Bit -and $inventory.installedTools.Count -gt 0) 'actual installed x64 tool inventory exists'
        foreach ($tool in $inventory.installedTools) {
            Assert-NativeProbe ([IO.File]::Exists($tool.path) -and (Get-FileHash -LiteralPath $tool.path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $tool.sha256) 'inventory SHA256 matches independently reread installed tool bytes'
        }
        $inventoryPath = Join-Path $OutDirectory 'installed-tools.json'
        Write-NativeJobJson $inventoryPath $inventory
        return @{ toolCount = $inventory.installedTools.Count; inventory = $inventoryPath; registryChanged = $false }
    }

    Invoke-NativeProbe 'child birth between query and selected-parent cleanup remains visible' {
        $signal = Join-Path $OutDirectory 'birth.signal'; $born = Join-Path $OutDirectory 'birth.child.json'
        $request = New-NativeProbeRequest 'birth-race' $descendantFixture @('-PipeMode', 'closed', '-BirthSignal', $signal, '-BirthProof', $born)
        $child = [Mango.NativeJobProbe.JobProcess]::new($request.application, [string[]]$request.command, $OutDirectory, $environment, (Join-Path $OutDirectory 'birth-race-logs'))
        $proof = [ordered]@{ before = $null; selectedParentAction = $null; after = $null; failureBeforeClose = $false }
        $witness = $null
        try {
            $child.Resume(); $before = $child.Query(); $proof.before = $before
            Assert-NativeProbe ($before.Members.Count -eq 1) 'last selection query contains exactly the eligible simulated parent'
            [IO.File]::WriteAllText($signal, 'go'); $timer = [Diagnostics.Stopwatch]::StartNew()
            while (-not (Test-Path -LiteralPath $born) -and $timer.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 10 }
            Assert-NativeProbe (Test-Path -LiteralPath $born) 'new child is deterministically born after selection and before parent cleanup'
            $birth = Read-NativeProbeRootProof $born 1000
            $bornPid = $birth.root.Pid; $preAction = $child.Query(); $proof.afterBirthBeforeAction = $preAction
            $bornMember = @($preAction.Members | Where-Object Identity -EQ $birth.root.Identity)
            Assert-NativeProbe ($birth.live -and $bornMember.Count -eq 1 -and $bornMember[0].IsMember -and $bornMember[0].Alive) 'exact live newborn membership is preserved before selected-parent cleanup'
            $witness = [Mango.NativeJobProbe.ProcessWitness]::new([uint32]$bornPid, [string]$birth.root.Identity)
            Assert-NativeProbe (-not $witness.WaitExited(0)) 'query-only child witness is live before parent action'
            $proof.selectedParentAction = @{ identity = $before.Members[0].Identity; authority = 'exact retained handle test fixture'; operation = 'TerminateProcess'; productionCompilerEligibility = $false }
            $child.TerminateVerifiedMember($before.Members[0].Identity, 5000)
            $after = $child.Query(); $proof.after = $after
            Assert-NativeProbe (-not $witness.WaitExited(0) -and -not $after.Empty -and @($after.Members | Where-Object Identity -EQ $birth.root.Identity).Count -eq 1) 'parent-only handle cleanup cannot erase new unattested child'
            $proof.failureBeforeClose = $true
            Write-NativeJobJson (Join-Path $OutDirectory 'birth-race-proof.json') $proof
            return $proof
        } finally { Complete-NativeBirthProbe $proof $witness $child $OutDirectory }
    }

    foreach ($phase in @('suspended', 'resumed')) {
        Invoke-NativeProbe "wrapper death contains $phase root without inherited job handle" {
            $phaseDir = Join-Path $OutDirectory "death-$phase"; [IO.Directory]::CreateDirectory($phaseDir) | Out-Null
            $wrapper = Join-Path $phaseDir 'wrapper.ps1'; $rootProof = Join-Path $phaseDir 'root.json'; $marker = Join-Path $phaseDir 'root-ran.txt'; $killSignal = Join-Path $phaseDir 'kill.signal'
            $fixture = Join-Path $phaseDir 'sleep.mjs'; [IO.File]::WriteAllText($fixture, 'await Bun.write(process.argv[2],"root ran"); await Bun.sleep(60000);', [Text.UTF8Encoding]::new($false))
            $wrapperBody = @'
param($Helper, $Bun, $Fixture, $Directory, $Proof, $Marker, $Phase, $KillSignal)
$ErrorActionPreference='Stop'
. $Helper
Initialize-NativeWindowsJob
$copy=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
foreach($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { $copy.Add($entry.Key,[string]$entry.Value) }
$child=[Mango.NativeJobProbe.JobProcess]::new($Bun,[string[]]@('bun',$Fixture,$Marker),$Directory,$copy,(Join-Path $Directory 'logs'))
$rootEvidence=@{phase=$Phase;root=$child.RootIdentity;jobInherited=$child.JobInherited;before=$child.Query();expectedWrapperFailure=$true}
if($Phase -eq 'resumed') {
    $child.Resume()
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while(-not (Test-Path -LiteralPath $Marker) -and $timer.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 10 }
    if(-not (Test-Path -LiteralPath $Marker)) { throw 'Root did not execute before wrapper death' }
}
Write-NativeJobJson $Proof $rootEvidence
$timer=[Diagnostics.Stopwatch]::StartNew()
while(-not (Test-Path -LiteralPath $KillSignal) -and $timer.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 10 }
if(-not (Test-Path -LiteralPath $KillSignal)) { throw 'Diagnostic observer did not retain root witness before crash' }
[Diagnostics.Process]::GetCurrentProcess().Kill()
'@
            [IO.File]::WriteAllText($wrapper, $wrapperBody, [Text.UTF8Encoding]::new($false))
            $shell = (Get-Process -Id $PID).Path
            $argv = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $wrapper, '-Helper', $helper, '-Bun', $BunPath, '-Fixture', $fixture, '-Directory', $phaseDir, '-Proof', $rootProof, '-Marker', $marker, '-Phase', $phase, '-KillSignal', $killSignal)
            $start = [Diagnostics.ProcessStartInfo]::new($shell, [Mango.NativeJobProbe.JobProcess]::CommandLine([string[]]$argv)); $start.UseShellExecute = $false; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
            $process = [Diagnostics.Process]::Start($start)
            $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync(); $witness = $null
            try {
                $proof = Read-NativeProbeRootProof $rootProof 10000
                $witness = [Mango.NativeJobProbe.ProcessWitness]::new([uint32]$proof.root.Pid, [string]$proof.root.Identity)
                Assert-NativeProbe (-not $witness.WaitExited(0)) 'retained exact root object is live before deliberate wrapper death'
                [IO.File]::WriteAllText($killSignal, 'witness retained')
                Assert-NativeProbe ($process.WaitForExit(15000)) 'deliberate wrapper crash should complete within15seconds'
                Assert-NativeProbe (Test-Path -LiteralPath $rootProof) 'crashed wrapper persisted exact root handle identity before death'
                $rootExited = $witness.WaitExited(5000)
                $timer = [Diagnostics.Stopwatch]::StartNew()
                do { $full = Get-NativeJobCensus; $present = @($full | Where-Object identity -EQ $proof.root.CensusIdentity).Count; if ($present) { Start-Sleep -Milliseconds 100 } } while ($present -and $timer.ElapsedMilliseconds -lt 5000)
                Write-NativeJobJson (Join-Path $phaseDir 'post-crash-census.json') $full
                Assert-NativeProbe ($process.ExitCode -ne 0 -and $rootExited -and -not $present -and -not $proof.jobInherited) 'native retained-handle wait proves root exit after wrapper crash; full census independently supports it'
                if ($phase -eq 'suspended') { Assert-NativeProbe (-not (Test-Path -LiteralPath $marker)) 'suspended root must never execute before wrapper crash' }
                return @{ phase = $phase; root = $proof.root.Identity; rootGone = (-not $present); successfulSettlement = $false }
            } finally {
                if ($witness) { $witness.Dispose() }
                $logsReady = $process.WaitForExit(15000) -and [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask), 5000)
                if ($logsReady) {
                    [IO.File]::WriteAllText((Join-Path $phaseDir 'wrapper.stdout.log'), $stdoutTask.GetAwaiter().GetResult()); [IO.File]::WriteAllText((Join-Path $phaseDir 'wrapper.stderr.log'), $stderrTask.GetAwaiter().GetResult())
                } else { Write-NativeJobJson (Join-Path $phaseDir 'wrapper-log-timeout.json') @{ pid = $process.Id; error = 'Wrapper did not exit within bounded diagnostic wait; no unscoped cleanup attempted' } }
                $process.Dispose()
                Assert-NativeProbe $logsReady 'wrapper stdout/stderr diagnostics reach EOF within bounded final wait'
            }
        }
    }
} catch { $receipt.errors += $_.Exception.ToString() }
finally {
    $receipt.status = if ($receipt.errors.Count -or @($results | Where-Object passed -EQ $false).Count) { 'failed' } else { 'passed' }
    $receipt.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-NativeJobJson $receiptPath $receipt
}
if ($receipt.status -ne 'passed') { exit 1 }
# The caller gates on $LASTEXITCODE, which a script that only falls off its end leaves at
# whatever the last native command inside a probe returned (or unset when none ran).
exit 0
