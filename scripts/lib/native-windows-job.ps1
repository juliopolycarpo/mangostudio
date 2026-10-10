<#
.SYNOPSIS
Runs a native command in an atomically associated private Windows Job and preserves settlement evidence.
.EXAMPLE
powershell.exe -NoProfile -File scripts/lib/native-windows-job.ps1 -RequestPath C:\private\request.json
.NOTES
Qualification tooling. The tested source tree is a separate immutable checkout.
JOB_LIST/HANDLE_LIST: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
Job inheritance/close: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
Membership: https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject
FILETIME identity: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
Image metadata: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew
Same-object exit: https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject
#>
param([string]$RequestPath, [string]$AttestationPath)

# Load this engine's bundled commands without changing inherited PSModulePath or the exact child request environment.
foreach ($module in @('Microsoft.PowerShell.Utility', 'CimCmdlets')) {
    Import-Module -Name (Join-Path $PSHOME "Modules\$module\$module.psd1") -ErrorAction Stop
}

$script:NativeWindowsJobPath = $PSCommandPath
$script:NativeWindowsJobCode = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Mango.NativeJobProbe {
    internal static class Win32 {
        internal const uint QueryProcess = 0x1000, Synchronize = 0x100000, TerminateProcessAccess = 1;
        internal const uint WaitObject = 0, WaitTimeout = 258, WaitFailed = 0xffffffff;
        [StructLayout(LayoutKind.Sequential)] internal struct Security { internal int Length; internal IntPtr Descriptor; internal int Inherit; }
        [StructLayout(LayoutKind.Sequential)] internal struct Startup {
            internal uint Size; internal IntPtr Reserved, Desktop, Title;
            internal uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            internal ushort Show, ReservedBytes; internal IntPtr ReservedPointer, Stdin, Stdout, Stderr;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct StartupEx { internal Startup Startup; internal IntPtr Attributes; }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { internal IntPtr Process, Thread; internal uint Pid, Tid; }
        [StructLayout(LayoutKind.Sequential)] internal struct Limit {
            internal long ProcessTime, JobTime; internal uint Flags;
            internal UIntPtr MinWorkingSet, MaxWorkingSet; internal uint ProcessLimit;
            internal UIntPtr Affinity; internal uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct Io { internal ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimit {
            internal Limit Basic; internal Io Io;
            internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct Accounting {
            internal long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
            internal uint PageFaults, Total, Active, Terminated;
        }
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, uint size);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, out uint returned);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool GetHandleInformation(IntPtr handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool member);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
        internal static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + "; expected successful native call"); }
        internal static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { IntPtr old = handle; handle = IntPtr.Zero; Check(CloseHandle(old), "CloseHandle"); } }
    }

    public sealed class ToolMetadata {
        public string Path, FileVersion, ProductVersion, Sha256;
    }
    public sealed class Member {
        public uint Pid;
        public string Identity, CreationFileTime, Created, CensusIdentity, Path;
        public bool IsMember, Alive;
        public ToolMetadata Tool;
    }
    public sealed class Snapshot {
        public string At;
        public uint Assigned, Returned, ActiveBefore, ActiveAfter, TotalProcesses;
        public int NativeBytes, Races;
        public bool Stable, Empty;
        public Member[] Members;
    }
    public sealed class ImageResult {
        public bool Success;
        public int Error;
        public uint Characters;
        public string Path;
    }
    public sealed class ImageAttempt {
        public string At, QueryStartedAt, Operation, Outcome, StateError;
        public int Attempt, NativeError;
        public int? StateNativeError;
        public long ElapsedMilliseconds;
        public uint BufferCapacity, Characters;
        public Member Before, After;
        public bool? SameHandleExited;
    }
    /// <summary>Bound every image retry and list refresh in one complete job query with one monotonic clock.</summary>
    /// <example>var budget=new ImageQueryBudget(ImageQueryBudget.MaximumMilliseconds, ()=>clock.ElapsedMilliseconds);</example>
    public sealed class ImageQueryBudget {
        private readonly Func<long> clock;
        private readonly long started;
        /// <summary>Largest complete-query budget. Hosted queries with53/54 live members exhausted10s; allow20s total without scaling the cap with membership.</summary>
        public const int MaximumMilliseconds=20000;
        public readonly int Milliseconds;
        public readonly string StartedAt=DateTime.UtcNow.ToString("o",CultureInfo.InvariantCulture);
        public ImageQueryBudget(int milliseconds,Func<long> monotonicClock) {
            if(milliseconds<1 || milliseconds>MaximumMilliseconds || monotonicClock==null) throw new ArgumentException("Invalid image query budget " + milliseconds + "; expected1.." + MaximumMilliseconds + "ms and monotonic clock");
            Milliseconds=milliseconds; clock=monotonicClock; started=clock();
        }
        public long ElapsedMilliseconds { get { long elapsed=clock()-started; if(elapsed<0) throw new InvalidOperationException("Invalid negative image query elapsed " + elapsed + "; expected monotonic clock"); return elapsed; } }
        /// <summary>Reject exhausted shared time instead of multiplying waits by members or list refreshes.</summary>
        /// <example>budget.Require("QueryFullProcessImageNameW");</example>
        public void Require(string operation) { if(ElapsedMilliseconds>=Milliseconds) throw new InvalidOperationException("Image query budget exhausted after " + ElapsedMilliseconds + "ms at " + operation + "; expected complete attestation within " + Milliseconds + "ms"); }
    }
    /// <summary>Signal a confirmed exit of the same owned object; callers must obtain a new complete kernel snapshot.</summary>
    /// <example>catch(MemberExitedException) { refreshCompleteList=true; }</example>
    public sealed class MemberExitedException : InvalidOperationException {
        public MemberExitedException(string identity) : base("Exact member " + identity + " signaled exit; expected fresh complete job accounting before settlement") {}
    }
    /// <summary>Retry only image metadata on one already-owned handle until the shared budget ends; identity, membership and wait errors remain fatal.</summary>
    /// <example>var member=ImageQueryPolicy.Resolve(readSameHandle,queryImageSameHandle,waitSameHandle,budget,diagnostics,identity,path,true);</example>
    public static class ImageQueryPolicy {
        private static void ValidateState(Member state,Member original,bool requireMember) {
            long created;
            if(state==null || state.Pid==0 || !Int64.TryParse(state.CreationFileTime,out created) || created<=0 || created>2650467743999999999 ||
                state.Created!=DateTime.FromFileTimeUtc(created).ToString("o",CultureInfo.InvariantCulture) || state.Identity!=state.Pid.ToString(CultureInfo.InvariantCulture)+":"+state.Created)
                throw new InvalidOperationException("Invalid image-query process state " + (state==null?"null":state.Pid+"/"+state.CreationFileTime+"/"+state.Created+"/"+state.Identity) + "; expected positive PID and matching full100ns FILETIME identity");
            if(original!=null && (state.Pid!=original.Pid || state.Identity!=original.Identity || state.CreationFileTime!=original.CreationFileTime))
                throw new InvalidOperationException("Invalid image-query identity " + state.Identity + "; expected same retained object " + original.Identity);
            if(requireMember && !state.IsMember) throw new InvalidOperationException("Invalid recycled/outside-job image-query process " + state.Identity + "; expected exact-job membership");
        }
        private static bool AbsoluteImage(string path) {
            if(String.IsNullOrEmpty(path) || path.IndexOf('\0')>=0) return false;
            if(path.Length>=3 && Char.IsLetter(path[0]) && path[1]==':' && (path[2]=='\\' || path[2]=='/')) return true;
            if(!path.StartsWith("\\\\",StringComparison.Ordinal)) return false;
            string[] parts=path.Substring(2).Split('\\'); return parts.Length>=3 && parts[0].Length>0 && parts[1].Length>0 && parts[2].Length>0;
        }
        /// <summary>Resolve a fresh image with exact state checks before/after; only a same-handle signaled exit requests refresh.</summary>
        /// <example>ImageQueryPolicy.Resolve(read,query,wait,budget,attempts,fullIdentity,originalImage,true);</example>
        public static Member Resolve(Func<Member> readState,Func<ImageResult> queryImage,Func<int,bool> waitExited,ImageQueryBudget budget,List<ImageAttempt> diagnostics,string expectedIdentity,string expectedImage,bool requireMember) {
            Member original=readState(); ValidateState(original,null,requireMember);
            if(expectedIdentity!=null && original.Identity!=expectedIdentity) throw new InvalidOperationException("Invalid process identity " + original.Identity + "; expected " + expectedIdentity);
            ImageAttempt last=null;
            for(int attempt=1;;attempt++) {
                try {
                    budget.Require("QueryFullProcessImageNameW(" + original.Identity + ")");
                    Member before=readState(); ValidateState(before,original,requireMember);
                    bool exited=waitExited(0);
                    if(exited) throw new MemberExitedException(original.Identity);
                    if(!before.Alive) throw new InvalidOperationException("Invalid nonsignaled process state " + original.Identity + "; expected live same-handle state");
                    ImageResult image=queryImage();
                    if(image==null) throw new InvalidOperationException("Invalid null image result for " + original.Identity + "; expected native success/error evidence");
                    if(!image.Success) {
                        last=new ImageAttempt {At=DateTime.UtcNow.ToString("o",CultureInfo.InvariantCulture),QueryStartedAt=budget.StartedAt,Operation="QueryFullProcessImageNameW",Attempt=attempt,NativeError=image.Error,ElapsedMilliseconds=budget.ElapsedMilliseconds,BufferCapacity=32768,Characters=image.Characters,Before=before,Outcome="failed-image-query"};
                        diagnostics.Add(last);
                        Member after=readState(); last.After=after; ValidateState(after,original,requireMember);
                        last.SameHandleExited=waitExited(0);
                        if(last.SameHandleExited.Value) throw new MemberExitedException(original.Identity);
                        if(!after.Alive) throw new InvalidOperationException("Invalid nonsignaled failed-image state " + original.Identity + "; expected live same-handle state");
                        if(!requireMember) throw new Win32Exception(image.Error,"QueryFullProcessImageNameW PID=" + original.Pid + " FILETIME=" + original.CreationFileTime + " identity=" + original.Identity + " attempt=" + attempt + " Win32Error=" + image.Error + "; expected resolved live image on the same exact-job object");
                        string retry="(" + original.Identity + ") Win32Error=" + image.Error + " attempt=" + attempt;
                        budget.Require("image retry" + retry);
                        int delay=(int)Math.Min(10,budget.Milliseconds-budget.ElapsedMilliseconds);
                        last.SameHandleExited=waitExited(delay);
                        if(last.SameHandleExited.Value) throw new MemberExitedException(original.Identity);
                        budget.Require("image retry wait" + retry);
                        last.Outcome="retry-same-owned-handle"; continue;
                    }
                    if(!AbsoluteImage(image.Path) || image.Characters!=image.Path.Length || image.Characters>=32768)
                        throw new InvalidOperationException("Invalid image " + image.Path + "/" + image.Characters + " for " + original.Identity + "; expected nonempty complete absolute Win32 image");
                    if(expectedImage!=null && !String.Equals(image.Path,expectedImage,StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("Invalid changed image " + image.Path + " for " + original.Identity + "; expected " + expectedImage);
                    Member final=readState(); ValidateState(final,original,requireMember);
                    if(waitExited(0)) throw new MemberExitedException(original.Identity);
                    if(!final.Alive) throw new InvalidOperationException("Invalid nonsignaled resolved-image state " + original.Identity + "; expected live exact object");
                    budget.Require("resolved image(" + original.Identity + ")");
                    final.Path=image.Path;
                    if(last!=null) diagnostics.Add(new ImageAttempt {At=DateTime.UtcNow.ToString("o",CultureInfo.InvariantCulture),QueryStartedAt=budget.StartedAt,Operation="QueryFullProcessImageNameW",Attempt=attempt,ElapsedMilliseconds=budget.ElapsedMilliseconds,BufferCapacity=32768,Characters=image.Characters,Before=before,After=final,SameHandleExited=false,Outcome="recovered-same-owned-handle"});
                    return final;
                } catch(MemberExitedException) { if(last!=null) last.Outcome="same-handle-exit-requires-complete-refresh"; throw; }
                catch(Exception error) { if(last!=null) { last.Outcome="failed-closed"; last.StateError=error.ToString(); last.StateNativeError=error is Win32Exception?((Win32Exception)error).NativeErrorCode:(int?)null; } throw; }
            }
        }
    }
    internal sealed class HeldProcess {
        internal IntPtr Handle;
        internal Member Member;
    }

    /// <summary>Retain a query/synchronize-only process object for diagnostic exit proof; no termination authority.</summary>
    /// <example>using(var witness=new ProcessWitness(pid,fullIdentity)) { witness.WaitExited(5000); }</example>
    public sealed class ProcessWitness : IDisposable {
        private IntPtr process;
        public ProcessWitness(uint pid,string expectedIdentity) {
            process=Win32.OpenProcess(Win32.QueryProcess|Win32.Synchronize,false,pid);
            Win32.Check(process!=IntPtr.Zero,"OpenProcess(exact diagnostic witness)");
            try {
                long created,exit,kernel,user; Win32.Check(Win32.GetProcessTimes(process,out created,out exit,out kernel,out user),"GetProcessTimes(witness)");
                string actual=pid.ToString(CultureInfo.InvariantCulture)+":"+DateTime.FromFileTimeUtc(created).ToString("o",CultureInfo.InvariantCulture);
                if(actual!=expectedIdentity) throw new InvalidOperationException("Invalid witness identity " + actual + "; expected " + expectedIdentity);
            } catch { Dispose(); throw; }
        }
        /// <summary>Wait on the retained process object rather than treating missing/truncated CIM metadata as exit proof.</summary>
        /// <example>bool exited=witness.WaitExited(5000);</example>
        public bool WaitExited(int milliseconds) {
            uint result=Win32.WaitForSingleObject(process,checked((uint)milliseconds));
            if(result==Win32.WaitObject) return true;
            if(result==Win32.WaitTimeout) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error(),"WaitForSingleObject(exact witness)");
        }
        /// <summary>Release the diagnostic handle without terminating any process.</summary>
        /// <example>witness.Dispose();</example>
        public void Dispose() { Win32.Close(ref process); }
    }

    /// <summary>Own one private Job from atomic suspended creation through explicit evidence and final close.</summary>
    /// <example>var child = new JobProcess(application, argv, cwd, env, output); child.Resume();</example>
    public sealed class JobProcess : IDisposable {
        private IntPtr job, root, thread;
        private FileStream stdoutPipe, stderrPipe, combined;
        private Task stdoutTask, stderrTask;
        private volatile bool stdoutEof, stderrEof;
        private readonly List<string> pipeErrors = new List<string>();
        private readonly Dictionary<string, HeldProcess> held = new Dictionary<string, HeldProcess>();
        private readonly Dictionary<string, ToolMetadata> tools = new Dictionary<string, ToolMetadata>(StringComparer.OrdinalIgnoreCase);
        private readonly List<ImageAttempt> imageAttempts = new List<ImageAttempt>();
        private readonly object outputLock = new object();
        private uint rootPid;
        private uint? exitCode;
        public Member RootIdentity { get; private set; }
        public bool JobInherited { get; private set; }
        public uint CreationFlags { get { return 0x00000004 | 0x00000400 | 0x00080000; } }
        public uint JobLimitFlags { get { return 0x00002000; } }
        public bool StdoutEof { get { return stdoutEof; } }
        public bool StderrEof { get { return stderrEof; } }
        public bool PipesClosed { get { return stdoutEof && stderrEof && stdoutTask.IsCompleted && stderrTask.IsCompleted; } }
        public string[] PipeErrors { get { lock(outputLock) return pipeErrors.ToArray(); } }
        public ImageAttempt[] ImageQueryDiagnostics { get { return imageAttempts.ToArray(); } }

        /// <summary>Create the suspended root with only the intended stdio handles inherited.</summary>
        /// <example>new JobProcess(cargoExe, new[]{"cargo","build"}, cwd, env, logs);</example>
        public JobProcess(string application, string[] argv, string cwd, IDictionary<string,string> environment, string output) {
            if (IntPtr.Size != 8 || Marshal.SizeOf(typeof(Win32.StartupEx)) != 112 || Marshal.SizeOf(typeof(Win32.ExtendedLimit)) != 144 || Marshal.SizeOf(typeof(Win32.Accounting)) != 48)
                throw new InvalidOperationException("Invalid native layouts/pointer width " + IntPtr.Size + "; expected Windows x64 STARTUPINFOEX112/limits144/accounting48");
            IntPtr stdinRead=IntPtr.Zero, stdinWrite=IntPtr.Zero, stdoutRead=IntPtr.Zero, stdoutWrite=IntPtr.Zero, stderrRead=IntPtr.Zero, stderrWrite=IntPtr.Zero;
            IntPtr attributes=IntPtr.Zero, jobs=IntPtr.Zero, handles=IntPtr.Zero, block=IntPtr.Zero;
            bool initialized=false;
            try {
                ValidateText(application, "application"); ValidateText(cwd, "cwd");
                if (!System.IO.Path.IsPathRooted(application) || !File.Exists(application)) throw new ArgumentException("Invalid application " + application + "; expected existing absolute executable");
                if (argv == null || argv.Length == 0) throw new ArgumentException("Invalid argv; expected nonempty argument vector");
                job = Win32.CreateJobObjectW(IntPtr.Zero, IntPtr.Zero); Win32.Check(job != IntPtr.Zero, "CreateJobObjectW");
                Win32.Check(Win32.SetHandleInformation(job, 1, 0), "noninherited job handle");
                uint handleFlags; Win32.Check(Win32.GetHandleInformation(job, out handleFlags), "GetHandleInformation(job)");
                JobInherited = (handleFlags & 1) != 0;
                if (JobInherited) throw new InvalidOperationException("Invalid inheritable job; expected private noninherited handle");
                var limits = new Win32.ExtendedLimit(); limits.Basic.Flags = JobLimitFlags;
                Win32.Check(Win32.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "SetInformationJobObject(no breakaway/kill on close)");
                var security = new Win32.Security(); security.Length = Marshal.SizeOf(security);
                Win32.Check(Win32.CreatePipe(out stdinRead, out stdinWrite, ref security, 0), "CreatePipe(stdin)");
                Win32.Check(Win32.CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0), "CreatePipe(stdout)");
                Win32.Check(Win32.CreatePipe(out stderrRead, out stderrWrite, ref security, 0), "CreatePipe(stderr)");
                UIntPtr attributeBytes=UIntPtr.Zero;
                bool unexpected = Win32.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
                int probeError = Marshal.GetLastWin32Error();
                if (unexpected || probeError != 122 || attributeBytes.ToUInt64() == 0 || attributeBytes.ToUInt64() > 1048576)
                    throw new InvalidOperationException("Invalid attribute size probe " + attributeBytes + "/" + probeError + "; expected bounded ERROR_INSUFFICIENT_BUFFER");
                attributes=Marshal.AllocHGlobal(checked((int)attributeBytes.ToUInt64()));
                Win32.Check(Win32.InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeBytes), "InitializeProcThreadAttributeList"); initialized=true;
                jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
                handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,stdinRead); Marshal.WriteIntPtr(handles,IntPtr.Size,stdoutWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,stderrWrite);
                Win32.Check(Win32.UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x0002000d),jobs,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero), "UpdateProcThreadAttribute(JOB_LIST)");
                Win32.Check(Win32.UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x00020002),handles,new UIntPtr((uint)(IntPtr.Size*3)),IntPtr.Zero,IntPtr.Zero), "UpdateProcThreadAttribute(HANDLE_LIST)");
                char[] environmentBlock = EnvironmentBlock(environment);
                block=Marshal.AllocHGlobal(checked(environmentBlock.Length*2)); Marshal.Copy(environmentBlock,0,block,environmentBlock.Length);
                var startup = new Win32.StartupEx(); startup.Startup.Size=(uint)Marshal.SizeOf(startup); startup.Startup.Flags=0x100;
                startup.Startup.Stdin=stdinRead; startup.Startup.Stdout=stdoutWrite; startup.Startup.Stderr=stderrWrite; startup.Attributes=attributes;
                foreach (IntPtr handle in new[]{stdinRead,stdoutWrite,stderrWrite}) Win32.Check(Win32.SetHandleInformation(handle,1,1), "inherit child stdio");
                Win32.ProcessInfo info;
                bool created=Win32.CreateProcessW(application,new StringBuilder(CommandLine(argv)),IntPtr.Zero,IntPtr.Zero,true,CreationFlags,block,cwd,ref startup,out info);
                int createError=Marshal.GetLastWin32Error();
                if (created) { root=info.Process; thread=info.Thread; rootPid=info.Pid; }
                foreach (IntPtr handle in new[]{stdinRead,stdoutWrite,stderrWrite}) Win32.Check(Win32.SetHandleInformation(handle,1,0), "revoke child stdio inheritance");
                if (!created) throw new Win32Exception(createError,"CreateProcessW(atomic suspended JOB_LIST)");
                RootIdentity = Attest(root,rootPid,null);
                if (!RootIdentity.IsMember || !RootIdentity.Alive) throw new InvalidOperationException("Invalid suspended root; expected live exact job member");
                Directory.CreateDirectory(output);
                combined=new FileStream(System.IO.Path.Combine(output,"combined.log"),FileMode.Create,FileAccess.Write,FileShare.Read);
                stdoutPipe=new FileStream(new SafeFileHandle(stdoutRead,true),FileAccess.Read,65536,false); stdoutRead=IntPtr.Zero;
                stderrPipe=new FileStream(new SafeFileHandle(stderrRead,true),FileAccess.Read,65536,false); stderrRead=IntPtr.Zero;
                stdoutTask=Task.Run(()=>Pump(stdoutPipe,System.IO.Path.Combine(output,"stdout.log"),true));
                stderrTask=Task.Run(()=>Pump(stderrPipe,System.IO.Path.Combine(output,"stderr.log"),false));
            } catch { Dispose(); throw; }
            finally {
                foreach (IntPtr allocation in new[]{jobs,handles,block}) if (allocation!=IntPtr.Zero) Marshal.FreeHGlobal(allocation);
                if (initialized) Win32.DeleteProcThreadAttributeList(attributes);
                if (attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                foreach (IntPtr handle in new[]{stdinRead,stdinWrite,stdoutRead,stdoutWrite,stderrRead,stderrWrite}) if (handle!=IntPtr.Zero) Win32.CloseHandle(handle);
            }
        }

        /// <summary>Encode Windows argv using the same backslash/quote rules as the runtime helper.</summary>
        /// <example>JobProcess.CommandLine(new[]{"tool", "a b", "quote\""});</example>
        public static string CommandLine(string[] argv) {
            var result=new List<string>();
            foreach (string value in argv) {
                ValidateText(value,"argument");
                if (value.Length>0 && value.IndexOfAny(new[]{' ','\t','"'})<0) { result.Add(value); continue; }
                var text=new StringBuilder("\""); int slashes=0;
                foreach (char unit in value) {
                    if (unit=='\\') { slashes++; continue; }
                    if (unit=='"') { text.Append('\\',slashes*2+1).Append(unit); slashes=0; continue; }
                    text.Append('\\',slashes).Append(unit); slashes=0;
                }
                text.Append('\\',slashes*2).Append('"'); result.Add(text.ToString());
            }
            string line=String.Join(" ",result);
            if (line.Length>=32767) throw new ArgumentException("Invalid command line length " + line.Length + "; expected fewer than32767 UTF16 characters");
            return line;
        }
        /// <summary>Copy and case-insensitively order the exact Unicode environment with a double-NUL terminator.</summary>
        /// <example>JobProcess.EnvironmentBlock(new Dictionary&lt;string,string&gt;{{"CI","true"}});</example>
        public static char[] EnvironmentBlock(IDictionary<string,string> environment) {
            var sorted=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in environment) {
                ValidateText(pair.Key,"environment key"); ValidateText(pair.Value,"environment value");
                if (pair.Key.Length==0 || pair.Key.IndexOf('=')>=0) throw new ArgumentException("Invalid environment key " + pair.Key + "; expected nonempty key without '='");
                if (sorted.ContainsKey(pair.Key)) throw new ArgumentException("Invalid duplicate environment key " + pair.Key + "; expected unique case-insensitive names");
                sorted.Add(pair.Key,pair.Value);
            }
            var text=new StringBuilder(); foreach(var pair in sorted) text.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            text.Append('\0'); if(text.Length==1) text.Append('\0'); return text.ToString().ToCharArray();
        }
        private static void ValidateText(string value,string field) { if(value==null || value.IndexOf('\0')>=0) throw new ArgumentException("Invalid " + field + " " + (value==null?"null":value.Replace("\0","[NUL]")) + "; expected NUL-free string"); }
        private void Pump(FileStream input,string path,bool stdout) {
            try {
                using (input) using(var output=new FileStream(path,FileMode.Create,FileAccess.Write,FileShare.Read)) {
                    var bytes=new byte[65536]; int read;
                    while((read=input.Read(bytes,0,bytes.Length))>0) {
                        output.Write(bytes,0,read);
                        lock(outputLock) { combined.Write(bytes,0,read); combined.Flush(); }
                    }
                    output.Flush(); if(stdout) stdoutEof=true; else stderrEof=true;
                }
            } catch(Exception error) { lock(outputLock) pipeErrors.Add(error.ToString()); }
        }
        private static bool Alive(IntPtr process) {
            uint wait=Win32.WaitForSingleObject(process,0);
            if(wait==Win32.WaitTimeout) return true;
            if(wait==Win32.WaitObject) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error(),"WaitForSingleObject; expected live or exited process");
        }
        private Member ReadState(IntPtr process,uint pid,string knownIdentity) {
            long created,exit,kernel,user; Win32.Check(Win32.GetProcessTimes(process,out created,out exit,out kernel,out user),"GetProcessTimes PID=" + pid + " retainedIdentity=" + (knownIdentity??"not-yet-attested"));
            string date=DateTime.FromFileTimeUtc(created).ToString("o",CultureInfo.InvariantCulture);
            string identity=pid.ToString(CultureInfo.InvariantCulture)+":"+date;
            bool member; Win32.Check(Win32.IsProcessInJob(process,job,out member),"IsProcessInJob(exact job) PID=" + pid + " FILETIME=" + created + " identity=" + identity);
            string censusDate=DateTime.FromFileTimeUtc(created-created%10).ToString("o",CultureInfo.InvariantCulture);
            return new Member {Pid=pid,Identity=identity,CreationFileTime=created.ToString(CultureInfo.InvariantCulture),Created=date,CensusIdentity=pid.ToString(CultureInfo.InvariantCulture)+":"+censusDate,IsMember=member,Alive=!WaitExited(process,pid,0,identity)};
        }
        private static bool WaitExited(IntPtr process,uint pid,int milliseconds,string knownIdentity) {
            uint result=Win32.WaitForSingleObject(process,checked((uint)milliseconds)); int error=Marshal.GetLastWin32Error();
            if(result==Win32.WaitObject) return true;
            if(result==Win32.WaitTimeout) return false;
            throw new Win32Exception(error,"WaitForSingleObject PID=" + pid + " retainedIdentity=" + (knownIdentity??"not-yet-attested") + " wait=" + milliseconds + " Win32Error=" + error + "; expected same-handle live or signaled exit");
        }
        private static ImageQueryBudget NewImageBudget() {
            var clock=Stopwatch.StartNew(); return new ImageQueryBudget(ImageQueryBudget.MaximumMilliseconds,()=>clock.ElapsedMilliseconds);
        }
        private static ImageResult QueryImage(IntPtr process) {
            uint capacity=32768; var path=new StringBuilder((int)capacity);
            bool success=Win32.QueryFullProcessImageNameW(process,0,path,ref capacity); int error=Marshal.GetLastWin32Error();
            return new ImageResult {Success=success,Error=success?0:error,Characters=capacity,Path=success?path.ToString():null};
        }
        private Member Attest(IntPtr process,uint pid,string expected,ImageQueryBudget budget=null,string expectedImage=null,bool requireMember=true) {
            string knownIdentity=expected;
            Func<Member> read=()=> { Member state=ReadState(process,pid,knownIdentity); if(knownIdentity==null) knownIdentity=state.Identity; return state; };
            Member member=ImageQueryPolicy.Resolve(read,()=>QueryImage(process),milliseconds=>WaitExited(process,pid,milliseconds,knownIdentity),budget??NewImageBudget(),imageAttempts,expected,expectedImage,requireMember);
            member.Tool=Metadata(member.Path); return member;
        }
        private ToolMetadata Metadata(string path) {
            string name=System.IO.Path.GetFileName(path);
            if(!String.Equals(name,"cl.exe",StringComparison.OrdinalIgnoreCase) && !String.Equals(name,"link.exe",StringComparison.OrdinalIgnoreCase) && !String.Equals(name,"vctip.exe",StringComparison.OrdinalIgnoreCase)) return null;
            ToolMetadata metadata;
            if(tools.TryGetValue(path,out metadata)) return metadata;
            var version=FileVersionInfo.GetVersionInfo(path);
            using(var hash=SHA256.Create()) using(var file=File.OpenRead(path)) {
                metadata=new ToolMetadata {Path=path,FileVersion=version.FileVersion,ProductVersion=version.ProductVersion,Sha256=BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant()};
            }
            tools.Add(path,metadata); return metadata;
        }
        /// <summary>Resume only the retained, still suspended exact job root.</summary>
        /// <example>child.Resume();</example>
        public void Resume() {
            if(thread==IntPtr.Zero) throw new InvalidOperationException("Invalid released primary thread; expected one suspended root");
            Member rootNow=Attest(root,rootPid,RootIdentity.Identity,null,RootIdentity.Path);
            if(!rootNow.IsMember || !rootNow.Alive) throw new InvalidOperationException("Invalid resume origin; expected same live exact-job root");
            uint count=Win32.ResumeThread(thread);
            if(count!=1) throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread returned " + count + "; expected suspend count1");
            Win32.Close(ref thread);
        }
        /// <summary>Record root exit independently of pipe EOF and release exited handles before empty-job accounting.</summary>
        /// <example>uint? code = child.PollExit();</example>
        public uint? PollExit() {
            if(exitCode.HasValue) return exitCode;
            if(root==IntPtr.Zero || Alive(root)) return null;
            uint code; Win32.Check(Win32.GetExitCodeProcess(root,out code),"GetExitCodeProcess"); exitCode=code;
            Win32.Close(ref root); return exitCode;
        }
        private Win32.Accounting Accounting() {
            int bytes=Marshal.SizeOf(typeof(Win32.Accounting)); IntPtr data=Marshal.AllocHGlobal(bytes);
            try {
                uint returned; Win32.Check(Win32.QueryInformationJobObject(job,1,data,(uint)bytes,out returned),"QueryInformationJobObject(Accounting)");
                if(returned!=(uint)bytes) throw new InvalidOperationException("Invalid accounting length " + returned + "; expected " + bytes);
                return (Win32.Accounting)Marshal.PtrToStructure(data,typeof(Win32.Accounting));
            } finally { Marshal.FreeHGlobal(data); }
        }
        /// <summary>Reject incomplete/truncated native lists before interpreting any PID or empty census.</summary>
        /// <example>JobProcess.DecodeProcessList(buffer, bytes, returned);</example>
        public static uint[] DecodeProcessList(IntPtr data,int bytes,uint nativeReturned) {
            if(bytes<8 || nativeReturned<8 || nativeReturned>(uint)bytes) throw new InvalidOperationException("Invalid process list length " + nativeReturned + "/" + bytes + "; expected complete header within buffer");
            uint assigned=unchecked((uint)Marshal.ReadInt32(data,0)), count=unchecked((uint)Marshal.ReadInt32(data,4));
            if(assigned!=count || count>8192 || 8L+count*IntPtr.Size>nativeReturned) throw new InvalidOperationException("Invalid process list counts " + assigned + "/" + count + "/" + nativeReturned + "; expected complete bounded PID array");
            var pids=new uint[count]; var unique=new HashSet<uint>();
            for(int i=0;i<pids.Length;i++) {
                long value=Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt64();
                if(value<=0 || value>UInt32.MaxValue || !unique.Add((uint)value)) throw new InvalidOperationException("Invalid job PID " + value + "; expected unique positive uint32");
                pids[i]=(uint)value;
            }
            return pids;
        }
        private uint[] ProcessList(out int nativeBytes) {
            int capacity=32;
            for(int attempt=0;attempt<10;attempt++) {
                int bytes=checked(8+capacity*IntPtr.Size); IntPtr data=Marshal.AllocHGlobal(bytes);
                try {
                    uint returned; bool success=Win32.QueryInformationJobObject(job,3,data,(uint)bytes,out returned); int error=Marshal.GetLastWin32Error();
                    if(!success && error!=234) throw new Win32Exception(error,"QueryInformationJobObject(ProcessIdList)");
                    uint assigned=unchecked((uint)Marshal.ReadInt32(data,0)), count=unchecked((uint)Marshal.ReadInt32(data,4));
                    if(!success || count<assigned) {
                        long next=Math.Max(capacity*2L,assigned);
                        if(next>8192 || next<=capacity) throw new InvalidOperationException("Invalid job PID capacity " + next + "; expected bounded complete process list");
                        capacity=(int)next; continue;
                    }
                    uint[] pids=DecodeProcessList(data,bytes,returned); nativeBytes=(int)returned; return pids;
                } finally { Marshal.FreeHGlobal(data); }
            }
            throw new InvalidOperationException("Incomplete job process list after10 queries; expected complete native result");
        }
        private void ReleaseExited() {
            var remove=new List<string>();
            foreach(var pair in held) if(!Alive(pair.Value.Handle)) { Win32.Close(ref pair.Value.Handle); remove.Add(pair.Key); }
            foreach(string identity in remove) held.Remove(identity);
        }
        /// <summary>Query exact job membership and live process-handle identities; transient exited members trigger bounded refresh.</summary>
        /// <example>Snapshot before = child.Query();</example>
        public Snapshot Query() {
            if(job==IntPtr.Zero) throw new InvalidOperationException("Invalid closed job handle; expected retained exact job");
            int races=0; ImageQueryBudget budget=NewImageBudget();
            for(int attempt=0;attempt<12;attempt++) {
                budget.Require("complete job list refresh" + attempt);
                ReleaseExited(); Win32.Accounting before=Accounting(); int bytes; uint[] pids=ProcessList(out bytes); var members=new List<Member>(); bool retry=false;
                foreach(uint pid in pids) {
                    IntPtr handle=Win32.OpenProcess(Win32.QueryProcess|Win32.Synchronize,false,pid);
                    if(handle==IntPtr.Zero) {
                        int error=Marshal.GetLastWin32Error();
                        if(error==87 || error==1168) { retry=true; races++; break; }
                        throw new Win32Exception(error,"OpenProcess(" + pid + "); expected queryable exact job member");
                    }
                    try {
                        if(!Alive(handle)) { retry=true; races++; break; }
                        Member member=Attest(handle,pid,null,budget);
                        if(!member.IsMember) throw new InvalidOperationException("Invalid recycled/outside-job PID " + pid + "; expected exact-job process object");
                        if(!member.Alive) { retry=true; races++; break; }
                        HeldProcess existing;
                        if(held.TryGetValue(member.Identity,out existing)) member=Attest(existing.Handle,pid,member.Identity,budget,existing.Member.Path);
                        else { held.Add(member.Identity,new HeldProcess{Handle=handle,Member=member}); handle=IntPtr.Zero; }
                        members.Add(member);
                    } catch(MemberExitedException) { retry=true; races++; break; }
                    finally { Win32.Close(ref handle); }
                }
                if(retry) { Thread.Sleep(10); continue; }
                Win32.Accounting after=Accounting(); budget.Require("complete job accounting result"); bool stable=before.Active==after.Active && after.Active==(uint)members.Count;
                return new Snapshot {At=DateTime.UtcNow.ToString("o"),Assigned=(uint)pids.Length,Returned=(uint)pids.Length,ActiveBefore=before.Active,ActiveAfter=after.Active,TotalProcesses=after.Total,NativeBytes=bytes,Races=races,Stable=stable,Empty=stable && members.Count==0,Members=members.ToArray()};
            }
            throw new InvalidOperationException("Unstable member identity after12 refreshes; expected complete attested membership");
        }
        /// <summary>Terminate only one retained identity after reattesting membership; never terminate a PID lookup or the whole job.</summary>
        /// <example>child.TerminateVerifiedMember(vctip.Identity, 5000);</example>
        public void TerminateVerifiedMember(string identity,int waitMilliseconds) {
            HeldProcess owned;
            if(!held.TryGetValue(identity,out owned)) throw new InvalidOperationException("Invalid cleanup identity " + identity + "; expected retained exact member");
            ImageQueryBudget budget=NewImageBudget();
            Member before=Attest(owned.Handle,owned.Member.Pid,identity,budget,owned.Member.Path);
            if(!before.IsMember || !before.Alive) throw new InvalidOperationException("Invalid cleanup state " + identity + "; expected live exact job member");
            IntPtr terminate=Win32.OpenProcess(Win32.QueryProcess|Win32.Synchronize|Win32.TerminateProcessAccess,false,before.Pid);
            Win32.Check(terminate!=IntPtr.Zero,"OpenProcess(verified termination rights)");
            try {
                Member fresh=Attest(terminate,before.Pid,identity,budget,before.Path);
                if(!fresh.IsMember || !fresh.Alive) throw new InvalidOperationException("Invalid cleanup membership " + identity + "; expected same live exact-job object");
                Win32.Check(Win32.TerminateProcess(terminate,1),"TerminateProcess(retained verified member)");
                uint wait=Win32.WaitForSingleObject(terminate,checked((uint)waitMilliseconds));
                if(wait!=Win32.WaitObject) throw new InvalidOperationException("Incomplete termination wait " + wait + " for " + identity + "; expected signaled process handle");
            } finally { Win32.Close(ref terminate); }
            ReleaseExited();
        }
        /// <summary>Check a retained member handle against externally presented creation identity without PID authority.</summary>
        /// <example>child.VerifyIdentity(member.Identity);</example>
        public Member VerifyIdentity(string identity) {
            HeldProcess owned; if(!held.TryGetValue(identity,out owned)) throw new InvalidOperationException("Invalid identity " + identity + "; expected retained creation identity");
            return Attest(owned.Handle,owned.Member.Pid,identity,null,owned.Member.Path);
        }
        /// <summary>Map a current CIM row through a fresh process object and exact job membership; this grants no cleanup authority.</summary>
        /// <example>Member native=child.CensusIdentity(cimPid);</example>
        public Member CensusIdentity(uint pid) {
            if(job==IntPtr.Zero) throw new InvalidOperationException("Invalid closed census job; expected retained exact job");
            IntPtr process=Win32.OpenProcess(Win32.QueryProcess|Win32.Synchronize,false,pid);
            Win32.Check(process!=IntPtr.Zero,"OpenProcess(CIM identity consistency)");
            try { return Attest(process,pid,null,null,null,false); } finally { Win32.Close(ref process); }
        }
        /// <summary>Close the exact job as separately recorded final failure containment; this is never settlement proof.</summary>
        /// <example>child.CloseJob();</example>
        public void CloseJob() { Win32.Close(ref job); }
        /// <summary>Release wrapper resources after pre-close evidence; job close contains an interrupted command.</summary>
        /// <example>child.Dispose();</example>
        public void Dispose() {
            Win32.Close(ref job); Win32.Close(ref thread); Win32.Close(ref root);
            foreach(var pair in held) Win32.Close(ref pair.Value.Handle); held.Clear();
            if(stdoutTask!=null && stderrTask!=null) Task.WaitAll(new[]{stdoutTask,stderrTask},5000);
            if(stdoutPipe!=null) stdoutPipe.Dispose(); if(stderrPipe!=null) stderrPipe.Dispose();
            lock(outputLock) { if(combined!=null) { combined.Dispose(); combined=null; } }
        }
    }
}
'@

