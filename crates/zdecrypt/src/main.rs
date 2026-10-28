//! zdecrypt CLI.
//!
//! keygen [--seed-hex HEX]                      fresh account, prints seedHex, UFVK, UIVK and a shielded-only UA
//! derive-uivk                                  UFVK to UIVK
//! decrypt (--height H | --tip T) [--pay-to UA] [--expect-memo M --min-zat Z]
//!         [--tx-hex HEX | --tx-file PATH | hex on stdin]
//! owns --address UA                            which receivers of UA belong to the key
//! build-test ...                               testbuild feature only, see testbuild.rs
//!
//! Every subcommand takes --network regtest|testnet|mainnet, else env ZDECRYPT_NETWORK, else
//! testnet. The key and every address must belong to that network. The key comes from env
//! ZDECRYPT_KEY only, never from argv, which is visible in ps. A value flag is written as
//! `--name value` or `--name=value`. --height is the mined height. --tip is the chain tip for a
//! mempool tx, which is judged at tip + 1. With --expect-memo and --min-zat the report carries an
//! exact-memo verdict in the style of Hanko's zpay-verify, for operators. It is not the z402
//! crediting rule (protocol.md §5.2), which the facilitator applies. Output is one JSON object on
//! stdout. Exit 0 on success, 2 on any error with an error object on stdout.
//!
//! An argument error is fixed text. It names a flag from the known list or the position of the
//! argument, and never repeats what was typed, because a key or a seed may have landed in the wrong
//! place.
//!
//! keygen prints the seed as seedHex on stdout. With --network mainnet that seed controls real
//! money, so redirect the output to a file that only you can read, mode 0600, which is what the
//! shell creates for `> file` under umask 077.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;

use serde_json::{json, Value};
use zcash_protocol::consensus::BlockHeight;
use zdecrypt::{decode_key, decode_ua, encode_uivk, inspect_expect, keygen, pay_to_info, At, Expect, Keys, Net};

fn fail(msg: impl Into<String>) -> ! {
    let msg = msg.into();
    println!("{}", json!({ "error": msg }));
    eprintln!("error: {msg}");
    std::process::exit(2)
}

struct Args {
    cmd: &'static str,
    flags: HashMap<String, String>,
    switches: Vec<String>,
}

// Listed in every build, so the unknown-command message reads the same whatever features the binary has
const COMMANDS: [&str; 5] = ["keygen", "derive-uivk", "decrypt", "owns", "build-test"];
const SWITCHES: &[&str] = &["--pretty"];
/// Flags that take a value, written as `--name value` or `--name=value`
const VALUE_FLAGS: &[&str] = &[
    "--network",
    "--seed-hex",
    "--height",
    "--tip",
    "--pay-to",
    "--expect-memo",
    "--min-zat",
    "--tx-hex",
    "--tx-file",
    "--address",
    #[cfg(feature = "testbuild")]
    "--merchant-address",
    #[cfg(feature = "testbuild")]
    "--value",
    #[cfg(feature = "testbuild")]
    "--memo",
    #[cfg(feature = "testbuild")]
    "--agent-seed-hex",
];

fn usage() -> String {
    format!(
        "usage: zdecrypt <{}> [flags] (the key is read from ZDECRYPT_KEY only; keygen prints a seedHex to stdout, which on mainnet controls real money, so redirect it to a 0600 file)",
        COMMANDS.join("|")
    )
}

fn unknown_command() -> ! {
    fail(format!("unknown command (expected one of: {})", COMMANDS.join(", ")))
}

fn unexpected(position: usize) -> String {
    format!("unexpected argument at position {position}")
}

// A token that is not Unicode is reported by position, because args() would panic with it in the message
fn unicode(position: usize, token: OsString) -> String {
    token.into_string().unwrap_or_else(|_| fail(unexpected(position)))
}

// Every error here is fixed text, a flag name from the lists above or a position, never a token from argv
fn parse_args() -> Args {
    let mut argv = std::env::args_os().enumerate().skip(1);
    let Some((position, token)) = argv.next() else { fail(usage()) };
    let token = unicode(position, token);
    let cmd = COMMANDS.into_iter().find(|c| *c == token).unwrap_or_else(|| unknown_command());
    if cmd == "build-test" && !cfg!(feature = "testbuild") {
        unknown_command();
    }
    let mut flags = HashMap::new();
    let mut switches = Vec::new();
    while let Some((position, token)) = argv.next() {
        let token = unicode(position, token);
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (token.as_str(), None),
        };
        if name == "--key" {
            fail("the key is read from ZDECRYPT_KEY only");
        }
        if let Some(switch) = SWITCHES.iter().copied().find(|s| *s == name) {
            if inline.is_some() {
                fail(unexpected(position));
            }
            switches.push(switch.to_string());
        } else if let Some(flag) = VALUE_FLAGS.iter().copied().find(|f| *f == name) {
            let value = match inline {
                Some(value) => value.to_string(),
                None => match argv.next() {
                    Some((position, value)) => unicode(position, value),
                    None => fail(format!("{flag} needs a value")),
                },
            };
            flags.insert(flag.to_string(), value);
        } else {
            fail(unexpected(position));
        }
    }
    Args { cmd, flags, switches }
}

