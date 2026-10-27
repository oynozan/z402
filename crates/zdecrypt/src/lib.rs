// zdecrypt follows the decrypt-loop shape of Kage crates/x402z-facilitator/src/verify.rs
// (github.com/nickthelegend/zec-shielded-x402 @ 0330760, MIT) and Hanko packages/core/src/lib.rs
// (github.com/nickthelegend/zec-payment-verify-sdk @ 3c7edae, MIT). See NOTICE.md.

//! Parse a Zcash transaction and trial-decrypt its shielded outputs with a viewing key, on regtest,
//! testnet or mainnet.
//!
//! The facilitator path is `decode_key` once at startup, then `inspect` once per deposit. `inspect`
//! parses the raw bytes under the consensus branch for the given height, rejects trailing bytes,
//! counts the transparent part, and trial-decrypts every Sapling output and every Orchard and
//! Ironwood action. Ironwood is the Orchard-family pool added in NU6.3 that carries new shielded
//! payments. Its notes go to the UA's Orchard receiver and decrypt with the same Orchard incoming
//! viewing key, but under the V3 note plaintext rules. A UIVK yields external-scope keys only. A
//! UFVK adds internal-scope keys, which see a wallet's own change. Nothing here talks to a node.
//! `Net` names which Zcash network a key, an address or a transaction belongs to. `Keys` remembers
//! the one it was decoded for, so `inspect` judges a transaction under the same prefixes and
//! activation heights that accepted the key.

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
use zcash_address::{ConversionError, ZcashAddress};
use zcash_keys::address::{Address, UnifiedAddress};
use zcash_keys::encoding::UnifiedDecodingError;
use zcash_keys::keys::{
    ReceiverRequirement, UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedIncomingViewingKey,
    UnifiedSpendingKey,
};
use zcash_note_encryption::try_note_decryption;
use zcash_primitives::transaction::components::sapling::zip212_enforcement;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network, NetworkType, NetworkUpgrade, Parameters};
use zcash_protocol::local_consensus::LocalNetwork;
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::ZatBalance;
use zip32::Scope;

const fn since(h: u32) -> Option<BlockHeight> {
    Some(BlockHeight::from_u32(h))
}

/// Heights from the Z3 stack's Zebra regtest config, where NU7 never activates
const REGTEST: LocalNetwork = LocalNetwork {
    overwinter: since(1),
    sapling: since(1),
    blossom: since(1),
    heartwood: since(1),
    canopy: since(1),
    nu5: since(2),
    nu6: since(2),
    nu6_1: since(2),
    nu6_2: since(2),
    nu6_3: since(2),
    nu7: None,
};

/// The Zcash network a key, an address or a transaction belongs to
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Net {
    Regtest,
    Testnet,
    Mainnet,
}

impl Net {
    pub fn name(self) -> &'static str {
        match self {
            Net::Regtest => "regtest",
            Net::Testnet => "testnet",
            Net::Mainnet => "mainnet",
        }
    }
}

impl std::str::FromStr for Net {
    type Err = &'static str;

    fn from_str(s: &str) -> Result<Net, Self::Err> {
        [Net::Regtest, Net::Testnet, Net::Mainnet]
            .into_iter()
            .find(|n| n.name() == s.trim())
            .ok_or("must be regtest, testnet or mainnet")
    }
}

impl Parameters for Net {
    fn network_type(&self) -> NetworkType {
        match self {
            Net::Regtest => REGTEST.network_type(),
            Net::Testnet => Network::TestNetwork.network_type(),
            Net::Mainnet => Network::MainNetwork.network_type(),
        }
    }

    fn activation_height(&self, nu: NetworkUpgrade) -> Option<BlockHeight> {
        match self {
            Net::Regtest => REGTEST.activation_height(nu),
            Net::Testnet => Network::TestNetwork.activation_height(nu),
            Net::Mainnet => Network::MainNetwork.activation_height(nu),
        }
    }
}

pub struct Keys {
    net: Net,
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

