//! The network decides prefixes and activation heights, and a key or address from another one is refused by name

use std::io::Write;
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};
use zcash_address::unified::Revision;
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedIncomingViewingKey};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network, NetworkType, NetworkUpgrade, Parameters, UPGRADES_IN_ORDER};
use zdecrypt::{decode_key, decode_ua, keygen, pay_to_info, Net};

const FX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/keys-and-synthetic.json");
const NETS: [Net; 3] = [Net::Regtest, Net::Testnet, Net::Mainnet];

/// Bytes 00 01 02 .. 1f
fn seed() -> [u8; 32] {
    std::array::from_fn(|i| i as u8)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap()
}

fn testnet_merchant(field: &str) -> String {
    let f: Value = serde_json::from_str(&std::fs::read_to_string(FX).unwrap()).unwrap();
    f["merchant"][field].as_str().unwrap().to_owned()
}

/// Keys is not Debug, so unwrap_err does not compile
fn refusal(key: &str, net: Net) -> String {
    match decode_key(key, net) {
        Ok(_) => panic!("a key must not decode on {}", net.name()),
        Err(e) => e,
    }
}

#[test]
fn regtest_keygen_has_regtest_hrps() {
    let k = keygen(&seed(), Net::Regtest).unwrap();
    assert_eq!(s(&k, "network"), "regtest");
    assert!(s(&k, "uivk").starts_with("uivkregtest1"), "{}", &s(&k, "uivk")[..16]);
    assert!(s(&k, "ufvk").starts_with("uviewregtest1"), "{}", &s(&k, "ufvk")[..16]);
    assert!(s(&k, "orchardOnlyAddress").starts_with("uregtest1"), "{}", s(&k, "orchardOnlyAddress"));
    let keys = decode_key(s(&k, "uivk"), Net::Regtest).unwrap();
    let ua = decode_ua(s(&k, "orchardOnlyAddress"), Net::Regtest).unwrap();
    assert_eq!(pay_to_info(&keys, &ua)["ownedByKey"], true);
}

#[test]
fn mainnet_keygen_has_mainnet_hrps() {
    let k = keygen(&seed(), Net::Mainnet).unwrap();
    assert_eq!(s(&k, "network"), "mainnet");
    assert!(s(&k, "uivk").starts_with("uivk1"), "{}", &s(&k, "uivk")[..16]);
    assert!(s(&k, "ufvk").starts_with("uview1"), "{}", &s(&k, "ufvk")[..16]);
    assert!(s(&k, "orchardOnlyAddress").starts_with("u1"), "{}", s(&k, "orchardOnlyAddress"));
    let keys = decode_key(s(&k, "uivk"), Net::Mainnet).unwrap();
    let ua = decode_ua(s(&k, "orchardOnlyAddress"), Net::Mainnet).unwrap();
    assert_eq!(pay_to_info(&keys, &ua)["ownedByKey"], true);
}

/// Each network's UIVK, UFVK and UA prefixes at ZIP 316 revision 0, then at revision 2
const HRPS: [(Net, [&str; 3], [&str; 3]); 3] = [
    (Net::Regtest, ["uivkregtest1", "uviewregtest1", "uregtest1"], ["uviregtest1", "uvfregtest1", "zuregtest1"]),
    (Net::Testnet, ["uivktest1", "uviewtest1", "utest1"], ["uvitest1", "uvftest1", "zutest1"]),
    (Net::Mainnet, ["uivk1", "uview1", "u1"], ["uvi1", "uvf1", "zu1"]),
];