/// --network, else ZDECRYPT_NETWORK (set but empty counts as unset, as for ZDECRYPT_KEY), else testnet
fn net_from(args: &Args) -> Net {
    let (source, value) = match args.flags.get("--network") {
        Some(v) => ("--network", v.clone()),
        None => match std::env::var("ZDECRYPT_NETWORK").ok().filter(|s| !s.trim().is_empty()) {
            Some(v) => ("ZDECRYPT_NETWORK", v),
            None => return Net::Testnet,
        },
    };
    // Errors carry fixed text only, never the value that was given
    value.parse().unwrap_or_else(|e| fail(format!("{source} {e}")))
}

fn key_from(net: Net) -> Keys {
    let s = std::env::var("ZDECRYPT_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| fail(format!("set ZDECRYPT_KEY to a {} UIVK or UFVK", net.name())));
    decode_key(&s, net).unwrap_or_else(|e| fail(e))
}

fn height_arg(v: &str, name: &str) -> BlockHeight {
    v.parse::<u32>().map(BlockHeight::from_u32).unwrap_or_else(|_| fail(format!("{name} must be a block height")))
}

fn at_from(height: Option<&String>, tip: Option<&String>) -> Result<At, String> {
    match (height, tip) {
        (Some(h), None) => Ok(At::Mined(height_arg(h, "--height"))),
        (None, Some(t)) => Ok(At::Mempool { tip: height_arg(t, "--tip") }),
        _ => Err("give exactly one of --height (mined) or --tip (mempool)".into()),
    }
}

fn expect_from(memo: Option<String>, min_zat: Option<String>) -> Result<Option<Expect>, String> {
    match (memo, min_zat) {
        (None, None) => Ok(None),
        (Some(memo), Some(z)) => {
            let min_zat = z.parse::<u64>().map_err(|_| "min zat must be a whole number of zatoshi".to_string())?;
            Ok(Some(Expect { memo, min_zat }))
        }
        _ => Err("give the expected memo and the minimum zatoshi together".into()),
    }
}

fn hex_bytes(s: &str) -> Result<Vec<u8>, String> {
    hex::decode(s.trim()).map_err(|e| match e {
        // The bad character is left out because the input may be a key typed in the wrong place
        hex::FromHexError::InvalidHexCharacter { index, .. } => format!("tx is not hex: invalid character at position {index}"),
        _ => format!("tx is not hex: {e}"),
    })
}

fn emit(v: &Value, pretty: bool) {
    if pretty {
        println!("{}", serde_json::to_string_pretty(v).unwrap());
    } else {
        println!("{v}");
    }
}

fn main() {
    let args = parse_args();
    let net = net_from(&args);
    let pretty = args.switches.iter().any(|s| s == "--pretty");
    match args.cmd {
        "keygen" => {
            let mut seed = [0u8; 32];
            match args.flags.get("--seed-hex") {
                Some(h) => {
                    let b = hex::decode(h).unwrap_or_else(|_| fail("--seed-hex is not hex"));
                    seed = b.try_into().unwrap_or_else(|_| fail("--seed-hex must be 32 bytes"));
                }
                None => getrandom::fill(&mut seed).unwrap_or_else(|e| fail(format!("no OS randomness: {e}"))),
            }
            emit(&keygen(&seed, net).unwrap_or_else(|e| fail(e)), pretty);
        }
        "derive-uivk" => {
            let keys = key_from(net);
            emit(&json!({ "uivk": encode_uivk(&keys).unwrap_or_else(|e| fail(e)), "from": keys.kind() }), pretty);
        }
        "decrypt" => {
            let keys = key_from(net);
            let at = at_from(args.flags.get("--height"), args.flags.get("--tip")).unwrap_or_else(|e| fail(e));
            let hex_text = if let Some(h) = args.flags.get("--tx-hex") {
                h.clone()
            } else if let Some(p) = args.flags.get("--tx-file") {
                std::fs::read_to_string(p).unwrap_or_else(|e| fail(format!("cannot read --tx-file: {e}")))
            } else {
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s).unwrap_or_else(|e| fail(format!("cannot read stdin: {e}")));
                s
            };
            let raw = hex_bytes(&hex_text).unwrap_or_else(|e| fail(e));
            let pay_to = args.flags.get("--pay-to").map(|s| decode_ua(s, net).unwrap_or_else(|e| fail(e)));
            let expect = expect_from(args.flags.get("--expect-memo").cloned(), args.flags.get("--min-zat").cloned())
                .unwrap_or_else(|e| fail(e));
            emit(&inspect_expect(&raw, &keys, at, pay_to.as_ref(), expect.as_ref()).unwrap_or_else(|e| fail(e)), pretty);
        }
        "owns" => {
            let keys = key_from(net);
            let ua = decode_ua(args.flags.get("--address").unwrap_or_else(|| fail("--address is required")), net).unwrap_or_else(|e| fail(e));
            emit(&pay_to_info(&keys, &ua), pretty);
        }
        #[cfg(feature = "testbuild")]
        "build-test" => emit(&zdecrypt::testbuild::run(&args.flags, net).unwrap_or_else(|e| fail(e)), pretty),
        _ => unknown_command(),
    }
}