<#
.SYNOPSIS
Loads the runner-native interop once, before any process effects.
.EXAMPLE
Initialize-NativeWindowsJob
#>
function Initialize-NativeWindowsJob {
    if (-not ('Mango.NativeJobProbe.JobProcess' -as [type])) {
        Add-Type -TypeDefinition $script:NativeWindowsJobCode -ErrorAction Stop
    }
}

<#
.SYNOPSIS
Attests the actual installed x64 MSVC tools independently of child process observations.
.EXAMPLE
$inventory = Get-NativeJobToolInventory
#>
function Get-NativeJobToolInventory {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64 -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [Runtime.InteropServices.Architecture]::X64) { throw 'Invalid inventory host; expected native Windows x64 with 64-bit PowerShell' }
    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $vswhere = Join-Path $programFiles 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not [IO.File]::Exists($vswhere)) { throw "Missing installer inventory $vswhere; expected installed vswhere.exe" }
    $installations = @(& $vswhere -all -products '*' -format json -utf8 | ConvertFrom-Json -ErrorAction Stop)
    if ($LASTEXITCODE -ne 0 -or -not $installations.Count) { throw "Invalid vswhere inventory exit=$LASTEXITCODE count=$($installations.Count); expected installed Visual Studio toolsets" }
    $tools = [Collections.Generic.List[object]]::new()
    foreach ($installation in $installations) {
        if (-not [IO.Path]::IsPathRooted([string]$installation.installationPath)) { throw "Invalid installation $($installation.installationPath); expected absolute installed path" }
        $base = Join-Path $installation.installationPath 'VC\Tools\MSVC'
        if (-not [IO.Directory]::Exists($base)) { continue }
        foreach ($toolset in Get-ChildItem -LiteralPath $base -Directory -ErrorAction Stop) {
            $bin = Join-Path $toolset.FullName 'bin\Hostx64\x64'
            if (-not [IO.File]::Exists((Join-Path $bin 'vctip.exe'))) { continue }
            foreach ($name in @('cl.exe', 'link.exe', 'vctip.exe')) {
                $path = Join-Path $bin $name
                if (-not [IO.File]::Exists($path)) { throw "Incomplete installed toolset $path; expected cl.exe, link.exe and vctip.exe" }
                $item = Get-Item -LiteralPath $path -ErrorAction Stop
                if (-not $item.VersionInfo.FileVersion -or -not $item.VersionInfo.ProductVersion) { throw "Missing version metadata $path; expected actual installed file and product versions" }
                $tools.Add([pscustomobject]@{ path = $item.FullName; fileVersion = $item.VersionInfo.FileVersion; productVersion = $item.VersionInfo.ProductVersion; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() })
            }
        }
    }
    if (-not $tools.Count) { throw 'Empty installed MSVC tool inventory; expected actual Hostx64/x64 compiler toolsets' }
    return [pscustomobject]@{ os64Bit = [Environment]::Is64BitOperatingSystem; process64Bit = [Environment]::Is64BitProcess; installations = $installations; installedTools = $tools.ToArray() }
}

