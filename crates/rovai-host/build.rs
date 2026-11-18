fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // Fresh authority initialization needs an 8 MiB native main stack on
    // Windows. Reserve address space without eagerly committing it, and keep
    // the same budget in rovai-core/build.rs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        match std::env::var("CARGO_CFG_TARGET_ENV").as_deref() {
            Ok("msvc") => println!("cargo:rustc-link-arg-bins=/STACK:8388608"),
            Ok("gnu") => println!("cargo:rustc-link-arg-bins=-Wl,--stack,8388608"),
            _ => {}
        }
    }
}
