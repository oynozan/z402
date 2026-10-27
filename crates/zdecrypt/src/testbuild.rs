//! Builds real v6 test transactions, under NU6.3 or NU7, offline for the positive decryption tests.
//!
//! The funding tx spends a made-up transparent P2PKH coin into an Ironwood note for the agent and a
//! Sapling note for the merchant. The deposit tx is the z402 deposit shape. It spends that Ironwood
//! note, anchored to a synthetic one-leaf commitment tree, and pays the merchant's Orchard receiver
//! in the Ironwood pool with the session memo, with change to the agent's internal address and no
//! transparent part. Halo2 proofs and signatures are real, Sapling proofs are mock bytes, and the
//! chain would reject both txs because the coin and the anchor are made up.

use std::collections::HashMap;
use std::str::FromStr;
use std::time::Instant;

use incrementalmerkletree::{Hashable, Level};
use orchard::keys::{FullViewingKey, Scope, SpendAuthorizingKey};
use orchard::tree::{MerkleHashOrchard, MerklePath};
use serde_json::{json, Value};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_primitives::transaction::builder::{BuildConfig, Builder, BundlePadding};
use zcash_primitives::transaction::fees::zip317;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId};
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zcash_transparent::address::TransparentAddress;
use zcash_transparent::builder::TransparentSigningSet;
use zcash_transparent::bundle::{OutPoint, TxOut};

use crate::{decode_ua, keygen, Net};

fn config(ironwood_anchor: orchard::Anchor, with_sapling: bool) -> BuildConfig {
    BuildConfig::Standard {
        sapling_anchor: with_sapling.then(sapling::Anchor::empty_tree),
        orchard_anchor: None,
        ironwood_anchor: Some(ironwood_anchor),
        orchard_padding: BundlePadding::DEFAULT,
        ironwood_padding: BundlePadding::DEFAULT,
    }
}

fn zat(v: u64) -> Result<Zatoshis, String> {
    Zatoshis::from_u64(v).map_err(|_| format!("{v} is not a valid zatoshi amount"))
}

fn text_memo(s: &str) -> Result<MemoBytes, String> {
    Memo::from_str(s).map(MemoBytes::from).map_err(|e| format!("bad memo: {e:?}"))
}