<#
.SYNOPSIS
Reads private request JSON as strict UTF8 with an optional UTF8 BOM before any native launch.
.EXAMPLE
$request = Read-NativeJobRequest C:\private\request.json
#>
function Read-NativeJobRequest([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { 3 } else { 0 }
    try { $json = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset) }
    catch { throw "Invalid request encoding at $Path; expected valid UTF8 JSON with optional UTF8 BOM" }
    try { return ConvertFrom-Json -InputObject $json -ErrorAction Stop }
    catch { throw "Invalid request JSON at $Path; expected valid UTF8 JSON without exposing private request values" }
}

<#
.SYNOPSIS
Writes receipt data as UTF8 without changing any raw command pipe bytes.
.EXAMPLE
Write-NativeJobJson C:\evidence\receipt.json $receipt
#>
function Write-NativeJobJson([string]$Path, [object]$Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Depth 40) + "`n", [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) } else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

<#
.SYNOPSIS
Names an MSVC compiler helper from its image name, image path or command line.
.EXAMPLE
$isHelper = Test-NativeJobCompilerHelper 'vctip.exe' $null $null
#>
function Test-NativeJobCompilerHelper([string]$Name, [string]$Path, [string]$Command) {
    return [bool]($Name -match '^(vctip|cl|link|mspdbsrv|mspdbcmf|mspdbcore|c1|c1xx|c2|ml|ml64|rc|mt)\.exe$' -or $Path -match '\\VC\\Tools\\MSVC\\' -or $Command -match '\\VC\\Tools\\MSVC\\')
}

