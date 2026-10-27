//! The argument parser never echoes a token from argv, so a key or seed typed in the wrong place stays out of the output

use std::ffi::OsStr;
use std::fmt::Debug;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use zdecrypt::{keygen, Net};

/// Bytes 00 01 02 .. 1f
const SEED: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const UNKNOWN_COMMAND: &str = "unknown command (expected one of: keygen, derive-uivk, decrypt, owns, serve, build-test)";
const KEY_FROM_ENV_ONLY: &str = "the key is read from ZDECRYPT_KEY only";

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Ran {
    fn json(&self) -> Value {
        serde_json::from_str(&self.stdout).unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {}", self.stdout))
    }

    fn error(&self) -> String {
        match self.json()["error"].as_str() {
            Some(e) => e.to_owned(),
            None => panic!("no error in {}", self.stdout),
        }
    }
}

/// Runs the real binary with a clean environment, so ZDECRYPT_* variables of the caller cannot leak in
fn run<S: AsRef<OsStr>>(args: &[S], env: &[(&str, &str)], stdin: &str) -> Ran {
    let mut child = Command::new(env!("CARGO_BIN_EXE_zdecrypt"))
        .args(args)
        .env_remove("ZDECRYPT_KEY")
        .env_remove("ZDECRYPT_NETWORK")
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // A child that refuses its arguments exits without reading stdin
    let _ = child.stdin.take().unwrap().write_all(stdin.as_bytes());
    let out = child.wait_with_output().unwrap();
    Ran {
        code: out.status.code().expect("zdecrypt was killed by a signal"),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

/// Exit 2 with exactly this error object, and nothing that was typed comes back on either stream
fn assert_refused<S: AsRef<OsStr> + Debug>(args: &[S], env: &[(&str, &str)], want: &str) {
    let ran = run(args, env, "");
    let shown = format!("{args:?} gave {} {}", ran.stdout, ran.stderr);
    assert_eq!(ran.code, 2, "{shown}");
    for typed in ["SECRET", SEED] {
        assert!(!ran.stdout.contains(typed) && !ran.stderr.contains(typed), "{typed} was echoed: {shown}");
    }
    assert_eq!(ran.json(), json!({ "error": want }), "{shown}");
    assert_eq!(ran.stderr, format!("error: {want}\n"), "{shown}");
}

/// The UIVK and an Orchard-only address of a throwaway regtest account
fn account() -> (String, String) {
    let k = keygen(&std::array::from_fn(|i| i as u8), Net::Regtest).unwrap();
    (k["uivk"].as_str().unwrap().to_owned(), k["orchardOnlyAddress"].as_str().unwrap().to_owned())
}

/// A file with these contents, in a directory of its own under the target dir
fn scratch_file(dir: &str, name: &str, contents: &str) -> String {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("argv").join(dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    std::fs::write(&file, contents).unwrap();
    file.to_str().unwrap().to_owned()
}

#[test]
fn a_value_flag_may_be_written_with_an_equals_sign() {
    // A joined flag must not swallow the flag after it, or the seed would come back as an unexpected argument
    let joined = run(&["keygen", "--network=regtest", "--seed-hex", SEED], &[], "");
    assert_eq!(joined.code, 0, "{} {}", joined.stdout, joined.stderr);
    let k = joined.json();
    assert_eq!((k["network"].as_str(), k["seedHex"].as_str()), (Some("regtest"), Some(SEED)));
    assert!(k["uivk"].as_str().unwrap().starts_with("uivkregtest1"), "{k}");

    let spaced = run(&["keygen", "--network", "regtest", "--seed-hex", SEED], &[], "");
    assert_eq!(joined.stdout, spaced.stdout);
    let both = format!("--seed-hex={SEED}");
    assert_eq!(run(&["keygen", "--network=regtest", both.as_str()], &[], "").stdout, spaced.stdout);
}

#[test]
fn every_value_flag_accepts_the_equals_form() {
    let (uivk, ua) = account();
    let env = [("ZDECRYPT_KEY", uivk.as_str())];

    let spaced = run(&["owns", "--network", "regtest", "--address", ua.as_str()], &env, "");
    assert_eq!(spaced.code, 0, "{} {}", spaced.stdout, spaced.stderr);
    let address = format!("--address={ua}");
    assert_eq!(run(&["owns", "--network=regtest", address.as_str()], &env, "").stdout, spaced.stdout);

    // The made-up one byte tx only fails to parse after every flag below was read, mined or mempool alike
    let pay_to = format!("--pay-to={ua}");
    for at in ["--tip=9", "--height=10"] {
        let args = ["decrypt", "--network=regtest", at, pay_to.as_str(), "--expect-memo=m", "--min-zat=1", "--tx-hex=00", "--pretty"];
        let ran = run(&args, &env, "");
        assert_eq!(ran.code, 2, "{} {}", ran.stdout, ran.stderr);
        assert!(ran.error().starts_with("transaction does not parse"), "{}", ran.stdout);
    }
}

#[test]
fn a_value_may_itself_contain_an_equals_sign() {
    // Splitting at the last = would turn this path into an unknown flag
    let (uivk, _) = account();
    let file = scratch_file("equals", "tx=1.hex", "00");
    let ran = run(&["decrypt", "--network=regtest", "--tip=9", format!("--tx-file={file}").as_str()], &[("ZDECRYPT_KEY", uivk.as_str())], "");
    assert_eq!(ran.code, 2, "{} {}", ran.stdout, ran.stderr);
    assert!(ran.error().starts_with("transaction does not parse"), "{}", ran.stdout);
}

#[test]
fn the_argv_of_the_facilitator_and_the_demo_script_still_parses() {
    let (uivk, ua) = account();
    let env = [("ZDECRYPT_KEY", uivk.as_str())];
    let file = scratch_file("callers", "tx.hex", "00");
    // The wrapper in packages/facilitator/src/chain/zdecrypt.ts hands the tx over on stdin, scripts/demo.sh in a file
    let decrypts: [&[&str]; 3] = [
        &["decrypt", "--tip", "9", "--pay-to", ua.as_str(), "--network", "regtest"],
        &["decrypt", "--height", "10", "--pay-to", ua.as_str(), "--network", "regtest"],
        &["decrypt", "--network", "regtest", "--tip", "9", "--pay-to", ua.as_str(), "--tx-file", file.as_str(), "--pretty"],
    ];
    for args in decrypts {
        let ran = run(args, &env, "00");
        assert_eq!(ran.code, 2, "{args:?} gave {} {}", ran.stdout, ran.stderr);
        assert!(ran.error().starts_with("transaction does not parse"), "{args:?} gave {}", ran.stdout);
    }
    let owns = run(&["owns", "--address", ua.as_str(), "--network", "regtest"], &env, "");
    assert_eq!(owns.code, 0, "{} {}", owns.stdout, owns.stderr);
    assert_eq!((owns.json()["ownedByKey"].as_bool(), owns.json()["hasTransparent"].as_bool()), (Some(true), Some(false)));
}

#[test]
fn an_unexpected_argument_is_reported_by_its_position_only() {
    // Position 1 is the command
    let cases: [(&[&str], &str); 8] = [
        (&["keygen", "--bogus", "SECRET"], "unexpected argument at position 2"),
        (&["keygen", "--bogus=SECRET"], "unexpected argument at position 2"),
        (&["keygen", "SECRET"], "unexpected argument at position 2"),
        (&["keygen", "--seed-hex", SEED, "SECRET"], "unexpected argument at position 4"),
        (&["keygen", "--network=regtest", "--seed-hex", SEED, "--bogus", "SECRET"], "unexpected argument at position 5"),
        // A misspelled flag must not be skipped, or keygen would make a random seed instead of the one given
        (&["keygen", "--seed_hex", SEED], "unexpected argument at position 2"),
        (&["keygen", "--pretty=SECRET"], "unexpected argument at position 2"),
        (&["keygen", "--SECRET"], "unexpected argument at position 2"),
    ];
    for (args, want) in cases {
        assert_refused(args, &[], want);
    }
}

#[test]
fn a_flag_without_a_value_is_named_from_the_known_list_only() {
    assert_refused(&["keygen", "--seed-hex"], &[], "--seed-hex needs a value");
    assert_refused(&["keygen", "--network="], &[], "--network must be regtest, testnet or mainnet");
}

#[test]
fn the_key_flag_is_refused_whatever_follows_it() {
    let (uivk, _) = account();
    let cases: [&[&str]; 6] = [
        &["derive-uivk", "--key", "SECRET"],
        &["derive-uivk", "--key=SECRET"],
        &["decrypt", "--tip", "9", "--key", "SECRET"],
        &["owns", "--address", "SECRET", "--key", "SECRET"],
        &["serve", "--key=SECRET"],
        &["keygen", "--key"],
    ];
    for args in cases {
        assert_refused(args, &[], KEY_FROM_ENV_ONLY);
        // A key in the environment does not make the flag acceptable
        assert_refused(args, &[("ZDECRYPT_KEY", uivk.as_str())], KEY_FROM_ENV_ONLY);
    }
}

#[test]
fn a_missing_key_points_at_the_environment_only() {
    let ran = run(&["derive-uivk"], &[], "");
    assert_eq!(ran.code, 2, "{}", ran.stdout);
    assert_eq!(ran.error(), "set ZDECRYPT_KEY to a testnet UIVK or UFVK");
}

#[test]
fn an_unknown_command_is_refused_without_echo() {
    for command in ["fooSECRET", "keygenSECRET", "--key=SECRET", "--help", ""] {
        // What follows the command is never reached
        assert_refused(&[command, "--bogus", "SECRET"], &[], UNKNOWN_COMMAND);
    }
}

#[cfg(not(feature = "testbuild"))]
#[test]
fn build_test_is_an_unknown_command_without_the_testbuild_feature() {
    assert_refused(&["build-test", "--merchant-address", "SECRET"], &[], UNKNOWN_COMMAND);
}

#[test]
fn no_command_prints_the_usage() {
    let ran = run::<&str>(&[], &[], "");
    assert_eq!(ran.code, 2, "{} {}", ran.stdout, ran.stderr);
    let usage = ran.error();
    assert!(usage.starts_with("usage: zdecrypt <keygen|derive-uivk|decrypt|owns|serve|build-test>"), "{usage}");
    assert!(usage.contains("ZDECRYPT_KEY"), "{usage}");
}

#[test]
fn an_unreadable_tx_file_is_refused_without_echoing_its_path() {
    let (uivk, _) = account();
    let env = [("ZDECRYPT_KEY", uivk.as_str())];
    let files: [&[&str]; 2] = [&["--tx-file", "/nonexistent/SECRET"], &["--tx-file=/nonexistent/SECRET"]];
    for file in files {
        let mut args = vec!["decrypt", "--network", "regtest", "--tip", "9"];
        args.extend_from_slice(file);
        let ran = run(&args, &env, "");
        assert_eq!(ran.code, 2, "{} {}", ran.stdout, ran.stderr);
        assert!(!ran.stdout.contains("SECRET") && !ran.stderr.contains("SECRET"), "path echoed: {} {}", ran.stdout, ran.stderr);
        assert!(ran.error().starts_with("cannot read"), "{}", ran.stdout);
    }
}

#[test]
fn a_tx_that_is_not_hex_is_refused_without_quoting_a_character_of_it() {
    let (uivk, _) = account();
    let env = [("ZDECRYPT_KEY", uivk.as_str())];
    // The lengths are even, so the hex decoder would quote the first bad character
    let joined = run(&["decrypt", "--network=regtest", "--tip=9", "--tx-hex=zz01"], &env, "");
    assert_eq!(joined.code, 2, "{} {}", joined.stdout, joined.stderr);
    assert_eq!(joined.error(), "tx is not hex: invalid character at position 0");
    let piped = run(&["decrypt", "--network=regtest", "--tip=9"], &env, "0g");
    assert_eq!(piped.code, 2, "{} {}", piped.stdout, piped.stderr);
    assert_eq!(piped.error(), "tx is not hex: invalid character at position 1");
}

#[cfg(unix)]
#[test]
fn an_argument_that_is_not_unicode_is_refused_by_position() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let bad = || OsString::from_vec(b"\xffSECRET".to_vec());
    // args() would panic on these, and the panic message carries the argument
    let cases: [(Vec<OsString>, &str); 3] = [
        (vec![bad()], "unexpected argument at position 1"),
        (vec!["keygen".into(), bad()], "unexpected argument at position 2"),
        (vec!["keygen".into(), "--seed-hex".into(), bad()], "unexpected argument at position 3"),
    ];
    for (args, want) in cases {
        assert_refused(&args, &[], want);
    }
}
