use std::io::Write;

fn main() -> std::process::ExitCode {
    match rovai_host::run_server() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(std::io::stderr().lock(), "Rovai Server failed: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