<#
.SYNOPSIS
Preserves full native process identities independently of the private job, keeping a command line only for the job's own observed members.
.EXAMPLE
$before = Get-NativeJobCensus
$current = Get-NativeJobCensus @($seen.Values)
#>
function Get-NativeJobCensus([object[]]$Members = @()) {
    $owned = @{}
    foreach ($member in @($Members)) { if ($member -and $member.CensusIdentity) { $owned[[string]$member.CensusIdentity] = $true } }
    $rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop | Where-Object ProcessId -GT 0 | ForEach-Object {
        if (-not $_.CreationDate -or -not $_.Name) { throw "Invalid creation date/name for PID $($_.ProcessId); expected native process metadata" }
        $created = $_.CreationDate.ToUniversalTime().ToString('o')
        $identity = "$($_.ProcessId):$created"
        # Another program's command line is not this evidence and may carry its secrets. Only the helper verdict drawn from it is kept.
        $isHelper = Test-NativeJobCompilerHelper $_.Name $_.ExecutablePath $_.CommandLine
        $command = if ($owned.ContainsKey($identity)) { $_.CommandLine } else { $null }
        [pscustomobject]@{ pid = [uint32]$_.ProcessId; parentPid = [uint32]$_.ParentProcessId; created = $created; identity = $identity; name = $_.Name; path = $_.ExecutablePath; command = $command; compilerHelper = $isHelper }
    })
    Assert-NativeJobCensus $rows
    return ,$rows
}

