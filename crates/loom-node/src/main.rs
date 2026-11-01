fn main() -> std::process::ExitCode {
    match loom_node::run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("loom-node: {error:#}");
            std::process::ExitCode::FAILURE
        }
    }
}
