//! Key-type detection tries a decode, never a string prefix

use serde_json::Value;
use zcash_address::unified::Revision;
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedIncomingViewingKey};
use zdecrypt::{decode_key, NETWORK};

const FX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/keys-and-synthetic.json");

fn merchant(field: &str) -> String {
    let f: Value = serde_json::from_str(&std::fs::read_to_string(FX).unwrap()).unwrap();
    f["merchant"][field].as_str().unwrap().to_owned()
}

/// The same UFVK as a ZIP 316 revision 2 string, which starts with `uvftest` where revision 0 has `uview`
fn ufvk_r2(ufvk: &str) -> String {
    UnifiedFullViewingKey::decode(&NETWORK, ufvk).unwrap().encode_revision(&NETWORK, Revision::R2).unwrap()
}

/// The same UIVK as a ZIP 316 revision 2 string, which starts with `uvitest` where revision 0 has `uivk`
fn uivk_r2(uivk: &str) -> String {
    UnifiedIncomingViewingKey::decode(&NETWORK, uivk).unwrap().encode_revision(&NETWORK, Revision::R2).unwrap()
}

#[test]
fn ufvk_is_detected_without_prefix_rules() {
    let ufvk = merchant("ufvk");
    assert_eq!(decode_key(&ufvk).unwrap().kind(), "ufvk");
    let r2 = ufvk_r2(&ufvk);
    assert!(r2.starts_with("uvftest1"), "the revision 2 string must not look like a uview string");
    assert_eq!(decode_key(&r2).unwrap().kind(), "ufvk");
}

#[test]
fn uivk_decodes_as_uivk() {
    let uivk = merchant("uivk");
    assert_eq!(decode_key(&uivk).unwrap().kind(), "uivk");
    let r2 = uivk_r2(&uivk);
    assert!(r2.starts_with("uvitest1"), "the revision 2 string must not look like a uivk string");
    assert_eq!(decode_key(&r2).unwrap().kind(), "uivk");
}

#[test]
fn address_is_not_a_key() {
    // Keys is not Debug, so unwrap_err does not compile
    let Err(err) = decode_key(&merchant("orchardOnlyAddress")) else {
        panic!("an address must not decode as a key");
    };
    assert!(err.contains("not a testnet unified"), "{err}");
    assert!(err.contains("full viewing key") && err.contains("incoming viewing key"), "{err}");
}