<#
.SYNOPSIS
Rejects empty or malformed full censuses while the observer is known to be alive.
.EXAMPLE
Assert-NativeJobCensus $rows
#>
function Assert-NativeJobCensus([object[]]$Rows) {
    if (-not $Rows.Count -or -not @($Rows | Where-Object pid -EQ $PID).Count) { throw "Invalid full census count $($Rows.Count); expected the live observer PID $PID" }
    foreach ($row in $Rows) {
        if (-not $row.pid -or -not $row.name -or -not $row.created -or $row.identity -ne "$($row.pid):$($row.created)") { throw "Invalid census row $($row | ConvertTo-Json -Compress); expected positive PID, name and creation identity" }
    }
}

<#
.SYNOPSIS
Flags new MSVC helper identities outside the exact job without granting termination authority.
.EXAMPLE
$unknown = Find-NativeJobAmbiguity $before $preCleanup $snapshot.Members
#>
function Find-NativeJobAmbiguity([object[]]$Before, [object[]]$Current, [object[]]$Members, [object]$Verifier = $null, [object]$Mappings = $null) {
    $original = @{}; foreach ($row in $Before) { $original[$row.identity] = $true }
    $owned = @{}; foreach ($row in $Members) { $owned[$row.Identity] = $row }
    $helpers = @($Current | Where-Object {
        -not $original.ContainsKey($_.identity) -and
        ($_.compilerHelper -eq $true -or (Test-NativeJobCompilerHelper $_.name $_.path $_.command))
    })
    $unknown = [Collections.Generic.List[object]]::new()
    foreach ($row in $helpers) {
        $native = $null; $matched = $false; $error = $null
        try {
            if ($Verifier) {
                $native = $Verifier.CensusIdentity([uint32]$row.pid)
                $matched = $native.IsMember -and $native.Alive -and $owned.ContainsKey($native.Identity) -and
                    $native.CensusIdentity -eq $row.identity -and [IO.Path]::GetFileName($native.Path) -ieq $row.name -and
                    (-not $row.path -or $row.path -ieq $native.Path)
            }
        } catch { $error = $_.Exception.ToString() }
        $mapping = [pscustomobject]@{ censusIdentity = $row.identity; nativeIdentity = $native.Identity; nativeCreationFileTime = $native.CreationFileTime; exactJobMember = $native.IsMember; live = $native.Alive; retainedMemberMatched = $matched; queryError = $error }
        if ($null -ne $Mappings) { $Mappings.Add($mapping) }
        if (-not $matched) { $unknown.Add($row) }
    }
    return $unknown.ToArray()
}

