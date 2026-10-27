//! zdecrypt CLI.
//!
//! keygen [--seed-hex HEX]                      fresh testnet account, prints UFVK, UIVK and a shielded-only UA
//! derive-uivk                                  UFVK to UIVK
//! decrypt (--height H | --tip T) [--pay-to UA] [--expect-memo M --min-zat Z]
//!         [--tx-hex HEX | --tx-file PATH | hex on stdin]
//! owns --address UA                            which receivers of UA belong to the key
//! serve                                        NDJSON requests on stdin, one JSON reply per line on stdout
//! build-test ...                               testbuild feature only, see testbuild.rs
//!
//! The key comes from ZDECRYPT_KEY (preferred, argv is visible in ps) or --key. --height is the
//! mined height. --tip is the chain tip for a mempool tx, which is judged at tip + 1. With
//! --expect-memo and --min-zat the report carries a verdict for the z402 deposit rule. Output is
//! one JSON object on stdout. Exit 0 on success, 2 on any error with an error object on stdout.

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};

use serde_json::{json, Value};
use zcash_protocol::consensus::BlockHeight;
use zdecrypt::{decode_key, decode_ua, encode_uivk, inspect_expect, keygen, pay_to_info, At, Expect, Keys};

fn fail(msg: impl Into<String>) -> ! {
    let msg = msg.into();
    println!("{}", json!({ "error": msg }));
    eprintln!("error: {msg}");
    std::process::exit(2)
}

struct Args {
    cmd: String,
    flags: HashMap<String, String>,
    switches: Vec<String>,
}

const SWITCHES: &[&str] = &["--pretty"];

fn parse_args() -> Args {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_else(|| fail("usage: zdecrypt <keygen|derive-uivk|decrypt|owns|serve|build-test> [flags]"));
    let mut flags = HashMap::new();
    let mut switches = Vec::new();
    while let Some(a) = it.next() {
        if SWITCHES.contains(&a.as_str()) {
            switches.push(a);
        } else if a.starts_with("--") {
            let v = it.next().unwrap_or_else(|| fail(format!("{a} needs a value")));
            flags.insert(a, v);
        } else {
            fail(format!("unexpected argument {a}"));
        }
    }
    Args { cmd, flags, switches }
}

fn key_from(args: &Args) -> Keys {
    let s = std::env::var("ZDECRYPT_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| args.flags.get("--key").cloned())
        .unwrap_or_else(|| fail("set ZDECRYPT_KEY (or --key) to a testnet UIVK or UFVK"));
    decode_key(&s).unwrap_or_else(|e| fail(e))
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
    hex::decode(s.trim()).map_err(|e| format!("tx is not hex: {e}"))
}

fn emit(v: &Value, pretty: bool) {
    if pretty {
        println!("{}", serde_json::to_string_pretty(v).unwrap());
    } else {
        println!("{v}");
    }
}

fn serve(keys: &Keys) {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(e) => json!({ "id": null, "ok": false, "error": format!("request is not JSON: {e}") }),
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let result = (|| {
                    let num = |k: &str| req.get(k).and_then(Value::as_u64).map(|n| n.to_string());
                    let at = at_from(num("height").as_ref(), num("tip").as_ref())?;
                    let raw = hex_bytes(req.get("txHex").and_then(Value::as_str).ok_or("txHex is missing")?)?;
                    let pay_to = match req.get("payTo").and_then(Value::as_str) {
                        Some(s) => Some(decode_ua(s)?),
                        None => None,
                    };
                    let expect = expect_from(
                        req.get("expectMemo").and_then(Value::as_str).map(String::from),
                        num("minZat"),
                    )?;
                    inspect_expect(&raw, keys, at, pay_to.as_ref(), expect.as_ref())
                })();
                match result {
                    Ok(r) => json!({ "id": id, "ok": true, "result": r }),
                    Err(e) => json!({ "id": id, "ok": false, "error": e }),
                }
            }
        };
        if writeln!(stdout, "{reply}").and_then(|_| stdout.flush()).is_err() {
            break;
        }
    }
}

fn main() {
    let args = parse_args();
    let pretty = args.switches.iter().any(|s| s == "--pretty");
    match args.cmd.as_str() {
        "keygen" => {
            let mut seed = [0u8; 32];
            match args.flags.get("--seed-hex") {
                Some(h) => {
                    let b = hex::decode(h).unwrap_or_else(|_| fail("--seed-hex is not hex"));
                    seed = b.try_into().unwrap_or_else(|_| fail("--seed-hex must be 32 bytes"));
                }
                None => getrandom::fill(&mut seed).unwrap_or_else(|e| fail(format!("no OS randomness: {e}"))),
            }
            emit(&keygen(&seed).unwrap_or_else(|e| fail(e)), pretty);
        }
        "derive-uivk" => {
            let keys = key_from(&args);
            emit(&json!({ "uivk": encode_uivk(&keys).unwrap_or_else(|e| fail(e)), "from": keys.kind() }), pretty);
        }
        "decrypt" => {
            let keys = key_from(&args);
            let at = at_from(args.flags.get("--height"), args.flags.get("--tip")).unwrap_or_else(|e| fail(e));
            let hex_text = if let Some(h) = args.flags.get("--tx-hex") {
                h.clone()
            } else if let Some(p) = args.flags.get("--tx-file") {
                std::fs::read_to_string(p).unwrap_or_else(|e| fail(format!("cannot read {p}: {e}")))
            } else {
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s).unwrap_or_else(|e| fail(format!("cannot read stdin: {e}")));
                s
            };
            let raw = hex_bytes(&hex_text).unwrap_or_else(|e| fail(e));
            let pay_to = args.flags.get("--pay-to").map(|s| decode_ua(s).unwrap_or_else(|e| fail(e)));
            let expect = expect_from(args.flags.get("--expect-memo").cloned(), args.flags.get("--min-zat").cloned())
                .unwrap_or_else(|e| fail(e));
            emit(&inspect_expect(&raw, &keys, at, pay_to.as_ref(), expect.as_ref()).unwrap_or_else(|e| fail(e)), pretty);
        }
        "owns" => {
            let keys = key_from(&args);
            let ua = decode_ua(args.flags.get("--address").unwrap_or_else(|| fail("--address is required"))).unwrap_or_else(|e| fail(e));
            emit(&pay_to_info(&keys, &ua), pretty);
        }
        "serve" => serve(&key_from(&args)),
        #[cfg(feature = "testbuild")]
        "build-test" => emit(&zdecrypt::testbuild::run(&args.flags).unwrap_or_else(|e| fail(e)), pretty),
        other => fail(format!("unknown command {other}")),
    }
}