fn serialize(tx: &Transaction) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    tx.write(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub fn run(flags: &HashMap<String, String>, net: Net) -> Result<Value, String> {
    let merchant = decode_ua(flags.get("--merchant-address").ok_or("--merchant-address is required")?, net)?;
    let merchant_orchard = *merchant.orchard().ok_or("merchant address has no Orchard receiver")?;
    let value: u64 = flags.get("--value").map_or(Ok(100_000), |v| v.parse()).map_err(|_| "--value must be zatoshi")?;
    let memo = flags.get("--memo").cloned().unwrap_or_else(|| format!("{}:0", "ab".repeat(32)));
    let target = match (flags.get("--height"), net) {
        (Some(v), _) => v.parse().map_err(|_| "--height must be a block height")?,
        // Only testnet keeps a default height, the others have to say which epoch they mean
        (None, Net::Testnet) => 4_547_300,
        (None, _) => return Err(format!("--height is required on {}", net.name())),
    };
    let target = BlockHeight::from_u32(target);
    let branch = BranchId::for_height(&net, target);
    // Ironwood outputs exist from NU6.3 on, and regtest never activates NU7
    if !matches!(branch, BranchId::Nu6_3 | BranchId::Nu7) {
        return Err(format!("height {target} is not under NU6.3 or NU7 on {}", net.name()));
    }

    let mut seed = [0u8; 32];
    match flags.get("--agent-seed-hex") {
        Some(h) => seed = hex::decode(h).ok().and_then(|b| b.try_into().ok()).ok_or("--agent-seed-hex must be 32 bytes of hex")?,
        None => getrandom::fill(&mut seed).map_err(|e| e.to_string())?,
    }
    let usk = UnifiedSpendingKey::from_seed(&net, &seed, zip32::AccountId::ZERO).map_err(|e| format!("{e:?}"))?;
    let agent_fvk = FullViewingKey::from(usk.orchard());
    let agent_ovk = agent_fvk.to_ovk(Scope::External);
    let agent_addr = agent_fvk.address_at(0u32, Scope::External);
    let agent_change = agent_fvk.address_at(0u32, Scope::Internal);
    let rule = zip317::FeeRule::standard();
    let mock_spend = sapling::prover::mock::MockSpendProver;
    let mock_output = sapling::prover::mock::MockOutputProver;

    /* Funding tx */
    let sk = secp256k1::SecretKey::from_secret_bytes([0x42; 32]).map_err(|e| e.to_string())?;
    let pk = sk.public_key();
    let funded = value + 50_000;
    let sapling_check = 20_000;
    let make_funding = |input: u64| -> Result<_, String> {
        let mut b = Builder::new(net, target, config(orchard::Anchor::empty_tree(), merchant.sapling().is_some()));
        let coin = TxOut::new(zat(input)?, TransparentAddress::from_pubkey(&pk).script().into());
        b.add_transparent_p2pkh_input(pk, OutPoint::new([7u8; 32], 0), coin).map_err(|e| format!("{e:?}"))?;
        b.add_ironwood_output::<zip317::FeeError>(Some(agent_ovk.clone()), agent_addr, zat(funded)?, MemoBytes::empty())
            .map_err(|e| format!("{e:?}"))?;
        if let Some(s) = merchant.sapling() {
            b.add_sapling_output::<zip317::FeeError>(None, *s, zat(sapling_check)?, text_memo("z402 sapling check")?)
                .map_err(|e| format!("{e:?}"))?;
        }
        Ok(b)
    };
    let sapling_paid = if merchant.sapling().is_some() { sapling_check } else { 0 };
    let fee1 = u64::from(make_funding(funded + sapling_paid)?.get_fee(&rule).map_err(|e| format!("{e:?}"))?);
    let mut signing = TransparentSigningSet::new();
    signing.add_key(sk);
    let t = Instant::now();
    let built1 = make_funding(funded + sapling_paid + fee1)?
        .build(&signing, &[], &[], rand::rand_core::UnwrapErr(rand::rngs::SysRng), &mock_spend, &mock_output, &rule)
        .map_err(|e| format!("build funding tx: {e:?}"))?;
    let funding_ms = t.elapsed().as_millis() as u64;
    let funding_bytes = serialize(built1.transaction())?;
    let funding = Transaction::read(&funding_bytes[..], branch).map_err(|e| e.to_string())?;

    /* Deposit tx */
    let ivk = agent_fvk.to_ivk(Scope::External);
    let note = funding
        .ironwood_bundle()
        .ok_or("funding tx has no Ironwood bundle")?
        .decrypt_outputs_with_keys(&[ivk])
        .into_iter()
        .map(|(_, _, n, _, _)| n)
        .next()
        .ok_or("agent cannot find its Ironwood note in the funding tx")?;
    let cmx: orchard::note::ExtractedNoteCommitment = note.commitment().into();
    let path = MerklePath::from_parts(0, std::array::from_fn(|i| MerkleHashOrchard::empty_root(Level::from(i as u8))));
    let anchor = path.root(cmx);
    let make_deposit = |change: u64| -> Result<_, String> {
        let mut b = Builder::new(net, target, config(anchor, false));
        b.add_ironwood_spend::<zip317::FeeError>(agent_fvk.clone(), note, path.clone()).map_err(|e| format!("{e:?}"))?;
        b.add_ironwood_output::<zip317::FeeError>(Some(agent_ovk.clone()), merchant_orchard, zat(value)?, text_memo(&memo)?)
            .map_err(|e| format!("{e:?}"))?;
        b.add_ironwood_output::<zip317::FeeError>(Some(agent_ovk.clone()), agent_change, zat(change)?, MemoBytes::empty())
            .map_err(|e| format!("{e:?}"))?;
        Ok(b)
    };
    let fee2 = u64::from(make_deposit(1)?.get_fee(&rule).map_err(|e| format!("{e:?}"))?);
    let change = funded.checked_sub(value + fee2).ok_or("funding too small for value + fee")?;
    let saks = [SpendAuthorizingKey::from(usk.orchard())];
    let t = Instant::now();
    let built2 = make_deposit(change)?
        .build(&TransparentSigningSet::new(), &[], &saks, rand::rand_core::UnwrapErr(rand::rngs::SysRng), &mock_spend, &mock_output, &rule)
        .map_err(|e| format!("build deposit tx: {e:?}"))?;
    let deposit_ms = t.elapsed().as_millis() as u64;
    let deposit_bytes = serialize(built2.transaction())?;

    let agent = keygen(&seed, net)?;
    Ok(json!({
        "targetHeight": u32::from(target),
        "agent": { "seedHex": agent["seedHex"], "ufvk": agent["ufvk"], "uivk": agent["uivk"], "address": agent["address"] },
        "merchantAddress": flags.get("--merchant-address"),
        "fundingTx": {
            "txid": built1.transaction().txid().to_string(),
            "hex": hex::encode(&funding_bytes),
            "feeZat": fee1,
            "ironwoodToAgentZat": funded,
            "saplingToMerchantZat": sapling_paid,
            "buildMillis": funding_ms,
        },
        "depositTx": {
            "txid": built2.transaction().txid().to_string(),
            "hex": hex::encode(&deposit_bytes),
            "feeZat": fee2,
            "valueZat": value,
            "memo": memo,
            "changeZat": change,
            "anchorHex": hex::encode(anchor.to_bytes()),
            "buildMillis": deposit_ms,
        },
    }))
}