<#
.SYNOPSIS
Gates the last open-job and full-census boundary, persisting any failure before scoped final containment.
.EXAMPLE
Complete-NativeJobEvidence $receipt $child $before C:\evidence
#>
function Complete-NativeJobEvidence([object]$Receipt, [object]$Child, [object[]]$Before, [string]$Out, [scriptblock]$Census = ${function:Get-NativeJobCensus}, [object]$CensusContext = $null) {
    $receiptPath = Join-Path $Out 'job-receipt.json'
    $Receipt.finalClose = @{ at = [DateTime]::UtcNow.ToString('o'); preClose = $null; queryError = $null; census = @(); outcomeBeforeClose = $Receipt.status; operation = 'CloseHandle(private kill-on-close job)'; successfulSettlementEvidence = $false }
    try {
        $Receipt.finalClose.preClose = $Child.Query()
        if (-not $Receipt.finalClose.preClose.Empty -or -not $Receipt.finalClose.preClose.Stable -or
            $Receipt.finalClose.preClose.Assigned -ne 0 -or $Receipt.finalClose.preClose.Returned -ne 0 -or
            $Receipt.finalClose.preClose.ActiveBefore -ne 0 -or $Receipt.finalClose.preClose.ActiveAfter -ne 0 -or $Receipt.finalClose.preClose.Members.Count) { throw "Final open-job snapshot retained $($Receipt.finalClose.preClose.Members.Count) members; expected complete stable empty before close" }
        $full = & $Census $CensusContext; Assert-NativeJobCensus $full
        $Receipt.finalClose.census = $full
        $unknown = @(Find-NativeJobAmbiguity $Before $full $Receipt.finalClose.preClose.Members $Child)
        if ($unknown.Count) { throw "Final open-job census has $($unknown.Count) new unattributed MSVC helpers; expected none" }
    } catch { $Receipt.finalClose.queryError = $_.Exception.ToString(); $Receipt.errors += "Final boundary failed: $($_.Exception.ToString())"; $Receipt.status = 'failed' }
    if ($Child.PSObject.Properties['ImageQueryDiagnostics']) { $Receipt.imageQueryDiagnostics = @($Child.ImageQueryDiagnostics) }
    $Receipt.finalClose.outcomeBeforeClose = $Receipt.status
    Write-NativeJobJson $receiptPath $Receipt
    try { $Child.CloseJob(); $Child.Dispose() } catch { $Receipt.errors += "Final exact-job close failed: $($_.Exception.ToString())"; $Receipt.status = 'failed' }
    try {
        $full = & $Census $CensusContext; Assert-NativeJobCensus $full
        $Receipt.postCloseCensus = $full; Write-NativeJobJson (Join-Path $Out 'processes-post-close.json') $full
        $unknown = @(Find-NativeJobAmbiguity $Before $full @())
        if ($unknown.Count) { throw "Post-close census has $($unknown.Count) new unattributed MSVC helpers; expected none" }
    } catch { $Receipt.errors += "Post-close full census failed: $($_.Exception.ToString())"; $Receipt.status = 'failed' }
    Write-NativeJobJson $receiptPath $Receipt
}