    /// The network `decode_key` accepted the key for
    pub fn network(&self) -> Net {
        self.net
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

/// Tries a UFVK decode, then a UIVK decode, never a prefix test, since revision 2 keys use other prefixes
pub fn decode_key(s: &str, net: Net) -> Result<Keys, String> {
    let s = s.trim();
    let ufvk_err = match UnifiedFullViewingKey::decode(&net, s) {
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
            return Ok(Keys { net, kind: "ufvk", uivk, orchard, sapling });
        }
        Err(e) => e,
    };
    let uivk = UnifiedIncomingViewingKey::decode(&net, s).map_err(|e| key_error(net, &ufvk_err, &e))?;
    let orchard = uivk.orchard().iter().map(|k| (Scope::External, k.clone())).collect();
    let sapling = uivk.sapling().iter().map(|k| (Scope::External, k.prepare())).collect();
    Ok(Keys { net, kind: "uivk", uivk, orchard, sapling })
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
fn key_error(net: Net, ufvk: &UnifiedDecodingError, uivk: &UnifiedDecodingError) -> String {
    let full = format!("not a {} unified full viewing key", net.name());
    let incoming = format!("not a {} unified incoming viewing key", net.name());
    match (why(ufvk), why(uivk)) {
        (Why::UnknownPrefix(hrp), Why::UnknownPrefix(_)) => format!("{full} and {incoming} (prefix {hrp})"),
        (Why::Reason(r), Why::UnknownPrefix(_)) => format!("{full} ({r})"),
        (Why::UnknownPrefix(_), Why::Reason(r)) => format!("{incoming} ({r})"),
        (Why::Reason(a), Why::Reason(b)) => format!("{full} ({a}) and {incoming} ({b})"),
    }
}

pub fn encode_uivk(keys: &Keys) -> Result<String, String> {
    keys.uivk.encode(&keys.net).map_err(|e| format!("{e:?}"))
}

fn scope_name(s: Scope) -> &'static str {
    match s {
        Scope::External => "external",
        Scope::Internal => "internal",
    }
}

fn orchard_recipient(addr: &orchard::Address, net: Net) -> String {
    UnifiedAddress::from_receivers(Some(*addr), None, None, None, None)
        .map(|ua| ua.encode(&net))
        .unwrap_or_default()
}

fn sapling_recipient(addr: &sapling::PaymentAddress, net: Net) -> String {
    Address::from(*addr).encode(&net)
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
                recipient: orchard_recipient(&addr, keys.net),
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
        let domain = SaplingDomain::new(zip212_enforcement(&keys.net, height));
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
                        recipient: sapling_recipient(&addr, keys.net),
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

/// `net` and `height` pick the consensus branch a pre-v5 tx is read under, a v5 or v6 tx carries its own
pub fn parse_tx(raw: &[u8], height: BlockHeight, net: Net) -> Result<Transaction, String> {
    let mut cursor = Cursor::new(raw);
    let tx = Transaction::read(&mut cursor, BranchId::for_height(&net, height))
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

pub fn decode_ua(s: &str, net: Net) -> Result<UnifiedAddress, String> {
    let wrong = format!("not a {} unified address", net.name());
    // The input is not echoed because a misplaced key would be printed with it
    match s.parse::<ZcashAddress>().map(|z| Address::try_from_zcash_address(&net, z)) {
        Ok(Ok(Address::Unified(ua))) => Ok(*ua),
        Ok(Err(ConversionError::IncorrectNetwork { actual, .. })) => Err(format!("{wrong} (for the {actual:?} network)")),
        _ => Err(wrong),
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
    let tx = parse_tx(raw, height, keys.net)?;
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
        "branchMatchesHeight": branch == BranchId::for_height(&keys.net, height),
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

/// A fresh account on `net` from a 32-byte seed, ZIP 32 account 0
pub fn keygen(seed: &[u8; 32], net: Net) -> Result<Value, String> {
    use ReceiverRequirement::{Omit, Require};
    let usk = UnifiedSpendingKey::from_seed(&net, seed, zip32::AccountId::ZERO)
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
        "network": net.name(),
        "seedHex": hex::encode(seed),
        "ufvk": ufvk.encode(&net).map_err(|e| format!("{e:?}"))?,
        "uivk": uivk.encode(&net).map_err(|e| format!("{e:?}"))?,
        "address": ua.encode(&net),
        "addressDiversifierIndex": u128::from(ua_index).to_string(),
        "addressReceivers": { "orchard": ua.orchard().is_some(), "sapling": ua.sapling().is_some(), "transparent": ua.has_transparent() },
        "orchardOnlyAddress": orchard_ua.encode(&net),
        "orchardOnlyDiversifierIndex": u128::from(orchard_index).to_string(),
    }))
}
