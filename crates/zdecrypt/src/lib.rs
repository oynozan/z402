// zdecrypt follows the decrypt-loop shape of Kage crates/x402z-facilitator/src/verify.rs
// (github.com/nickthelegend/zec-shielded-x402 @ 0330760, MIT) and Hanko packages/core/src/lib.rs
// (github.com/nickthelegend/zec-payment-verify-sdk @ 3c7edae, MIT). See NOTICE.md.

//! Parse a Zcash testnet transaction and trial-decrypt its shielded outputs with a viewing key.
//!
//! The facilitator path is `decode_key` once at startup, then `inspect` once per deposit. `inspect`
//! parses the raw bytes under the consensus branch for the given height, rejects trailing bytes,
//! counts the transparent part, and trial-decrypts every Sapling output and every Orchard and
//! Ironwood action. Ironwood is the Orchard-family pool added in NU6.3 that carries new shielded
//! payments on testnet. Its notes go to the UA's Orchard receiver and decrypt with the same Orchard
//! incoming viewing key, but under the V3 note plaintext rules. A UIVK yields external-scope keys
//! only. A UFVK adds internal-scope keys, which see a wallet's own change. Nothing here touches
//! the network.

#[cfg(feature = "testbuild")]
pub mod testbuild;

use std::io::Cursor;
use std::time::Instant;

use orchard::keys::IncomingViewingKey as OrchardIvk;
use orchard::NoteVersion;
use sapling::keys::PreparedIncomingViewingKey as SaplingPivk;
use sapling::note_encryption::SaplingDomain;
use serde_json::{json, Value};
use zcash_address::unified::ParseError;
use zcash_keys::address::{Address, UnifiedAddress};
use zcash_keys::encoding::UnifiedDecodingError;
use zcash_keys::keys::{
    ReceiverRequirement, UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedIncomingViewingKey,
    UnifiedSpendingKey,
};
use zcash_note_encryption::try_note_decryption;
use zcash_primitives::transaction::components::sapling::zip212_enforcement;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::ZatBalance;
use zip32::Scope;

pub const NETWORK: Network = Network::TestNetwork;

pub struct Keys {
    kind: &'static str,
    pub uivk: UnifiedIncomingViewingKey,
    orchard: Vec<(Scope, OrchardIvk)>,
    sapling: Vec<(Scope, SaplingPivk)>,
}

impl Keys {
    /// Whichever of "ufvk" or "uivk" `decode_key` accepted
    pub fn kind(&self) -> &'static str {
        self.kind
    }
}

/// Where the transaction is, which fixes the height its consensus rules are taken from
#[derive(Clone, Copy, Debug)]
pub enum At {
    Mined(BlockHeight),
    /// A mempool tx is judged as if mined in the next block, as zcash_client_backend does
    Mempool { tip: BlockHeight },
}

impl At {
    pub fn height(self) -> BlockHeight {
        match self {
            At::Mined(h) => h,
            At::Mempool { tip } => tip + 1,
        }
    }

    fn kind(self) -> &'static str {
        match self {
            At::Mined(_) => "mined",
            At::Mempool { .. } => "mempool",
        }
    }
}

pub struct Decrypted {
    pub pool: &'static str,
    pub index: usize,
    pub scope: Scope,
    pub value_zat: u64,
    pub memo: [u8; 512],
    pub receiver: [u8; 43],
    pub recipient: String,
    pub diversifier_index: Option<u128>,
    pub note_version: Option<u8>,
}

