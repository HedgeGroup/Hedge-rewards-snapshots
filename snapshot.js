 const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL ? process.env.RPC_URL.trim() : null;
const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const IS_TEST = process.env.IS_TEST === 'true';

const TOKEN_MINT = new PublicKey(Buffer.from([51, 169, 33, 215, 179, 38, 191, 95, 188, 103, 179, 111, 219, 206, 35, 36, 202, 149, 116, 214, 64, 250, 231, 245, 58, 71, 152, 147, 213, 154, 114, 173]));

if (!RPC_URL || !PAYER_SECRET_KEY) {
  console.error("[CRITICAL ERROR] Missing RPC_URL or PAYER_SECRET_KEY in GitHub Secrets!");
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');
let payer;

try {
  let cleanedKey = PAYER_SECRET_KEY.replace(/[\r\n\t"']/g, '').trim();
  const wordCount = cleanedKey.split(/\s+/).length;

  if (wordCount >= 12 && wordCount <= 24) {
    if (!bip39.validateMnemonic(cleanedKey)) {
      console.error("[CRITICAL ERROR] The 12-word phrase entered is invalid.");
      process.exit(1);
    }
    const seed = bip39.mnemonicToSeedSync(cleanedKey);
    const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    payer = Keypair.fromSeed(derivedSeed);
  } else {
    let secretKey;
    if (cleanedKey.startsWith('[') || cleanedKey.includes(',')) {
      const jsonNumbers = cleanedKey.replace(/[^0-9,]/g, '');
      secretKey = Uint8Array.from(jsonNumbers.split(',').map(Number));
    } else if (/^[0-9a-fA-F]+$/.test(cleanedKey)) {
      secretKey = Uint8Array.from(Buffer.from(cleanedKey, 'hex'));
    } else {
      secretKey = bs58.decode(cleanedKey.replace(/[^a-zA-Z0-9]/g, ''));
    }
    payer = Keypair.fromSecretKey(secretKey);
  }
} catch (e) {
  console.error("[CRITICAL ERROR] Wallet authorization failed.");
  process.exit(1);
}

console.log(`[INFO] Wallet successfully unlocked. Public address: ${payer.publicKey.toBase58()}`);

function getLondonHour() {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "Europe/London", hour: "2-digit", hour12: false }), 10);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllHoldersHelius(mint) {
  const url = RPC_URL;
  let page = 1;
  let allHolders = [];
  
  while (true) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'helius-get-token-accounts',
          method: 'getTokenAccounts',
          params: {
            mint: mint.toBase58(),
            page: page,
            limit: 1000,
            options: { showZeroBalance: false }
          },
        }),
      });
      
      const data = await response.json();
      if (!data.result || data.result.token_accounts.length === 0) {
        break;
      }
      
      allHolders = allHolders.concat(data.result.token_accounts);
      page++;
      await sleep(100);
    } catch (err) {
      break;
    }
  }
  return allHolders;
}

async function run() {
  if (!IS_TEST) {
    const randomDelay = Math.floor(Math.random() * 7200000);
    await sleep(randomDelay);
  }

  console.log("[INFO] Scanning for holders using Helius Asset API...");
  let rawAccounts = [];
  try {
    rawAccounts = await fetchAllHoldersHelius(TOKEN_MINT);
  } catch (err) {
    console.log("[FALLBACK] API failed, trying basic node fallback...");
    try {
      const response = await connection.getTokenLargestAccounts(TOKEN_MINT);
      rawAccounts = response.value.map(a => ({ owner: a.address.toString(), amount: a.amount }));
    } catch (e) {
      process.exit(1);
    }
  }

  const snapshot = [];
  const excludedAcks = [
    payer.publicKey.toBase58(),
    '5Q544fKrABSRSR6gctgWUb9H68sS5VbS5S5VbS5S5VbS' // Common Burn/Pool filter
  ];

  for (const acc of rawAccounts) {
    const owner = acc.owner || acc.address;
    const amountStr = acc.amount || (acc.tokenAmount ? acc.tokenAmount.amount : '0');
    const amount = BigInt(amountStr);

    if (amount > 0n && owner && !excludedAcks.includes(owner)) {
      snapshot.push({
        owner: new PublicKey(owner),
        reward: (amount * 3n) / 100n
      });
    }
  }
  
  console.log(`[SUCCESS] Found ${snapshot.length} active token holders.`);

  if (!IS_TEST) {
    while (getLondonHour() < 20) {
      await sleep(60000);
    }
  }

  let payerAta;
  try {
    payerAta = await getAssociatedTokenAddress(TOKEN_MINT, payer.publicKey);
  } catch (err) {
    console.error("[CRITICAL ERROR] Payer wallet does not have a HEDGE token account setup.");
    process.exit(1);
  }

  for (const holder of snapshot) {
    if (holder.reward === 0n) continue;
    try {
      const holderAta = await getAssociatedTokenAddress(TOKEN_MINT, holder.owner);
      const transaction = new Transaction();
      
      const info = await connection.getAccountInfo(holderAta);
      if (info === null) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            holderAta,
            holder.owner,
            TOKEN_MINT
          )
        );
      }

      transaction.add(
        createTransferCheckedInstruction(
          payerAta,
          TOKEN_MINT,
          holderAta,
          payer.publicKey,
          holder.reward,
          9
        )
      );
      
      const txid = await connection.sendTransaction(transaction, [payer], { skipPreflight: true, commitment: 'confirmed' });
      console.log(`[PAYOUT] Success to ${holder.owner.toBase58()}. Tx: ${txid}`);
      await sleep(300);
    } catch (txErr) {
      await sleep(300);
      continue;
    }
  }
  console.log("[SUCCESS] Process complete.");
  process.exit(0);
}

run();
     
