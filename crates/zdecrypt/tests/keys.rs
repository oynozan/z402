//! Key decoding tries a decode, never a string prefix, and its errors never carry key material

use serde_json::Value;
use zcash_address::unified::{Encoding, Fvk, Ivk, Revision, Ufvk, Uitem, Uivk};
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedIncomingViewingKey};
use zcash_protocol::consensus::{Network, NetworkType};
use zdecrypt::{decode_key, decode_ua, NETWORK};

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

/// A well-formed ZIP 316 container whose Orchard item is one byte short of the 96 the parser expects
fn short_orchard_ufvk() -> String {
    let item = Uitem::Data(Fvk::Unknown { typecode: 3, data: vec![0xA5; 95] });
    Ufvk::try_from_items(Revision::R0, vec![item]).unwrap().encode(&NetworkType::Test)
}

/// The same for an incoming viewing key, one byte short of the 64 the parser expects
fn short_orchard_uivk() -> String {
    let item = Uitem::Data(Ivk::Unknown { typecode: 3, data: vec![0xA5; 63] });
    Uivk::try_from_items(Revision::R0, vec![item]).unwrap().encode(&NetworkType::Test)
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

#[test]
fn malformed_key_errors_never_echo_key_bytes() {
    for key in [short_orchard_ufvk(), short_orchard_uivk()] {
        let Err(err) = decode_key(&key) else {
            panic!("a short Orchard item must not decode");
        };
        assert!(err.contains("not a testnet unified"), "{err}");
        assert!(!err.contains("165") && !err.to_lowercase().contains("a5a5"), "the error echoes key bytes: {err}");
    }
}

#[test]
fn key_for_another_network_is_reported_as_such_and_nothing_else() {
    let ufvk = UnifiedFullViewingKey::decode(&NETWORK, &merchant("ufvk")).unwrap().encode(&Network::MainNetwork).unwrap();
    let uivk = UnifiedIncomingViewingKey::decode(&NETWORK, &merchant("uivk")).unwrap().encode(&Network::MainNetwork).unwrap();
    for (key, kind, other) in [(ufvk, "full viewing key", "incoming viewing key"), (uivk, "incoming viewing key", "full viewing key")] {
        let Err(err) = decode_key(&key) else {
            panic!("a mainnet key must not decode on testnet");
        };
        assert!(err.contains(&format!("not a testnet unified {kind}")) && err.contains("Main"), "{err}");
        assert!(!err.contains(other), "{err}");
    }
}

#[test]
fn address_errors_never_echo_a_key() {
    let uivk = merchant("uivk");
    let Err(err) = decode_ua(&uivk) else {
        panic!("a key must not decode as an address");
    };
    assert!(err.contains("not a testnet unified address"), "{err}");
    assert!(!err.contains(&uivk[12..40]), "the address error echoes the key it was given");
}