/// Tries a UFVK decode, then a UIVK decode, never a prefix test, since revision 2 keys start uvftest or uvitest
pub fn decode_key(s: &str) -> Result<Keys, String> {
    let s = s.trim();
    let ufvk_err = match UnifiedFullViewingKey::decode(&NETWORK, s) {
        Ok(ufvk) => {
            let mut orchard = Vec::new();
            if let Some(fvk) = ufvk.orchard() {
                orchard.push((Scope::External, fvk.to_ivk(Scope::External)));
                orchard.push((Scope::Internal, fvk.to_ivk(Scope::Internal)));
            }
            let mut sapling = Vec::new();
            if let Some(dfvk) = ufvk.sapling() {
                sapling.push((Scope::External, SaplingPivk::new(&dfvk.to_ivk(Scope::External))));
                sapling.push((Scope::Internal, SaplingPivk::new(&dfvk.to_ivk(Scope::Internal))));
            }
            let uivk = ufvk.to_unified_incoming_viewing_key();
            return Ok(Keys { kind: "ufvk", uivk, orchard, sapling });
        }
        Err(e) => e,
    };
    let uivk = UnifiedIncomingViewingKey::decode(&NETWORK, s).map_err(|e| key_error(&ufvk_err, &e))?;
    let orchard = uivk.orchard().iter().map(|k| (Scope::External, k.clone())).collect();
    let sapling = uivk.sapling().iter().map(|k| (Scope::External, k.prepare())).collect();
    Ok(Keys { kind: "uivk", uivk, orchard, sapling })
}

/// What a failed key decode says, kept to typed fields because upstream error text can hold key bytes
enum Why {
    UnknownPrefix(String),
    Reason(String),
}

fn why(e: &UnifiedDecodingError) -> Why {
    match e {
        UnifiedDecodingError::Parse(ParseError::UnknownPrefix(hrp)) => Why::UnknownPrefix(hrp.clone()),
        UnifiedDecodingError::NetworkMismatch { actual, .. } => Why::Reason(format!("for the {actual:?} network")),
        UnifiedDecodingError::InvalidItem(tc) => Why::Reason(format!("invalid data for typecode {}", tc.typecode_value())),
        _ => Why::Reason("malformed encoding".into()),
    }
}

/// A decode that fails on the prefix alone is the wrong kind of key, so only the other decode's reason is worth reporting
fn key_error(ufvk: &UnifiedDecodingError, uivk: &UnifiedDecodingError) -> String {
    const FULL: &str = "not a testnet unified full viewing key";
    const INCOMING: &str = "not a testnet unified incoming viewing key";
    match (why(ufvk), why(uivk)) {
        (Why::UnknownPrefix(hrp), Why::UnknownPrefix(_)) => format!("{FULL} and {INCOMING} (prefix {hrp})"),
        (Why::Reason(r), Why::UnknownPrefix(_)) => format!("{FULL} ({r})"),
        (Why::UnknownPrefix(_), Why::Reason(r)) => format!("{INCOMING} ({r})"),
        (Why::Reason(a), Why::Reason(b)) => format!("{FULL} ({a}) and {INCOMING} ({b})"),
    }
}

pub fn encode_uivk(keys: &Keys) -> Result<String, String> {
    keys.uivk.encode(&NETWORK).map_err(|e| format!("{e:?}"))
}

fn scope_name(s: Scope) -> &'static str {
    match s {
        Scope::External => "external",
        Scope::Internal => "internal",
    }
}

fn orchard_recipient(addr: &orchard::Address) -> String {
    UnifiedAddress::from_receivers(Some(*addr), None, None, None, None)
        .map(|ua| ua.encode(&NETWORK))
        .unwrap_or_default()
}

fn sapling_recipient(addr: &sapling::PaymentAddress) -> String {
    Address::from(*addr).encode(&NETWORK)
}

fn note_version_number(v: NoteVersion) -> u8 {
    match v {
        NoteVersion::V2 => 2,
        NoteVersion::V3 => 3,
    }
}

type OrchardBundle = orchard::Bundle<orchard::bundle::Authorized, ZatBalance>;

