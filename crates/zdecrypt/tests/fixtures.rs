//! Offline regression tests on frozen testnet transactions and the synthetic v6 deposit.
//!
//! Real txs were fetched from testnet.zec.rocks with GetTransaction on 2026-10-27. The x402 and
//! paywall UIVKs are demo keys their owners published in Kage and Hanko. The synthetic deposit was
//! built by `zdecrypt build-test` to a freshly generated throwaway merchant key.

use serde_json::Value;
use zcash_protocol::consensus::BlockHeight;
use zdecrypt::{decode_key, decode_ua, inspect, inspect_expect, keygen, At, Expect, Net};

const FX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

fn mined(txid: &str) -> (Vec<u8>, At) {
    let s = std::fs::read_to_string(format!("{FX}/{txid}.mined")).unwrap();
    let (h, hex) = s.trim().split_once(' ').unwrap();
    (hex::decode(hex).unwrap(), At::Mined(BlockHeight::from_u32(h.parse().unwrap())))
}

fn fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{FX}/keys-and-synthetic.json")).unwrap()).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap()
}

#[test]
fn real_ironwood_payment_decrypts_with_published_uivk() {
    let f = fixture();
    let keys = decode_key(s(&f, "publishedX402Uivk"), Net::Testnet).unwrap();
    let (raw, at) = mined("030c3cbf78ce8460553bba4e82c0ba813f039bd3ecf4d7f2e81c59837dc28351");
    let r = inspect(&raw, &keys, at, None).unwrap();
    assert_eq!(r["txid"], "030c3cbf78ce8460553bba4e82c0ba813f039bd3ecf4d7f2e81c59837dc28351");
    assert_eq!((r["version"].as_u64(), s(&r, "branchId")), (Some(6), "0x77190ad9"));
    let o = &r["outputs"][0];
    assert_eq!((s(o, "pool"), o["valueZat"].as_u64(), s(o, "memoText")), ("ironwood", Some(100_000), "x402z-f19a63da20cbc0749ea800b3"));
    assert_eq!(r["outputs"].as_array().unwrap().len(), 1);
}

#[test]
fn real_payment_with_transparent_output_is_refused() {
    let f = fixture();
    let keys = decode_key(s(&f, "publishedPaywallUivk"), Net::Testnet).unwrap();
    let ua = decode_ua(s(&f, "publishedPaywallAddress"), Net::Testnet).unwrap();
    let (raw, at) = mined("bb8d88426b96a4cd92ec90446d154de5321da7b2bb863d9249a43838e49a82ec");
    let e = Expect { memo: "zpv-d7289a63fabd56ff2f8a7261".into(), min_zat: 10_000 };
    let r = inspect_expect(&raw, &keys, at, Some(&ua), Some(&e)).unwrap();
    assert_eq!(r["transparentOut"], 1);
    assert_eq!(r["verdict"]["reasons"], serde_json::json!(["TRANSPARENT_PART"]));
}

#[test]
fn unrelated_real_txs_parse_and_decrypt_nothing() {
    let f = fixture();
    let keys = decode_key(s(&f["merchant"], "uivk"), Net::Testnet).unwrap();
    for txid in [
        "658e46afb50b0c4f85a757d13f932a7d2cac8973568b222b99b0bef49290dacf",
        "521793dde2a1827c024ab470ff39554ae1e2e9eff52418494a4562d355773eb3",
        "4a9412fa75194d31fdae2c796765e1617cdeade286ab231ab75705db827c8634",
    ] {
        let (raw, at) = mined(txid);
        let r = inspect(&raw, &keys, at, None).unwrap();
        assert_eq!(s(&r, "txid"), txid);
        assert_eq!(s(&r, "branch"), "Nu7");
        assert!(r["outputs"].as_array().unwrap().is_empty());
    }
    let mempool = std::fs::read_to_string(format!("{FX}/0616c4a3594057bff03e87ca9399cbe7294d3f435c68b069453b1f10f5afd8c9.mempool-tip-4547319")).unwrap();
    let r = inspect(&hex::decode(mempool.trim()).unwrap(), &keys, At::Mempool { tip: BlockHeight::from_u32(4_547_319) }, None).unwrap();
    assert_eq!((s(&r, "heightKind"), r["heightUsed"].as_u64()), ("mempool", Some(4_547_320)));
}

