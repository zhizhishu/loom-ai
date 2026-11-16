fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // MSVC defaults to a 1 MiB main stack. Fresh authority initialization in
    // debug builds exceeds that budget; reserve (not eagerly commit) 8 MiB.
    // Keep the same native-entry budget in rovai-core/build.rs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bins=/STACK:8388608");
    }
}