<#
.SYNOPSIS
Rejects compiler cleanup unless exact default Cargo, complete successful JSON, closed pipes and actual VCTIP metadata agree.
.EXAMPLE
$eligibility = Get-NativeJobCompilerEligibility $request $snapshot 0 $true @() C:\evidence\stdout.log @()
#>
function Get-NativeJobCompilerEligibility([object]$Request, [object]$Snapshot, [object]$ExitCode, [bool]$PipesClosed, [string[]]$Errors, [string]$StdoutPath, [object[]]$Ambiguity) {
    $reasons = [Collections.Generic.List[string]]::new()
    $runtimeArgs = @('build', '-p', 'mangostudio-runtime', '--bin', 'mangostudio-runtime', '--locked', '--message-format=json')
    $fakeArgs = @('build', '-p', 'mangostudio-runtime', '--example', 'fake_cursor_agent', '--locked', '--message-format=json')
    $actualArgs = @($Request.command | Select-Object -Skip 1)
    $buildTarget = if (($actualArgs -join [char]0) -ceq ($runtimeArgs -join [char]0)) { 'runtime' } elseif (($actualArgs -join [char]0) -ceq ($fakeArgs -join [char]0)) { 'fake' } else { $null }
    if ($Request.mode -ne 'msvc-compile' -or [IO.Path]::GetFileName($Request.application) -ine 'cargo.exe' -or
        ($Request.command[0] -cne 'cargo' -and [IO.Path]::GetFileName($Request.command[0]) -cne 'cargo.exe') -or
        -not $buildTarget) {
        $reasons.Add('Invalid cleanup command; expected explicit msvc-compile mode with original runtime or fake-agent Cargo argv')
    }
    if ($null -eq $ExitCode -or $ExitCode -ne 0 -or -not $PipesClosed -or $Errors.Count -or $Ambiguity.Count) { $reasons.Add('Invalid compiler completion; expected exit0, both pipe EOFs, no errors and no outside-job ambiguity') }
    if (-not $Snapshot -or -not $Snapshot.Stable -or $Snapshot.Assigned -ne $Snapshot.Returned -or $Snapshot.ActiveAfter -ne @($Snapshot.Members).Count) { $reasons.Add('Invalid membership snapshot; expected complete stable exact-job membership') }
    $tools = @($Request.expectedVctip)
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if (-not $tools.Count) { $reasons.Add('Missing VCTIP inventory; expected independently attested installed MSVC tools') }
    foreach ($tool in $tools) {
        if (-not $tool -or -not [IO.Path]::IsPathRooted([string]$tool.path) -or $tool.path -notmatch '\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\vctip\.exe$' -or
            $tool.sha256 -notmatch '^[a-f0-9]{64}$' -or -not $tool.fileVersion -or -not $tool.productVersion -or -not $paths.Add([string]$tool.path)) { $reasons.Add("Invalid expected VCTIP metadata $($tool | ConvertTo-Json -Compress); expected unique installed absolute MSVC Hostx64/x64 tool paths, versions and SHA256") }
    }
    foreach ($member in @($Snapshot.Members)) {
        $matching = @($tools | Where-Object { $_.path -ieq $member.Path })
        $tool = if ($matching.Count -eq 1) { $matching[0] } else { $null }
        if (-not $member.IsMember -or -not $member.Alive -or -not $member.CreationFileTime -or $member.Identity -ne "$($member.Pid):$($member.Created)" -or
            -not $tool -or -not $member.Tool -or $member.Path -ine $tool.path -or $member.Tool.Path -ine $tool.path -or
            $member.Tool.FileVersion -ne $tool.fileVersion -or $member.Tool.ProductVersion -ne $tool.productVersion -or $member.Tool.Sha256 -ne $tool.sha256) {
            $reasons.Add("Invalid cleanup member $($member.Identity) at $($member.Path); expected live retained actual VCTIP identity and matching tool metadata")
        }
    }
    $artifacts = @(); $sdk = @(); $finished = $false
    try {
        $rows = @([IO.File]::ReadAllLines($StdoutPath, [Text.UTF8Encoding]::new($false, $true)) | Where-Object { $_.Trim() } | ForEach-Object { ConvertFrom-Json -InputObject $_ -ErrorAction Stop })
        if (-not $rows.Count -or $rows[-1].reason -ne 'build-finished' -or $rows[-1].success -ne $true -or
            @($rows | Where-Object { $_.reason -notin @('compiler-artifact', 'compiler-message', 'build-script-executed', 'build-finished') }).Count -or
            @($rows | Where-Object reason -EQ 'build-finished').Count -ne 1) { throw 'Incomplete compiler JSON; expected one final build-finished success and known Cargo messages' }
        $finished = $true
        $artifacts = @($rows | Where-Object reason -EQ 'compiler-artifact')
        $sdk = @($artifacts | Where-Object { $_.package_id -match 'mango-external-agents' })
        $sdkFeatures = if ($buildTarget -eq 'fake') { @('stdio', 'testing') } else { @('stdio') }
        if (-not $sdk.Count -or @($sdk | Where-Object { (@($_.features | Sort-Object) -join [char]0) -cne ($sdkFeatures -join [char]0) }).Count) { throw "Invalid SDK features; expected $($sdkFeatures -join ',') for $buildTarget setup" }
        $targetName = if ($buildTarget -eq 'fake') { 'fake_cursor_agent' } else { 'mangostudio-runtime' }
        $targetKind = if ($buildTarget -eq 'fake') { 'example' } else { 'bin' }
        $primary = @($artifacts | Where-Object { $_.target.name -eq $targetName -and $_.executable -and $_.target.kind -contains $targetKind })
        if (-not $primary.Count -or @($primary | Where-Object { @($_.features).Count }).Count) { throw "Invalid primary artifact for $targetName; expected actual $targetKind executable and default empty feature set" }
    } catch { $reasons.Add("Compiler receipt rejected: $($_.Exception.Message)") }
    return [pscustomobject]@{ eligible = ($reasons.Count -eq 0); reasons = @($reasons); buildTarget = $buildTarget; buildFinished = $finished; artifactCount = $artifacts.Count; sdkFeatures = @($sdk | ForEach-Object { ,@($_.features) }) }
}