#[test]
fn each_network_uses_its_own_prefixes_at_both_revisions() {
    for (net, r0, r2) in HRPS {
        let k = keygen(&seed(), net).unwrap();
        let (uivk, ufvk, address) = (s(&k, "uivk"), s(&k, "ufvk"), s(&k, "orchardOnlyAddress"));
        let ua = decode_ua(address, net).unwrap();
        let revised = [
            UnifiedIncomingViewingKey::decode(&net, uivk).unwrap().encode_revision(&net, Revision::R2).unwrap(),
            UnifiedFullViewingKey::decode(&net, ufvk).unwrap().encode_revision(&net, Revision::R2).unwrap(),
            ua.encode_revision(&net, Revision::R2).unwrap(),
        ];
        let strings = [uivk, ufvk, address].into_iter().chain(revised.iter().map(String::as_str));
        for (got, want) in strings.zip(r0.into_iter().chain(r2)) {
            assert!(got.starts_with(want), "{}: {} does not start with {want}", net.name(), &got[..got.len().min(16)]);
        }
        assert_eq!(decode_key(&revised[0], net).unwrap().kind(), "uivk");
        assert_eq!(decode_key(&revised[1], net).unwrap().kind(), "ufvk");
        assert_eq!(decode_ua(&revised[2], net).unwrap(), ua);
    }
}

#[test]
fn testnet_key_is_refused_on_regtest() {
    for (field, kind, other) in [("uivk", "incoming viewing key", "full viewing key"), ("ufvk", "full viewing key", "incoming viewing key")] {
        let key = testnet_merchant(field);
        let err = refusal(&key, Net::Regtest);
        assert!(err.contains(&format!("not a regtest unified {kind}")), "{err}");
        assert!(err.contains("Test"), "the error must name the network the key is for: {err}");
        assert!(!err.contains(other), "{err}");
        assert!(!err.contains(&key[12..40]), "the error echoes key bytes");
    }
}

#[test]
fn keys_and_addresses_from_another_network_are_refused_by_name() {
    for from in NETS {
        let k = keygen(&seed(), from).unwrap();
        let named = format!("for the {:?} network", from.network_type());
        for on in NETS.into_iter().filter(|n| *n != from) {
            for (field, kind, other) in [("uivk", "incoming viewing key", "full viewing key"), ("ufvk", "full viewing key", "incoming viewing key")] {
                let err = refusal(s(&k, field), on);
                assert!(err.contains(&format!("not a {} unified {kind}", on.name())), "{err}");
                assert!(err.contains(&named), "{err}");
                assert!(!err.contains(other), "{err}");
                assert!(!err.contains(&s(&k, field)[12..40]), "the error echoes key bytes");
            }
            let address = s(&k, "orchardOnlyAddress");
            let Err(err) = decode_ua(address, on) else {
                panic!("a {} address must not decode on {}", from.name(), on.name());
            };
            assert!(err.contains(&format!("not a {} unified address", on.name())), "{err}");
            assert!(err.contains(&named), "{err}");
            assert!(!err.contains(&address[12..40]), "the error echoes address bytes");
        }
        // A key given as an address names no network and is not echoed
        let Err(err) = decode_ua(s(&k, "uivk"), from) else {
            panic!("a key must not decode as an address");
        };
        assert!(err.contains(&format!("not a {} unified address", from.name())), "{err}");
        assert!(!err.contains("for the") && !err.contains(&s(&k, "uivk")[12..40]), "{err}");
    }
}

#[test]
fn regtest_uses_the_z3_activation_heights() {
    use NetworkUpgrade::*;
    let at = |h: u32| Some(BlockHeight::from_u32(h));
    for nu in [Overwinter, Sapling, Blossom, Heartwood, Canopy] {
        assert_eq!(Net::Regtest.activation_height(nu), at(1), "{nu}");
    }
    for nu in [Nu5, Nu6, Nu6_1, Nu6_2, Nu6_3] {
        assert_eq!(Net::Regtest.activation_height(nu), at(2), "{nu}");
    }
    assert_eq!(Net::Regtest.activation_height(Nu7), None);
    assert_eq!(Net::Regtest.network_type(), NetworkType::Regtest);
    // So a deposit at any height from 2 on is a v6 tx on the NU6.3 branch
    assert_eq!(BranchId::for_height(&Net::Regtest, BlockHeight::from_u32(1)), BranchId::Canopy);
    for h in [2, 10, 1_000_000] {
        assert_eq!(u32::from(BranchId::for_height(&Net::Regtest, BlockHeight::from_u32(h))), 0x37a5_165b, "height {h}");
    }
}

