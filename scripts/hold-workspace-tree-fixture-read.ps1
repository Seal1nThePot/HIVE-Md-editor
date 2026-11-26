param([Parameter(Mandatory = $true)][string]$DocumentPath)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class WorkspaceTreeReadGate
{
    const uint GenericRead = 0x80000000, ShareReadWriteDelete = 7, OpenExisting = 3;
    const uint OverlappedFlag = 0x40000000, RequestLevelOneOplock = 0x00090000;
    const int IoPending = 997;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle file, uint controlCode, IntPtr input, uint inputSize,
        IntPtr output, uint outputSize, IntPtr bytesReturned, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CancelIoEx(SafeFileHandle file, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetOverlappedResult(SafeFileHandle file, IntPtr overlapped, out uint bytes, bool wait);

    public static void Hold(string path)
    {
        using (var file = CreateFile(path, GenericRead, ShareReadWriteDelete, IntPtr.Zero, OpenExisting, OverlappedFlag, IntPtr.Zero))
        using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset))
        {
            if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            var state = new NativeOverlapped { EventHandle = ready.SafeWaitHandle.DangerousGetHandle() };
            var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeOverlapped)));
            var pending = false;
            try
            {
                Marshal.StructureToPtr(state, pointer, false);
                bool completed = DeviceIoControl(file, RequestLevelOneOplock, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, pointer);
                int error = Marshal.GetLastWin32Error();
                if (completed || error != IoPending) throw new Win32Exception(error, "The isolated file must grant a level-one oplock.");
                pending = true;
                Console.WriteLine("OPLOCK_READY");
                if (!ready.WaitOne(TimeSpan.FromSeconds(15))) throw new TimeoutException("The backend did not open the held document.");
                pending = false;
                Console.WriteLine("OPLOCK_BREAK");
                Console.ReadLine();
                // Closing the owning handle acknowledges the break and resumes the backend read.
            }
            finally
            {
                if (pending)
                {
                    CancelIoEx(file, pointer);
                    uint bytes;
                    GetOverlappedResult(file, pointer, out bytes, true);
                }
                Marshal.FreeHGlobal(pointer);
            }
        }
    }
}
'@
[WorkspaceTreeReadGate]::Hold($DocumentPath)
