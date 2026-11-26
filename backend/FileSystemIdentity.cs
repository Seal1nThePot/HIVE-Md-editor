using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Hive;

static class FileSystemIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    struct NativeInfo
    {
        public uint Attributes, CreateLow, CreateHigh, AccessLow, AccessHigh, WriteLow, WriteHigh,
            Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle OpenHandle(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out NativeInfo info);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint FinalPath(SafeFileHandle handle, StringBuilder value, uint capacity, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateDirectory(string path, IntPtr security);
    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateHardLink(string destination, string source, IntPtr security);
    [DllImport("libc", EntryPoint = "link", SetLastError = true)]
    static extern int PosixLink(string source, string destination);
    [DllImport("libc", EntryPoint = "realpath", SetLastError = true)]
    static extern IntPtr PosixRealPath(string path, IntPtr output);
    [DllImport("libc", EntryPoint = "free")]
    static extern void Free(IntPtr ptr);
    [DllImport("libc", EntryPoint = "mkdir", SetLastError = true)]
    static extern int PosixCreateDirectory(string path, uint mode);

    static SafeFileHandle Open(string path)
    {
        const uint shareReadWriteDelete = 7, openExisting = 3, backupSemantics = 0x02000000;
        var handle = OpenHandle(path, 0, shareReadWriteDelete, IntPtr.Zero, openExisting, backupSemantics, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        var error = Marshal.GetLastPInvokeError();
        handle.Dispose();
        throw Error(error, path);
    }

    static Exception Error(int error, string path) => error switch
    {
        2 => new FileNotFoundException(null, path),
        3 when OperatingSystem.IsWindows() => new DirectoryNotFoundException(path),
        5 when OperatingSystem.IsWindows() => new UnauthorizedAccessException(path),
        80 or 183 when OperatingSystem.IsWindows() => new ApiException("同名文件已存在，已阻止覆盖。", 409),
        17 when !OperatingSystem.IsWindows() => new ApiException("同名文件已存在，已阻止覆盖。", 409),
        _ => new IOException(new Win32Exception(error).Message, new Win32Exception(error))
    };

    public static void NewDirectory(string path)
    {
        var success = OperatingSystem.IsWindows() ? CreateDirectory(path, IntPtr.Zero) : PosixCreateDirectory(path, 0x1ff) == 0;
        if (!success) throw Error(Marshal.GetLastPInvokeError(), path);
    }

    public static void Link(string source, string destination)
    {
        var success = OperatingSystem.IsWindows() ? CreateHardLink(destination, source, IntPtr.Zero) : PosixLink(source, destination) == 0;
        if (!success) throw Error(Marshal.GetLastPInvokeError(), destination);
    }

    public static string Canonical(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            var ptr = PosixRealPath(path, IntPtr.Zero);
            if (ptr == IntPtr.Zero) throw Error(Marshal.GetLastPInvokeError(), path);
            try { return Marshal.PtrToStringUTF8(ptr)!; }
            finally { Free(ptr); }
        }
        using var handle = Open(path);
        var buffer = new StringBuilder(512);
        var length = FinalPath(handle, buffer, (uint)buffer.Capacity, 0);
        if (length >= buffer.Capacity)
        {
            buffer.EnsureCapacity(checked((int)length + 1));
            length = FinalPath(handle, buffer, (uint)buffer.Capacity, 0);
        }
        if (length == 0 || length >= buffer.Capacity) throw Error(Marshal.GetLastPInvokeError(), path);
        var resolved = buffer.ToString();
        return resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) ? @"\\" + resolved[8..] :
            resolved.StartsWith(@"\\?\", StringComparison.Ordinal) ? resolved[4..] : resolved;
    }

    public static (uint Device, ulong Index, double Birth) Stat(string path)
    {
        if (!OperatingSystem.IsWindows())
            return (0, 0, (File.GetCreationTimeUtc(path).ToFileTimeUtc() - 116444736000000000L) / 10000.0);
        using var handle = Open(path);
        if (!GetFileInformationByHandle(handle, out var info)) throw Error(Marshal.GetLastPInvokeError(), path);
        var created = (((long)info.CreateHigh << 32) | info.CreateLow) - 116444736000000000L;
        return (info.Volume, ((ulong)info.IndexHigh << 32) | info.IndexLow, UnixMilliseconds(created));
    }

    public static double UnixMilliseconds(long ticksSinceEpoch) =>
        ticksSinceEpoch / TimeSpan.TicksPerSecond * 1000.0 + ticksSinceEpoch % TimeSpan.TicksPerSecond / 10000.0;
}