#[test]
fn synthetic_v6_deposit_verdict_passes_only_for_its_exact_memo() {
    let f = fixture();
    let m = &f["merchant"];
    let d = &f["deposit"];
    let raw = hex::decode(s(d, "hex")).unwrap();
    let at = At::Mempool { tip: BlockHeight::from_u32(d["tip"].as_u64().unwrap() as u32) };
    let ua = decode_ua(s(m, "address"), Net::Testnet).unwrap();
    let ok = Expect { memo: s(d, "memo").into(), min_zat: 100_000 };
    for key in [s(m, "uivk"), s(m, "ufvk")] {
        let r = inspect_expect(&raw, &decode_key(key, Net::Testnet).unwrap(), at, Some(&ua), Some(&ok)).unwrap();
        assert_eq!(s(&r, "txid"), s(d, "txid"));
        assert_eq!((r["transparentIn"].as_u64(), r["transparentOut"].as_u64()), (Some(0), Some(0)));
        assert_eq!(r["verdict"]["ok"], true, "{r}");
        assert_eq!(r["verdict"]["paidZat"], 100_000);
    }
    let keys = decode_key(s(m, "uivk"), Net::Testnet).unwrap();
    // The verdict wants the exact memo, so another index of the same session is a mismatch, though the facilitator credits it (protocol §5.1)
    let another_index = Expect { memo: format!("{}1", s(d, "memo").trim_end_matches('0')), min_zat: 100_000 };
    let r = inspect_expect(&raw, &keys, at, Some(&ua), Some(&another_index)).unwrap();
    assert_eq!(r["verdict"]["reasons"][0], "MEMO_MISMATCH");
    let agent = inspect(&raw, &decode_key(s(&f, "agentUfvk"), Net::Testnet).unwrap(), at, None).unwrap();
    assert_eq!((s(&agent["outputs"][0], "scope"), agent["outputs"][0]["valueZat"].as_u64()), ("internal", Some(40_000)));
    let mut trailing = raw.clone();
    trailing.push(0);
    assert!(inspect(&trailing, &keys, at, None).unwrap_err().contains("trailing"));
}

#[test]
fn synthetic_sapling_output_decrypts() {
    let f = fixture();
    let m = &f["merchant"];
    let raw = hex::decode(s(&f["funding"], "hex")).unwrap();
    let ua = decode_ua(s(m, "address"), Net::Testnet).unwrap();
    let r = inspect(&raw, &decode_key(s(m, "uivk"), Net::Testnet).unwrap(), At::Mempool { tip: BlockHeight::from_u32(4_547_329) }, Some(&ua)).unwrap();
    let o = &r["outputs"][0];
    assert_eq!((s(o, "pool"), o["valueZat"].as_u64(), s(o, "memoText"), o["toPayTo"].as_bool()), ("sapling", Some(20_000), "z402 sapling check", Some(true)));
}

#[test]
fn synthetic_v6_deposit_decrypts_under_regtest() {
    let f = fixture();
    let d = &f["deposit"];
    // Testnet and regtest share coin type 1, so the testnet merchant seed gives the same receivers on regtest
    let seed: [u8; 32] = hex::decode(s(&f["merchant"], "seedHex")).unwrap().try_into().unwrap();
    let merchant = keygen(&seed, Net::Regtest).unwrap();
    let keys = decode_key(s(&merchant, "uivk"), Net::Regtest).unwrap();
    // The deposit pays the Orchard receiver of the merchant's Orchard and Sapling address, not of its Orchard-only one
    let ua = decode_ua(s(&merchant, "address"), Net::Regtest).unwrap();
    let at = At::Mempool { tip: BlockHeight::from_u32(d["tip"].as_u64().unwrap() as u32) };

    let r = inspect(&hex::decode(s(d, "hex")).unwrap(), &keys, at, Some(&ua)).unwrap();

    assert_eq!(s(&r, "txid"), s(d, "txid"));
    assert_eq!(r["outputs"].as_array().unwrap().len(), 1, "{r}");
    let o = &r["outputs"][0];
    assert_eq!(
        (s(o, "pool"), s(o, "scope"), o["valueZat"].as_u64(), o["toPayTo"].as_bool(), s(o, "memoText")),
        ("ironwood", "external", Some(100_000), Some(true), s(d, "memo"))
    );
    assert!(s(o, "recipient").starts_with("uregtest1"), "{}", s(o, "recipient"));
}
