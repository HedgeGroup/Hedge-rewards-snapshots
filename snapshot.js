  const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const bip39 = require('bip39');
const fs = require('fs');
const path = require('path');
const { derivePath } = require('ed25519-hd-key');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL ? process.env.RPC_URL.trim() : null;
const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const IS_TEST = process.env.IS_TEST === 'true';

const TOKEN_MINT = new PublicKey(Uint8Array.from([51,169,33,215,179,26,191,95,188,67,179,111,219,206,23,24,202,149,116,214,64,250,231,245,58,71,152,147,213,154,114,173]));

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

async function run() {
  console.log("[INFO] Reading local holder spreadsheet data...");
  const csvPath = path.join(__dirname, 'holders.csv');
  
  if (!fs.existsSync(csvPath)) {
    console.error("[CRITICAL ERROR] holders.csv file not found! Please upload a valid holder list.");
    process.exit(1);
  }

  const fileContent = fs.readFileSync(csvPath, 'utf-8');
  const lines = fileContent.split(/\r?\n/);
  const snapshot = [];

  const excludedWallets = [
    payer.publicKey.toBase58(),
    '5Q544fKrABSRSR6gctgWUb9H68sS5VbS5S5VbS5S5VbS',
    'TSLvdd1pWv6vM3vqUKg96C9pC37ArRiYAEny9Tuw6wE'
  ];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;

    const owner = parts[0].trim();
    const amountStr = parts[1].trim();
    
    if (owner && amountStr && !excludedWallets.includes(owner)) {
      try {
        const amount = BigInt(amountStr);
        if (amount > 0n) {
          snapshot.push({
            owner: new PublicKey(owner),
            reward: (amount * 3n) / 100n
          });
        }
      } catch (e) {
        continue;
      }
    }
  }

  console.log(`[SUCCESS] Loaded exactly ${snapshot.length} valid HEDGE holder wallets from spreadsheet.`);

  if (!IS_TEST) {
    while (getLondonHour() < 20) {
      await sleep(60000);
    }
  }

  if (snapshot.length === 0) {
    console.log("[INFO] No external wallets loaded. Exiting payout run safely.");
    process.exit(0);
  }

  let payerAta;
  try {
    payerAta = await getAssociatedTokenAddress(TOKEN_MINT, payer.publicKey);
  } catch (err) {
    console.error("[CRITICAL ERROR] Payer wallet does not have a HEDGE token account setup.");
    process.exit(1);
  }

  console.log("[INFO] Initiating automatic reward distribution transactions...");
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
      console.log(`[PAYOUT SUCCESS] Sent 3% reward to ${holder.owner.toBase58()}. Tx: ${txid}`);
      await sleep(400);
    } catch (txErr) {
      await sleep(400);
      continue;
    }
  }
  console.log("[SUCCESS] All distributions processed successfully.");
  process.exit(0);
}

run();
      