#[test]
fn testnet_and_mainnet_keep_the_real_activation_heights() {
    for (net, real) in [(Net::Testnet, Network::TestNetwork), (Net::Mainnet, Network::MainNetwork)] {
        assert_eq!(net.network_type(), real.network_type());
        for nu in UPGRADES_IN_ORDER {
            assert_eq!(net.activation_height(*nu), real.activation_height(*nu), "{} {nu}", net.name());
        }
    }
}

/// Runs the real binary with a clean environment, so ZDECRYPT_* variables of the caller cannot leak in
fn spawn(args: &[&str], env: &[(&str, &str)], stdin: &str) -> Output {
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
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

/// One JSON object on stdout and the exit code
fn run(args: &[&str], env: &[(&str, &str)]) -> (i32, Value) {
    let out = spawn(args, env, "");
    let json = serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {}", String::from_utf8_lossy(&out.stdout)));
    (out.status.code().unwrap(), json)
}

#[test]
fn network_flag_beats_env_and_the_default_is_testnet() {
    let seed = hex::encode(seed());
    let uivk = |extra: &[&str], env: &[(&str, &str)]| {
        let mut args = vec!["keygen", "--seed-hex", seed.as_str()];
        args.extend_from_slice(extra);
        let (code, v) = run(&args, env);
        assert_eq!(code, 0, "{v}");
        s(&v, "uivk")[..12].to_owned()
    };
    assert!(uivk(&[], &[]).starts_with("uivktest1"));
    assert!(uivk(&["--network", "regtest"], &[]).starts_with("uivkregtest1"));
    assert!(uivk(&["--network", "mainnet"], &[]).starts_with("uivk1"));
    assert!(uivk(&[], &[("ZDECRYPT_NETWORK", "regtest")]).starts_with("uivkregtest1"));
    assert!(uivk(&["--network", "mainnet"], &[("ZDECRYPT_NETWORK", "regtest")]).starts_with("uivk1"));
    // A variable that is empty or blank counts as unset, as ZDECRYPT_KEY does
    for blank in ["", " "] {
        assert!(uivk(&[], &[("ZDECRYPT_NETWORK", blank)]).starts_with("uivktest1"));
    }
}

#[test]
fn an_unknown_network_is_refused_without_echoing_it() {
    for (args, env, source) in [
        (vec!["keygen", "--network", "zcash:regtest"], vec![], "--network"),
        (vec!["keygen"], vec![("ZDECRYPT_NETWORK", "zcash:regtest")], "ZDECRYPT_NETWORK"),
    ] {
        let (code, v) = run(&args, &env);
        assert_eq!(code, 2, "{v}");
        let err = s(&v, "error");
        assert!(err.contains(source) && err.contains("regtest, testnet or mainnet"), "{err}");
        assert!(!err.contains("zcash:"), "{err}");
    }
}

#[test]
fn every_subcommand_reads_its_key_on_the_chosen_network() {
    let k = keygen(&seed(), Net::Regtest).unwrap();
    let (uivk, address) = (s(&k, "uivk"), s(&k, "orchardOnlyAddress"));
    let key = [("ZDECRYPT_KEY", uivk)];
    let (code, v) = run(&["derive-uivk", "--network", "regtest"], &key);
    assert_eq!((code, v), (0, json!({ "uivk": uivk, "from": "uivk" })));
    let (code, v) = run(&["owns", "--address", address], &[key[0], ("ZDECRYPT_NETWORK", "regtest")]);
    assert_eq!((code, &v["ownedByKey"]), (0, &json!(true)), "{v}");
    // Without a network the same key and address are testnet's to refuse
    for args in [vec!["derive-uivk"], vec!["owns", "--address", address]] {
        let (code, v) = run(&args, &key);
        assert_eq!(code, 2, "{v}");
        assert!(s(&v, "error").contains("not a testnet unified"), "{v}");
        assert!(!s(&v, "error").contains(&uivk[12..40]), "the error echoes key bytes");
    }
}

#[test]
fn serve_decodes_pay_to_on_the_keys_network() {
    let regtest = keygen(&seed(), Net::Regtest).unwrap();
    let testnet = keygen(&seed(), Net::Testnet).unwrap();
    let request = |id: u32, pay_to: &str| json!({ "id": id, "height": 10, "txHex": "00", "payTo": pay_to });
    let input = format!("{}\n{}\n", request(1, s(&regtest, "orchardOnlyAddress")), request(2, s(&testnet, "orchardOnlyAddress")));
    let out = spawn(&["serve", "--network", "regtest"], &[("ZDECRYPT_KEY", s(&regtest, "uivk"))], &input);
    let replies: Vec<Value> = String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(replies.len(), 2, "{replies:?}");
    // The regtest address is accepted, so it is the made-up tx that fails
    assert_eq!((&replies[0]["id"], &replies[0]["ok"]), (&json!(1), &json!(false)));
    assert!(s(&replies[0], "error").starts_with("transaction does not parse"), "{}", replies[0]);
    assert!(s(&replies[1], "error").contains("not a regtest unified address"), "{}", replies[1]);
}

#[cfg(feature = "testbuild")]
#[test]
fn regtest_v6_deposit_decrypts() {
    let merchant = keygen(&seed(), Net::Regtest).unwrap();
    // The Orchard and Sapling UA, so the funding tx also pays a Sapling note that the key must find
    let (uivk, pay_to) = (s(&merchant, "uivk"), s(&merchant, "address"));
    let memo = format!("{}:0", "cd".repeat(32));

    let (code, built) = run(&["build-test", "--network", "regtest", "--height", "10", "--merchant-address", pay_to, "--memo", &memo], &[]);
    assert_eq!(code, 0, "{built}");
    assert_eq!(built["targetHeight"], 10);
    let deposit = s(&built["depositTx"], "hex");

    let args = ["decrypt", "--network", "regtest", "--tip", "9", "--pay-to", pay_to, "--expect-memo", &memo, "--min-zat", "100000", "--tx-hex", deposit];
    let (code, r) = run(&args, &[("ZDECRYPT_KEY", uivk)]);
    assert_eq!(code, 0, "{r}");
    assert_eq!(s(&r, "txid"), s(&built["depositTx"], "txid"));
    // v6 under NU6.3, which is the branch the Z3 stack mines from height 2
    assert_eq!((r["version"].as_u64(), s(&r, "branchId"), s(&r, "branch")), (Some(6), "0x37a5165b", "Nu6_3"));
    assert_eq!((r["heightUsed"].as_u64(), s(&r, "heightKind"), &r["branchMatchesHeight"]), (Some(10), "mempool", &json!(true)));
    assert_eq!((r["transparentIn"].as_u64(), r["transparentOut"].as_u64()), (Some(0), Some(0)));
    assert_eq!(r["outputs"].as_array().unwrap().len(), 1, "{r}");
    let o = &r["outputs"][0];
    assert_eq!(
        (s(o, "pool"), s(o, "scope"), o["valueZat"].as_u64(), s(o, "memoText"), o["toPayTo"].as_bool(), o["noteVersion"].as_u64()),
        ("ironwood", "external", Some(100_000), memo.as_str(), Some(true), Some(3))
    );
    assert!(s(o, "recipient").starts_with("uregtest1"), "{}", s(o, "recipient"));
    assert_eq!(r["payTo"]["ownedByKey"], true);
    assert_eq!((&r["verdict"]["ok"], r["verdict"]["paidZat"].as_u64()), (&json!(true), Some(100_000)), "{r}");

    // A Sapling note decrypts only under the ZIP 212 rule of the right network, here Canopy at height 1
    let args = ["decrypt", "--network", "regtest", "--tip", "9", "--pay-to", pay_to, "--tx-hex", s(&built["fundingTx"], "hex")];
    let (code, f) = run(&args, &[("ZDECRYPT_KEY", uivk)]);
    assert_eq!(code, 0, "{f}");
    assert_eq!(f["outputs"].as_array().unwrap().len(), 1, "{f}");
    let o = &f["outputs"][0];
    assert_eq!(
        (s(o, "pool"), o["valueZat"].as_u64(), s(o, "memoText"), o["toPayTo"].as_bool()),
        ("sapling", Some(20_000), "z402 sapling check", Some(true))
    );
    assert!(s(o, "recipient").starts_with("zregtestsapling1"), "{}", s(o, "recipient"));
}