<#
.SYNOPSIS
Runs one attempt, records natural settlement before any cleanup, and admits only verified compiler VCTIP handle cleanup.
.EXAMPLE
$receipt = Invoke-NativeWindowsJob (Read-NativeJobRequest C:\private\request.json)
#>
function Invoke-NativeWindowsJob([object]$Request) {
    $ErrorActionPreference = 'Stop'
    $out = [IO.Path]::GetFullPath([string]$Request.out)
    [IO.Directory]::CreateDirectory($out) | Out-Null
    $receiptPath = Join-Path $out 'job-receipt.json'
    $receipt = [ordered]@{
        schemaVersion = 1; status = 'running'; startedAt = [DateTime]::UtcNow.ToString('o'); finishedAt = $null
        sourceSha = $Request.sourceSha; workflowSha = $Request.workflowSha; helperSha256 = (Get-FileHash -LiteralPath $script:NativeWindowsJobPath -Algorithm SHA256).Hash.ToLowerInvariant()
        command = $Request.command; application = $Request.application; root = $Request.root; mode = $Request.mode
        os64Bit = [Environment]::Is64BitOperatingSystem; process64Bit = [Environment]::Is64BitProcess
        timeoutSeconds = $Request.timeoutSeconds; observationMs = $Request.observationMs; timedOut = $false
        rootIdentity = $null; rootExitAt = $null; exitCode = $null; stdoutEof = $false; stderrEof = $false
        job = $null; naturalSettlement = $null; eligibility = $null; preCleanup = $null; cleanupActions = @(); naturalExits = @(); postCleanup = $null
        before = @(); preCleanupCensus = @(); postCleanupCensus = @(); ambiguity = @(); censusMappings = [Collections.Generic.List[object]]::new(); finalClose = $null; postCloseCensus = @(); observed = @(); imageQueryDiagnostics = @(); errors = @()
    }
    Write-NativeJobJson $receiptPath $receipt
    $child = $null; $seen = @{}; $before = @(); $snapshot = $null
    try {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64 -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [Runtime.InteropServices.Architecture]::X64) { throw 'Invalid native helper host; expected actual Windows x64 and a 64-bit PowerShell process' }
        if ($Request.mode -notin @('strict', 'msvc-compile') -or $Request.timeoutSeconds -le 0 -or $Request.timeoutSeconds -gt 900 -or $Request.observationMs -lt 0 -or $Request.observationMs -gt 30000) { throw "Invalid command policy $($Request.mode)/$($Request.timeoutSeconds)/$($Request.observationMs); expected strict or msvc-compile with timeout1..900s and observation0..30000ms" }
        Initialize-NativeWindowsJob
        $before = Get-NativeJobCensus; $receipt.before = $before; Write-NativeJobJson (Join-Path $out 'processes-before.json') $before
        $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Request.environment.PSObject.Properties) { $environment.Add($property.Name, [string]$property.Value) }
        $logDir = Join-Path $out 'logs'
        $child = [Mango.NativeJobProbe.JobProcess]::new([string]$Request.application, [string[]]$Request.command, [string]$Request.root, $environment, $logDir)
        $receipt.rootIdentity = $child.RootIdentity
        $receipt.job = @{ atomicJobList = $true; suspended = $true; inherited = $child.JobInherited; limitFlags = $child.JobLimitFlags; creationFlags = $child.CreationFlags; breakaway = $false; notificationsAuthority = $false }
        $snapshot = $child.Query(); Write-NativeJobJson (Join-Path $out 'suspended-members.json') $snapshot
        Write-NativeJobJson $receiptPath $receipt
        $child.Resume()
        $started = [Diagnostics.Stopwatch]::StartNew()
        $exit = $null
        do {
            $exit = $child.PollExit()
            $snapshot = $child.Query()
            foreach ($member in $snapshot.Members) { $seen[$member.Identity] = $member }
            [IO.File]::AppendAllText((Join-Path $out 'job-members.jsonl'), (ConvertTo-Json -InputObject $snapshot -Depth 15 -Compress) + "`n", [Text.UTF8Encoding]::new($false))
            if ($null -ne $exit -and -not $receipt.rootExitAt) { $receipt.rootExitAt = [DateTime]::UtcNow.ToString('o'); $receipt.exitCode = $exit }
            if ($started.Elapsed.TotalSeconds -ge $Request.timeoutSeconds) { $receipt.timedOut = $true; throw "Command timed out after $($Request.timeoutSeconds)s; expected root exit and closed pipes" }
            if ($child.PipeErrors.Count) { throw "Raw pipe capture failed: $($child.PipeErrors -join '; ')" }
            if ($null -eq $exit -or -not $child.PipesClosed) { Start-Sleep -Milliseconds 100 }
        } while ($null -eq $exit -or -not $child.PipesClosed)
        $receipt.stdoutEof = $child.StdoutEof; $receipt.stderrEof = $child.StderrEof
        if ($exit -ne 0) { $receipt.errors += "Root exited $exit; expected exit0" }
        $observe = [Diagnostics.Stopwatch]::StartNew()
        do {
            $snapshot = $child.Query()
            foreach ($member in $snapshot.Members) { $seen[$member.Identity] = $member }
            [IO.File]::AppendAllText((Join-Path $out 'job-observation.jsonl'), (ConvertTo-Json -InputObject $snapshot -Depth 15 -Compress) + "`n", [Text.UTF8Encoding]::new($false))
            if ($observe.ElapsedMilliseconds -lt $Request.observationMs) { Start-Sleep -Milliseconds 100 }
        } while ($observe.ElapsedMilliseconds -lt $Request.observationMs)
        $receipt.naturalSettlement = @{ empty = $snapshot.Empty; observedMs = $observe.ElapsedMilliseconds; snapshot = $snapshot }
        $receipt.preCleanupCensus = Get-NativeJobCensus @($seen.Values)
        Write-NativeJobJson (Join-Path $out 'processes-pre-cleanup.json') $receipt.preCleanupCensus
        $snapshot = $child.Query(); $receipt.preCleanup = $snapshot
        $receipt.ambiguity = @(Find-NativeJobAmbiguity $before $receipt.preCleanupCensus $snapshot.Members $child $receipt.censusMappings)
        if ($receipt.ambiguity.Count) { $receipt.errors += "New unattributed MSVC helpers: $($receipt.ambiguity.identity -join ', '); expected no outside-job ambiguity" }
        $receipt.eligibility = Get-NativeJobCompilerEligibility $Request $snapshot $exit $child.PipesClosed $receipt.errors (Join-Path $logDir 'stdout.log') $receipt.ambiguity
        Write-NativeJobJson $receiptPath $receipt
        if (-not $snapshot.Empty) {
            if ($Request.mode -ne 'msvc-compile' -or -not $receipt.eligibility.eligible) { throw "Terminal job retained $($snapshot.Members.Count) members; compiler cleanup ineligible: $($receipt.eligibility.reasons -join '; ')" }
            foreach ($member in $snapshot.Members) {
                $fresh = $null
                try { $fresh = $child.VerifyIdentity($member.Identity) }
                catch {
                    # Every member here is an already eligible attested VCTIP, and it may finish by itself while the evidence above is written. That is natural settlement only when a fresh complete stable snapshot of the still-open job no longer lists this exact identity. A member that is still listed, or an unstable snapshot, keeps its verification failure.
                    $remaining = $child.Query()
                    if (-not $remaining.Stable -or @($remaining.Members | Where-Object { $_.Identity -eq $member.Identity }).Count) { throw }
                    $receipt.naturalExits += [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); identity = $member.Identity; pid = $member.Pid; creationFileTime = $member.CreationFileTime; path = $member.Path; tool = $member.Tool; authority = 'retained creation identity + complete stable exact job membership'; observation = 'eligible VCTIP member left the still-open job before any cleanup'; snapshot = $remaining }
                    Write-NativeJobJson $receiptPath $receipt
                    continue
                }
                $matching = @($Request.expectedVctip | Where-Object { $_.path -ieq $fresh.Path -and $_.fileVersion -eq $fresh.Tool.FileVersion -and $_.productVersion -eq $fresh.Tool.ProductVersion -and $_.sha256 -eq $fresh.Tool.Sha256 })
                if (-not $fresh.IsMember -or -not $fresh.Alive -or $matching.Count -ne 1) { throw "Invalid fresh cleanup member $($member.Identity); expected live exact-job VCTIP handle matching one attested tool" }
                $action = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); identity = $fresh.Identity; pid = $fresh.Pid; creationFileTime = $fresh.CreationFileTime; path = $fresh.Path; tool = $fresh.Tool; authority = 'retained process handle + creation identity + exact job membership'; operation = 'TerminateProcess'; reason = 'successful default compiler setup completed and both raw pipes reached EOF'; requested = $true; completed = $false }
                $receipt.cleanupActions += $action; Write-NativeJobJson $receiptPath $receipt
                $child.TerminateVerifiedMember($member.Identity, 5000)
                $action.completed = $true; $action.completedAt = [DateTime]::UtcNow.ToString('o'); Write-NativeJobJson $receiptPath $receipt
            }
        }
        $postTimer = [Diagnostics.Stopwatch]::StartNew()
        do { $snapshot = $child.Query(); if (-not $snapshot.Empty) { Start-Sleep -Milliseconds 100 } } while (-not $snapshot.Empty -and $postTimer.ElapsedMilliseconds -lt 5000)
        $receipt.postCleanup = $snapshot; Write-NativeJobJson (Join-Path $out 'job-post-cleanup.json') $snapshot
        $receipt.postCleanupCensus = Get-NativeJobCensus @($seen.Values)
        Write-NativeJobJson (Join-Path $out 'processes-post-cleanup.json') $receipt.postCleanupCensus
        $unknown = @(Find-NativeJobAmbiguity $before $receipt.postCleanupCensus $snapshot.Members $child $receipt.censusMappings)
        if (-not $snapshot.Empty -or $unknown.Count) { throw "Post-cleanup failed: exact job empty=$($snapshot.Empty), new unattributed helpers=$($unknown.Count); expected complete kernel empty and unambiguous full census" }
        if ($Request.mode -eq 'msvc-compile' -and -not $receipt.eligibility.eligible) { throw "Compiler qualification failed: $($receipt.eligibility.reasons -join '; ')" }
    } catch { $receipt.errors += $_.Exception.ToString() }
    finally {
        $receipt.observed = @($seen.Values | ForEach-Object { $_ })
        $receipt.status = if ($receipt.errors.Count) { 'failed' } elseif ($receipt.cleanupActions.Count) { 'qualified-after-explicit-compiler-cleanup' } else { 'naturally-settled' }
        if ($child) {
            Complete-NativeJobEvidence $receipt $child $before $out -CensusContext $receipt.observed
        }
        $receipt.finishedAt = [DateTime]::UtcNow.ToString('o'); Write-NativeJobJson $receiptPath $receipt
    }
    return [pscustomobject]$receipt
}

if ($AttestationPath -and $RequestPath) { throw 'Conflicting helper modes; expected one of RequestPath or AttestationPath' }
if ($AttestationPath) {
    Write-NativeJobJson ([IO.Path]::GetFullPath($AttestationPath)) (Get-NativeJobToolInventory)
} elseif ($RequestPath) {
    $request = Read-NativeJobRequest $RequestPath
    $result = Invoke-NativeWindowsJob $request
    [Console]::WriteLine((ConvertTo-Json -InputObject @{ status = $result.status; exitCode = $result.exitCode; errors = $result.errors } -Depth 10 -Compress))
    if ($result.status -eq 'failed') { exit 1 }
}
