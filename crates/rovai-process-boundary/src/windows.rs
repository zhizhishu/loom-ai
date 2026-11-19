// Thin extraction of Core managed_process/windows.rs; native-executable boundary only.
use std::{
    cmp::Ordering,
    ffi::{OsStr, OsString, c_void},
    fs::File,
    io,
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::Path,
    process::ExitStatus,
    ptr::{null, null_mut},
    time::Duration,
};

use anyhow::{Result, anyhow, bail};
use sha2::{Digest,Sha256};
use std::io::{Read,Seek,SeekFrom};
use std::os::windows::io::BorrowedHandle;
use windows_sys::Win32::{
    Foundation::{
        ERROR_ALREADY_EXISTS, FILETIME, GENERIC_READ, GetLastError, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Globalization::{CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN, CompareStringOrdinal},
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_BASIC_INFO, FILE_ID_INFO, FILE_SHARE_READ,
        FILE_STANDARD_INFO, FILE_TYPE_DISK, FileBasicInfo, FileIdInfo, FileStandardInfo,
        GetFileInformationByHandleEx, GetFileType, OPEN_EXISTING,
    },
    System::{
        JobObjects::{
            CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        Pipes::CreatePipe,
        Threading::{
            CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
            GetProcessTimes, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
            OpenProcess, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
            PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

use super::{
    ProcessStderr, ProcessStdin, ProcessStdout, ProcessSpec,
    StdinPolicy, WindowsArgvDialect,
};
use rovai_private_storage::windows_security::{PrivateObjectKind, PrivateSecurityDescriptor};

const WINDOWS_COMMAND_LINE_LIMIT: usize = 32_767;
const WINDOWS_ENVIRONMENT_BLOCK_LIMIT: usize = 32_767;
const MANAGED_PROCESS_TERMINATION_CODE: u32 = 1;
// Keep launch identities independent of the Windows logon session. The name
// is diagnostic ownership metadata, never an exit receipt.
const RUNTIME_JOB_NAME_PREFIX: &str = "Global\\Rovai.Boundary.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WindowsApplicationIdentity {
    volume_serial_number: u64,
    file_id: [u8; 16],
    end_of_file: i64,
    creation_time: i64,
    last_write_time: i64,
    change_time: i64,
    content_sha256: [u8;32],
}

pub(super) struct WindowsManagedProcess {
    process: OwnedHandle,
    job: OwnedHandle,
    job_name: String,
    pid: u32,
    stdin: Option<ProcessStdin>,
    stdout: Option<ProcessStdout>,
    stderr: Option<ProcessStderr>,
    exit_code: Option<u32>,
}

impl WindowsApplicationIdentity {
    pub(super) fn digest(&self)->String {
        let mut hash=Sha256::new();hash.update(b"rovai.native-application.v1\0windows\0");
        hash.update(self.volume_serial_number.to_le_bytes());hash.update(self.file_id);
        for value in [self.end_of_file,self.creation_time,self.last_write_time,self.change_time] {hash.update(value.to_le_bytes());}
        hash.update(self.content_sha256);format!("sha256:{:x}",hash.finalize())
    }
}

impl WindowsManagedProcess {
    pub(super) fn spawn(spec: &ProcessSpec) -> Result<Self> {
        let application = wide_nul(spec.application().as_os_str(), "application")?;
        let working_directory = wide_nul(spec.working_directory().as_os_str(), "working directory")?;
        let mut command_line = serialize_command_line(
            spec.windows_argv_dialect(), spec.application().as_os_str(), spec.arguments())?;
        let environment = serialize_environment(spec.environment())?;

        // Holding a non-delete/non-write-share handle closes the path replacement
        // window between validation and CreateProcessW. The handle is deliberately
        // non-inheritable and absent from HANDLE_LIST.
        let application_lock = open_application_for_launch(&application)?;
        if &application_identity_from_handle(raw_handle(&application_lock))?
            != spec.application_identity()
        {
            bail!(
                "process_boundary.invalid_application: application identity changed before launch"
            );
        }
        let job_name = format!("{RUNTIME_JOB_NAME_PREFIX}{}", uuid::Uuid::new_v4());
        let job = create_kill_on_close_job(&job_name)?;
        let (child_stdin, parent_stdin) = child_read_pipe()?;
        let parent_stdin = match spec.stdin_policy() {
            StdinPolicy::Null => None,
            StdinPolicy::Piped => Some(parent_stdin),
        };
        let (child_stdout, parent_stdout) = child_write_pipe()?;
        let (child_stderr, parent_stderr) = child_write_pipe()?;

        let job_handles = [raw_handle(&job)];
        let inherited_handles = [
            raw_handle(&child_stdin),
            raw_handle(&child_stdout),
            raw_handle(&child_stderr),
        ];
        let mut attributes = ProcThreadAttributeList::new(2)?;
        attributes.update(
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            job_handles.as_ptr().cast(),
            size_of::<HANDLE>(),
            "process_boundary.atomic_assignment_failed",
        )?;
        attributes.update(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited_handles.as_ptr().cast(),
            size_of_val(&inherited_handles),
            "process_boundary.handle_policy_failed",
        )?;

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = inherited_handles[0];
        startup.StartupInfo.hStdOutput = inherited_handles[1];
        startup.StartupInfo.hStdError = inherited_handles[2];
        startup.lpAttributeList = attributes.as_ptr();

        let mut process_information = PROCESS_INFORMATION::default();
        let created = unsafe {
            // SAFETY: every pointer targets storage that remains alive and stable
            // through CreateProcessW. HANDLE_LIST contains exactly the three
            // inheritable stdio handles; JOB_LIST contains the non-inheritable Job.
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_ptr().cast(),
                working_directory.as_ptr(),
                &startup.StartupInfo,
                &mut process_information,
            )
        };
        if created == 0 {
            return Err(last_os_error("process_boundary.atomic_assignment_failed"));
        }

        // Successful CreateProcessW returns two valid owned handles. Transfer
        // them infallibly: no error may discard a running, atomically assigned Job.
        let process = unsafe { OwnedHandle::from_raw_handle(process_information.hProcess) };
        let thread = unsafe { OwnedHandle::from_raw_handle(process_information.hThread) };
        drop(thread);
        drop(child_stdin);
        drop(child_stdout);
        drop(child_stderr);

        Ok(Self {
            process,
            job,
            job_name,
            pid: process_information.dwProcessId,
            stdin: parent_stdin.map(tokio_file),
            stdout: Some(tokio_file(parent_stdout)),
            stderr: Some(tokio_file(parent_stderr)),
            exit_code: None,
        })
    }

    pub(super) fn id(&self) -> u32 {
        self.pid
    }

    pub(super) fn job_name(&self) -> &str {
        &self.job_name
    }

    pub(super) fn owns_process_id(&self, pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        let raw = unsafe {
            // SAFETY: only query/synchronize access is requested, without
            // inheritance; the resulting handle is immediately owned.
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        let Ok(process) = owned_handle(raw, "process_boundary.process_query_failed") else {
            return false;
        };
        if process_has_exited(&process).unwrap_or(true) {
            return false;
        }
        let mut belongs_to_job = 0;
        let queried = unsafe {
            // SAFETY: both handles are owned and the output remains valid.
            // Use this launch's Job, never the process's ambient parent Job.
            IsProcessInJob(
                raw_handle(&process),
                raw_handle(&self.job),
                &mut belongs_to_job,
            )
        };
        queried != 0 && belongs_to_job != 0
    }

    pub(super) fn take_stdin(&mut self) -> Option<ProcessStdin> {
        self.stdin.take()
    }

    pub(super) fn take_stdout(&mut self) -> Option<ProcessStdout> {
        self.stdout.take()
    }

    pub(super) fn take_stderr(&mut self) -> Option<ProcessStderr> {
        self.stderr.take()
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(exit_code) = self.exit_code {
            return Ok(Some(ExitStatus::from_raw(exit_code)));
        }
        if !process_has_exited(&self.process)? {
            return Ok(None);
        }
        let exit_code = process_exit_code(&self.process)?;
        self.exit_code = Some(exit_code);
        Ok(Some(ExitStatus::from_raw(exit_code)))
    }

    pub(super) async fn wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(exit_code) = self.exit_code {
            return Ok(ExitStatus::from_raw(exit_code));
        }
        loop {
            match unsafe {
                // SAFETY: process is an owned, live process handle.
                WaitForSingleObject(raw_handle(&self.process), 0)
            } {
                WAIT_OBJECT_0 => {
                    let exit_code = process_exit_code(&self.process)?;
                    self.exit_code = Some(exit_code);
                    return Ok(ExitStatus::from_raw(exit_code));
                }
                WAIT_TIMEOUT => tokio::time::sleep(Duration::from_millis(10)).await,
                _ => return Err(io::Error::last_os_error()),
            }
        }
    }

    pub(super) fn tree_is_empty(&self) -> io::Result<bool> {
        // The current Job membership count is the Windows cleanup boundary.
        // Completion notifications and lifetime totals are not reliable gates.
        Ok(job_accounting(&self.job)?.ActiveProcesses == 0)
    }

    pub(super) fn terminate_job(&mut self) -> io::Result<()> {
        let terminated = unsafe {
            // SAFETY: job is owned by this process wrapper and never inherited.
            TerminateJobObject(raw_handle(&self.job), MANAGED_PROCESS_TERMINATION_CODE)
        };
        if terminated != 0 {
            Ok(())
        } else {
            let termination_error = io::Error::last_os_error();
            if self.tree_is_empty()? {
                Ok(())
            } else {
                Err(termination_error)
            }
        }
    }


}

fn create_kill_on_close_job(name: &str) -> Result<OwnedHandle> {
    let name = wide_nul(OsStr::new(name), "Job name")?;
    let policy = PrivateSecurityDescriptor::new(PrivateObjectKind::Job)?;
    let attributes = policy.attributes();
    let job = unsafe {
        // SAFETY: the protected descriptor and NUL-terminated random name remain
        // alive through creation. The Job handle is never inheritable.
        CreateJobObjectW(&attributes, name.as_ptr())
    };
    let creation_error = unsafe { GetLastError() };
    let job = owned_handle(job, "process_boundary.job_create_failed")?;
    if creation_error == ERROR_ALREADY_EXISTS {
        bail!("process_boundary.job_create_failed: Job identity already exists");
    }
    policy.verify_job_handle(raw_handle(&job))?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        // SAFETY: limits has the exact structure and size required by the
        // JobObjectExtendedLimitInformation information class.
        SetInformationJobObject(
            raw_handle(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(last_os_error("process_boundary.job_create_failed"));
    }
    Ok(job)
}

pub(super) fn process_start_identity(pid: u32) -> Option<u64> {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    let process = owned_handle(raw, "process_boundary.process_query_failed").ok()?;
    process_creation_time(&process).ok()
}

fn process_creation_time(process: &OwnedHandle) -> io::Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe {
        // SAFETY: process is owned with query access and every FILETIME output
        // remains valid through the native call.
        GetProcessTimes(
            raw_handle(process),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn job_accounting(job: &OwnedHandle) -> io::Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    let queried = unsafe {
        // SAFETY: job is an owned Job handle with query access and accounting is
        // the exact structure and size required by this information class.
        QueryInformationJobObject(
            raw_handle(job),
            JobObjectBasicAccountingInformation,
            (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            null_mut(),
        )
    };
    if queried == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(accounting)
}

fn open_application_for_launch(application: &[u16]) -> Result<OwnedHandle> {
    let handle = unsafe {
        // SAFETY: application is a NUL-terminated absolute path. Null security
        // attributes make the validation handle non-inheritable.
        CreateFileW(
            application.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    let handle = owned_handle(handle, "process_boundary.invalid_application")?;
    let file_type = unsafe {
        // SAFETY: handle is a valid owned file handle.
        GetFileType(raw_handle(&handle))
    };
    if file_type != FILE_TYPE_DISK {
        bail!("process_boundary.invalid_application: application is not a disk file");
    }
    Ok(handle)
}

pub(super) fn capture_application_identity(path: &Path) -> Result<WindowsApplicationIdentity> {
    if !path.is_absolute() || !path.extension().is_some_and(|ext|ext.eq_ignore_ascii_case("exe")) {
        bail!("process_boundary.invalid_application");
    }
    let handle=open_application_for_launch(&wide_nul(path.as_os_str(),"application")?)?;
    application_identity_from_handle(raw_handle(&handle))
}

fn application_identity_from_handle(handle: HANDLE) -> Result<WindowsApplicationIdentity> {
    let mut file_id = FILE_ID_INFO::default();
    read_file_information(handle, FileIdInfo, &mut file_id)?;
    let mut standard = FILE_STANDARD_INFO::default();
    read_file_information(handle, FileStandardInfo, &mut standard)?;
    if standard.Directory || standard.EndOfFile < 0 {
        bail!("process_boundary.invalid_application: application is not a regular file");
    }
    let mut basic = FILE_BASIC_INFO::default();
    read_file_information(handle, FileBasicInfo, &mut basic)?;
    if standard.EndOfFile>1024*1024*1024 {bail!("process_boundary.invalid_application: executable too large");}
    // Duplicate this exact, non-write/non-delete-share admission handle. The
    // path is never reopened to compute the installation identity.
    let duplicate=unsafe{BorrowedHandle::borrow_raw(handle)}.try_clone_to_owned()?;
    let mut file=File::from(duplicate);file.seek(SeekFrom::Start(0))?;
    let mut hash=Sha256::new();let mut buffer=[0_u8;65536];
    loop {let n=file.read(&mut buffer)?;if n==0{break;}hash.update(&buffer[..n]);}
    let content_sha256:[u8;32]=hash.finalize().into();
    let mut after=FILE_BASIC_INFO::default();read_file_information(handle,FileBasicInfo,&mut after)?;
    if after.CreationTime!=basic.CreationTime || after.LastWriteTime!=basic.LastWriteTime || after.ChangeTime!=basic.ChangeTime {
        bail!("process_boundary.application_changed");
    }
    Ok(WindowsApplicationIdentity {
        volume_serial_number: file_id.VolumeSerialNumber,
        file_id: file_id.FileId.Identifier,
        end_of_file: standard.EndOfFile,
        creation_time: basic.CreationTime,
        last_write_time: basic.LastWriteTime,
        change_time: basic.ChangeTime,
        content_sha256,
    })
}

fn read_file_information<T>(handle: HANDLE, class: i32, output: &mut T) -> Result<()> {
    let read = unsafe {
        // SAFETY: output points to the exact structure selected by each caller's
        // FILE_INFO_BY_HANDLE_CLASS and remains writable for the declared size.
        GetFileInformationByHandleEx(
            handle,
            class,
            (output as *mut T).cast(),
            size_of::<T>() as u32,
        )
    };
    if read == 0 {
        Err(last_os_error("process_boundary.invalid_application"))
    } else {
        Ok(())
    }
}

fn child_read_pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    create_inheritable_pipe(true)
}

fn child_write_pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    create_inheritable_pipe(false)
}

fn create_inheritable_pipe(child_reads: bool) -> Result<(OwnedHandle, OwnedHandle)> {
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read_handle = null_mut();
    let mut write_handle = null_mut();
    let created = unsafe {
        // SAFETY: output pointers and SECURITY_ATTRIBUTES are valid for the call.
        CreatePipe(&mut read_handle, &mut write_handle, &security, 0)
    };
    if created == 0 {
        return Err(last_os_error("process_boundary.handle_policy_failed"));
    }
    let read_handle = owned_handle(read_handle, "process_boundary.handle_policy_failed")?;
    let write_handle = owned_handle(write_handle, "process_boundary.handle_policy_failed")?;
    let (child, parent) = if child_reads {
        (read_handle, write_handle)
    } else {
        (write_handle, read_handle)
    };
    let protected = unsafe {
        // SAFETY: parent is a valid handle. Clearing inheritance before process
        // creation prevents it from entering even the explicit HANDLE_LIST.
        SetHandleInformation(raw_handle(&parent), HANDLE_FLAG_INHERIT, 0)
    };
    if protected == 0 {
        return Err(last_os_error("process_boundary.handle_policy_failed"));
    }
    Ok((child, parent))
}

struct ProcThreadAttributeList {
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
    _storage: Vec<usize>,
}

impl ProcThreadAttributeList {
    fn new(attribute_count: u32) -> Result<Self> {
        let mut bytes = 0usize;
        unsafe {
            // SAFETY: the documented sizing call uses a null list and returns
            // the required byte count through bytes.
            InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(last_os_error("process_boundary.atomic_assignment_failed"));
        }
        let words = bytes.div_ceil(size_of::<usize>());
        let mut storage = vec![0usize; words];
        let pointer = storage.as_mut_ptr().cast();
        let initialized = unsafe {
            // SAFETY: storage is aligned and has at least the sized-call capacity.
            InitializeProcThreadAttributeList(pointer, attribute_count, 0, &mut bytes)
        };
        if initialized == 0 {
            return Err(last_os_error("process_boundary.atomic_assignment_failed"));
        }
        Ok(Self {
            pointer,
            _storage: storage,
        })
    }

    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.pointer
    }

    fn update(
        &mut self,
        attribute: usize,
        value: *const c_void,
        value_bytes: usize,
        stable_error: &str,
    ) -> Result<()> {
        let updated = unsafe {
            // SAFETY: value storage remains alive until after CreateProcessW and
            // the attribute list remains initialized for this update.
            UpdateProcThreadAttribute(
                self.pointer,
                0,
                attribute,
                value,
                value_bytes,
                null_mut(),
                null(),
            )
        };
        if updated == 0 {
            return Err(last_os_error(stable_error));
        }
        Ok(())
    }
}

impl Drop for ProcThreadAttributeList {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: pointer was successfully initialized and storage is still alive.
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}

fn serialize_command_line(
    dialect: WindowsArgvDialect,
    application: &OsStr,
    arguments: &[OsString],
) -> Result<Vec<u16>> {
    match dialect {
        WindowsArgvDialect::MicrosoftCrt => {
            let mut command_line = Vec::new();
            append_microsoft_crt_argument(
                &mut command_line,
                &application.encode_wide().collect::<Vec<_>>(),
            );
            for argument in arguments {
                command_line.push(b' ' as u16);
                append_microsoft_crt_argument(
                    &mut command_line,
                    &argument.encode_wide().collect::<Vec<_>>(),
                );
            }
            if command_line.len() + 1 > WINDOWS_COMMAND_LINE_LIMIT {
                bail!("process_boundary.invalid_argument: Windows command line is too long");
            }
            command_line.push(0);
            Ok(command_line)
        }
    }
}

/// Quotes one argument for the Microsoft CRT backslash/quote decoder. Quoting
/// every argument avoids a second branch for whitespace and preserves empty
/// arguments without changing the decoder semantics.
fn append_microsoft_crt_argument(output: &mut Vec<u16>, argument: &[u16]) {
    output.push(b'"' as u16);
    let mut backslashes = 0usize;
    for &unit in argument {
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
            output.push(unit);
        } else {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
            output.push(unit);
        }
        backslashes = 0;
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    output.push(b'"' as u16);
}

fn serialize_environment(
    environment: &std::collections::BTreeMap<OsString, OsString>,
) -> Result<Vec<u16>> {
    let mut entries = environment
        .iter()
        .map(|(key, value)| {
            let key = key.encode_wide().collect::<Vec<_>>();
            let value = value.encode_wide().collect::<Vec<_>>();
            if key.is_empty()
                || key.contains(&0)
                || !valid_environment_key(&key)
                || value.contains(&0)
            {
                bail!("process_boundary.invalid_argument: invalid Windows environment entry");
            }
            Ok((key, value))
        })
        .collect::<Result<Vec<_>>>()?;
    entries.sort_by(|left, right| compare_windows_names(&left.0, &right.0));
    if entries
        .windows(2)
        .any(|pair| compare_windows_names(&pair[0].0, &pair[1].0) == Ordering::Equal)
    {
        bail!("process_boundary.invalid_argument: duplicate Windows environment key");
    }

    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend(key);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    if block.len() > WINDOWS_ENVIRONMENT_BLOCK_LIMIT {
        bail!("process_boundary.invalid_argument: Windows environment block is too large");
    }
    Ok(block)
}

fn valid_environment_key(key: &[u16]) -> bool {
    if !key.contains(&(b'=' as u16)) {
        return true;
    }
    key.len() == 3
        && key[0] == b'=' as u16
        && ((key[1] >= b'A' as u16 && key[1] <= b'Z' as u16)
            || (key[1] >= b'a' as u16 && key[1] <= b'z' as u16))
        && key[2] == b':' as u16
}

fn compare_windows_names(left: &[u16], right: &[u16]) -> Ordering {
    let result = unsafe {
        // SAFETY: both pointers and explicit lengths describe live UTF-16 slices.
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        )
    };
    match result {
        CSTR_LESS_THAN => Ordering::Less,
        CSTR_EQUAL => Ordering::Equal,
        CSTR_GREATER_THAN => Ordering::Greater,
        _ => left.cmp(right),
    }
}


fn wide_nul(value: &OsStr, label: &str) -> Result<Vec<u16>> {
    let mut value = value.encode_wide().collect::<Vec<_>>();
    if value.contains(&0) {
        bail!("process_boundary.invalid_argument: {label} contains NUL");
    }
    value.push(0);
    Ok(value)
}

fn process_exit_code(process: &OwnedHandle) -> io::Result<u32> {
    let mut exit_code = 0u32;
    let read = unsafe {
        // SAFETY: process is an owned process handle and exit_code is writable.
        GetExitCodeProcess(raw_handle(process), &mut exit_code)
    };
    if read == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(exit_code)
    }
}

fn process_has_exited(process: &OwnedHandle) -> io::Result<bool> {
    match unsafe {
        // SAFETY: process is an owned process handle.
        WaitForSingleObject(raw_handle(process), 0)
    } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(test)]
#[derive(Debug)]
pub(super) struct TestProcess {
    handle: OwnedHandle,
}

#[cfg(test)]
impl TestProcess {
    pub(super) fn open(pid: u32) -> io::Result<Self> {
        let raw = unsafe {
            // SAFETY: the helper owns this PID before termination. Keeping this
            // non-inheritable handle pins that exact process, including its PID.
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        let handle = owned_handle(raw, "process_boundary.process_query_failed")
            .map_err(|error| io::Error::other(error.to_string()))?;
        Ok(Self { handle })
    }

    pub(super) fn is_running(&self) -> io::Result<bool> {
        process_has_exited(&self.handle).map(|exited| !exited)
    }
}


fn tokio_file(handle: OwnedHandle) -> tokio::fs::File {
    let file: File = handle.into();
    tokio::fs::File::from_std(file)
}

fn owned_handle(handle: HANDLE, stable_error: &str) -> Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(last_os_error(stable_error));
    }
    Ok(unsafe {
        // SAFETY: the successful Win32 call transferred one unique owned handle.
        OwnedHandle::from_raw_handle(handle)
    })
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle()
}

fn last_os_error(stable_error: &str) -> anyhow::Error {
    anyhow!("{stable_error}: {}", io::Error::last_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quoted(value: &str) -> String {
        let mut output = Vec::new();
        append_microsoft_crt_argument(&mut output, &value.encode_utf16().collect::<Vec<_>>());
        String::from_utf16(&output).unwrap()
    }

    #[test]
    fn microsoft_crt_serializer_covers_closed_argument_edges() {
        assert_eq!(quoted(""), "\"\"");
        assert_eq!(quoted("two words"), "\"two words\"");
        assert_eq!(quoted("say\"hello"), "\"say\\\"hello\"");
        assert_eq!(quoted("tail\\"), "\"tail\\\\\"");
        assert_eq!(quoted("中文🙂"), "\"中文🙂\"");
    }

    #[test]
    fn command_line_limit_fails_before_create_process() {
        let application = OsString::from("C:\\Rovai\\rovai.exe");
        let argument = OsString::from("x".repeat(WINDOWS_COMMAND_LINE_LIMIT));
        let error = serialize_command_line(
            WindowsArgvDialect::MicrosoftCrt,
            &application,
            &[argument],
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("process_boundary.invalid_argument")
        );
    }

    #[test]
    fn environment_serializer_accepts_only_windows_drive_current_directory_keys() {
        let environment = std::collections::BTreeMap::from([
            (OsString::from("=C:"), OsString::from("C:\\Rovai")),
            (OsString::from("Path"), OsString::from("C:\\Windows")),
        ]);
        let block = serialize_environment(&environment).unwrap();
        assert_eq!(
            String::from_utf16(&block[..block.len() - 1]).unwrap(),
            "=C:=C:\\Rovai\0Path=C:\\Windows\0"
        );

        let invalid = std::collections::BTreeMap::from([(
            OsString::from("ROVAI=INJECTED"),
            OsString::from("value"),
        )]);
        assert!(serialize_environment(&invalid).is_err());
    }
}

pub(super) fn validate_launch_input(application: &Path, args: &[OsString], env: &std::collections::BTreeMap<OsString, OsString>) -> Result<()> {
    wide_nul(application.as_os_str(), "application")?;
    serialize_command_line(WindowsArgvDialect::MicrosoftCrt, application.as_os_str(), args)?;
    serialize_environment(env)?;
    Ok(())
}