fn orchard_family(pool: &'static str, bundle: &OrchardBundle, keys: &Keys, out: &mut Vec<Decrypted>) {
    for (scope, ivk) in &keys.orchard {
        for (index, _, note, addr, memo) in bundle.decrypt_outputs_with_keys(std::slice::from_ref(ivk)) {
            out.push(Decrypted {
                pool,
                index,
                scope: *scope,
                value_zat: note.value().inner(),
                memo,
                receiver: addr.to_raw_address_bytes(),
                recipient: orchard_recipient(&addr),
                diversifier_index: ivk.diversifier_index(&addr).map(u128::from),
                note_version: Some(note_version_number(note.version())),
            });
        }
    }
}

/// Every output of `tx` that decrypts with `keys`, judged under the rules in force at `height`
pub fn decrypt(tx: &Transaction, keys: &Keys, height: BlockHeight) -> Vec<Decrypted> {
    let mut out = Vec::new();
    if let Some(bundle) = tx.sapling_bundle() {
        let domain = SaplingDomain::new(zip212_enforcement(&NETWORK, height));
        for (index, output) in bundle.shielded_outputs().iter().enumerate() {
            for (scope, pivk) in &keys.sapling {
                if let Some((note, addr, memo)) = try_note_decryption(&domain, pivk, output) {
                    out.push(Decrypted {
                        pool: "sapling",
                        index,
                        scope: *scope,
                        value_zat: note.value().inner(),
                        memo,
                        receiver: addr.to_bytes(),
                        recipient: sapling_recipient(&addr),
                        diversifier_index: keys
                            .uivk
                            .sapling()
                            .as_ref()
                            .and_then(|k| k.decrypt_diversifier(&addr))
                            .map(u128::from),
                        note_version: None,
                    });
                    break;
                }
            }
        }
    }
    if let Some(bundle) = tx.orchard_bundle() {
        orchard_family("orchard", bundle, keys, &mut out);
    }
    if let Some(bundle) = tx.ironwood_bundle() {
        orchard_family("ironwood", bundle, keys, &mut out);
    }
    out
}

pub fn parse_tx(raw: &[u8], height: BlockHeight) -> Result<Transaction, String> {
    let mut cursor = Cursor::new(raw);
    let tx = Transaction::read(&mut cursor, BranchId::for_height(&NETWORK, height))
        .map_err(|e| format!("transaction does not parse: {e}"))?;
    if cursor.position() as usize != raw.len() {
        return Err(format!(
            "transaction does not parse: {} trailing bytes after the transaction",
            raw.len() - cursor.position() as usize
        ));
    }
    Ok(tx)
}

pub fn memo_json(memo: &[u8; 512]) -> Value {
    let parsed = MemoBytes::from_bytes(memo).ok().and_then(|b| Memo::try_from(&b).ok());
    match parsed {
        Some(Memo::Empty) => json!({ "memoKind": "empty", "memoText": null, "memoHex": null }),
        Some(Memo::Text(t)) => json!({ "memoKind": "text", "memoText": t.to_string(), "memoHex": null }),
        _ => {
            let end = memo.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
            json!({ "memoKind": "binary", "memoText": null, "memoHex": hex::encode(&memo[..end]) })
        }
    }
}

fn orchard_bundle_json(b: Option<&OrchardBundle>) -> Value {
    match b {
        None => Value::Null,
        Some(b) => json!({
            "actions": b.actions().len(),
            "valueBalanceZat": i64::from(*b.value_balance()),
            "spendsEnabled": b.flags().spends_enabled(),
            "outputsEnabled": b.flags().outputs_enabled(),
            "crossAddressEnabled": b.flags().cross_address_enabled(),
        }),
    }
}

/// Which shielded receivers of a payTo UA belong to the key
pub fn pay_to_info(keys: &Keys, ua: &UnifiedAddress) -> Value {
    let orchard = ua.orchard().map(|a| {
        keys.uivk.orchard().as_ref().is_some_and(|k| k.diversifier_index(a).is_some())
    });
    let sapling = ua.sapling().map(|a| {
        keys.uivk.sapling().as_ref().is_some_and(|k| k.decrypt_diversifier(a).is_some())
    });
    json!({
        "hasTransparent": ua.has_transparent(),
        "orchardOwned": orchard,
        "saplingOwned": sapling,
        "ownedByKey": (orchard.is_some() || sapling.is_some()) && orchard.unwrap_or(true) && sapling.unwrap_or(true),
    })
}

