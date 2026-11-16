fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // Core and its CLI can both initialize the authority. Match the Host's
    // bounded MSVC main-stack reservation without changing global RUSTFLAGS
    // or the platform defaults for GNU, Linux and macOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bins=/STACK:8388608");
    }
}
