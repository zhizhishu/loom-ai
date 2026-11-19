fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // Core and its CLI can both initialize the authority. Match the Host's
    // 8 MiB Windows main-stack reservation without changing global RUSTFLAGS
    // or the platform defaults for Linux and macOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        match std::env::var("CARGO_CFG_TARGET_ENV").as_deref() {
            Ok("msvc") => println!("cargo:rustc-link-arg-bins=/STACK:8388608"),
            Ok("gnu") => println!("cargo:rustc-link-arg-bins=-Wl,--stack,8388608"),
            _ => {}
        }
    }
}