pub fn decode_ua(s: &str) -> Result<UnifiedAddress, String> {
    match Address::decode(&NETWORK, s.trim()) {
        Some(Address::Unified(ua)) => Ok(*ua),
        // The input is not echoed because a misplaced key would be printed with it
        _ => Err("not a testnet unified address".into()),
    }
}

fn receiver_matches(d: &Decrypted, ua: &UnifiedAddress) -> bool {
    match d.pool {
        "sapling" => ua.sapling().map(|a| a.to_bytes()) == Some(d.receiver),
        _ => ua.orchard().map(|a| a.to_raw_address_bytes()) == Some(d.receiver),
    }
}

/// What a z402 deposit must carry, the window amount and the exact session memo
pub struct Expect {
    pub memo: String,
    pub min_zat: u64,
}

fn memo_text(memo: &[u8; 512]) -> Option<String> {
    match MemoBytes::from_bytes(memo).ok().and_then(|b| Memo::try_from(&b).ok()) {
        Some(Memo::Text(t)) => Some(t.to_string()),
        _ => None,
    }
}

// Reason codes match Hanko's zpay-verify where they overlap so either checker can back the facilitator
fn verdict(found: &[Decrypted], pay_to: Option<&UnifiedAddress>, transparent: bool, expired: bool, e: &Expect) -> Value {
    let incoming: Vec<&Decrypted> = found.iter().filter(|d| d.scope == Scope::External).collect();
    let memo_ok: Vec<&Decrypted> = incoming.iter().copied().filter(|d| memo_text(&d.memo).as_deref() == Some(e.memo.as_str())).collect();
    let counted: Vec<&Decrypted> = memo_ok.iter().copied().filter(|d| pay_to.is_none_or(|ua| receiver_matches(d, ua))).collect();
    let paid: u64 = counted.iter().map(|d| d.value_zat).sum();
    let mut reasons = Vec::new();
    if incoming.is_empty() {
        reasons.push("NO_OUTPUT_TO_KEY");
    } else if memo_ok.is_empty() {
        reasons.push("MEMO_MISMATCH");
    } else if counted.is_empty() {
        reasons.push("WRONG_RECIPIENT");
    }
    if !incoming.is_empty() && paid < e.min_zat {
        reasons.push("AMOUNT_TOO_LOW");
    }
    if transparent {
        reasons.push("TRANSPARENT_PART");
    }
    if expired {
        reasons.push("EXPIRED");
    }
    json!({ "ok": reasons.is_empty(), "paidZat": paid, "reasons": reasons })
}

/// The full report the CLI prints for one transaction
pub fn inspect(raw: &[u8], keys: &Keys, at: At, pay_to: Option<&UnifiedAddress>) -> Result<Value, String> {
    inspect_expect(raw, keys, at, pay_to, None)
}

pub fn inspect_expect(
    raw: &[u8],
    keys: &Keys,
    at: At,
    pay_to: Option<&UnifiedAddress>,
    expect: Option<&Expect>,
) -> Result<Value, String> {
    let height = at.height();
    let t_parse = Instant::now();
    let tx = parse_tx(raw, height)?;
    let parse_us = t_parse.elapsed().as_micros() as u64;

    let t_decrypt = Instant::now();
    let found = decrypt(&tx, keys, height);
    let decrypt_us = t_decrypt.elapsed().as_micros() as u64;

    let version = tx.version();
    let branch = tx.consensus_branch_id();
    let expiry = u32::from(tx.expiry_height());
    let (t_in, t_out, coinbase) = tx
        .transparent_bundle()
        .map_or((0, 0, false), |b| (b.vin.len(), b.vout.len(), b.is_coinbase()));

    let outputs: Vec<Value> = found
        .iter()
        .map(|d| {
            let mut o = json!({
                "pool": d.pool,
                "index": d.index,
                "scope": scope_name(d.scope),
                "valueZat": d.value_zat,
                "recipient": d.recipient,
                "receiverHex": hex::encode(d.receiver),
                "diversifierIndex": d.diversifier_index.map(|i| i.to_string()),
                "noteVersion": d.note_version,
            });
            let memo = memo_json(&d.memo);
            for (k, v) in memo.as_object().unwrap() {
                o[k] = v.clone();
            }
            if let Some(ua) = pay_to {
                o["toPayTo"] = json!(receiver_matches(d, ua));
            }
            o
        })
        .collect();

    let mut report = json!({
        "txid": tx.txid().to_string(),
        "version": version.header() & 0x7fff_ffff,
        "versionGroupId": format!("0x{:08x}", version.version_group_id()),
        "branchId": format!("0x{:08x}", u32::from(branch)),
        "branch": format!("{branch:?}"),
        "heightUsed": u32::from(height),
        "heightKind": at.kind(),
        "branchMatchesHeight": branch == BranchId::for_height(&NETWORK, height),
        "lockTime": tx.lock_time(),
        "expiryHeight": expiry,
        "expired": expiry != 0 && u32::from(height) > expiry,
        "transparentIn": t_in,
        "transparentOut": t_out,
        "coinbase": coinbase,
        "sapling": tx.sapling_bundle().map(|b| json!({
            "spends": b.shielded_spends().len(),
            "outputs": b.shielded_outputs().len(),
            "valueBalanceZat": i64::from(*b.value_balance()),
        })),
        "orchard": orchard_bundle_json(tx.orchard_bundle()),
        "ironwood": orchard_bundle_json(tx.ironwood_bundle()),
        "keyKind": keys.kind(),
        "outputs": outputs,
        "sizeBytes": raw.len(),
        "parseMicros": parse_us,
        "decryptMicros": decrypt_us,
    });
    if let Some(ua) = pay_to {
        report["payTo"] = pay_to_info(keys, ua);
    }
    if let Some(e) = expect {
        let expired = expiry != 0 && u32::from(height) > expiry;
        report["verdict"] = verdict(&found, pay_to, t_in + t_out > 0, expired, e);
    }
    Ok(report)
}

/// A fresh testnet account from a 32-byte seed, ZIP 32 account 0
pub fn keygen(seed: &[u8; 32]) -> Result<Value, String> {
    use ReceiverRequirement::{Omit, Require};
    let usk = UnifiedSpendingKey::from_seed(&NETWORK, seed, zip32::AccountId::ZERO)
        .map_err(|e| format!("key derivation failed: {e:?}"))?;
    let ufvk = usk.to_unified_full_viewing_key();
    let uivk = ufvk.to_unified_incoming_viewing_key();
    let (ua, ua_index) = ufvk
        .default_address(UnifiedAddressRequest::unsafe_custom(Require, Require, Omit))
        .map_err(|e| format!("{e:?}"))?;
    let (orchard_ua, orchard_index) = ufvk
        .default_address(UnifiedAddressRequest::ORCHARD)
        .map_err(|e| format!("{e:?}"))?;
    Ok(json!({
        "network": "testnet",
        "seedHex": hex::encode(seed),
        "ufvk": ufvk.encode(&NETWORK).map_err(|e| format!("{e:?}"))?,
        "uivk": uivk.encode(&NETWORK).map_err(|e| format!("{e:?}"))?,
        "address": ua.encode(&NETWORK),
        "addressDiversifierIndex": u128::from(ua_index).to_string(),
        "addressReceivers": { "orchard": ua.orchard().is_some(), "sapling": ua.sapling().is_some(), "transparent": ua.has_transparent() },
        "orchardOnlyAddress": orchard_ua.encode(&NETWORK),
        "orchardOnlyDiversifierIndex": u128::from(orchard_index).to_string(),
    }))
}
