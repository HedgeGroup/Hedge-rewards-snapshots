  const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL ? process.env.RPC_URL.trim() : null;
const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const IS_TEST = process.env.IS_TEST === 'true';

const TOKEN_MINT = new PublicKey(Buffer.from('33a921d7b326bf5fbc67b36fdbce2324ca9574d640fae7f53a479893d59a72ad', 'hex'));
const TOKEN_PROGRAM_ID = new PublicKey(Buffer.from('06ddf6e1d765a193022223334d0aa8c338c3cf0c2d3851b4c6b5413340000000', 'hex'));

if (!RPC_URL) {
  console.error("[CRITICAL ERROR] RPC_URL is empty inside your GitHub Secrets!");
  process.exit(1);
}

if (!PAYER_SECRET_KEY) {
  console.error("[CRITICAL ERROR] PAYER_SECRET_KEY is empty inside your GitHub Secrets!");
  process.exit(1);
}

const cleanedBase58 = PAYER_SECRET_KEY.replace(/[^a-zA-Z0-9]/g, '').trim();
let secretKey;
try {
  secretKey = bs58.decode(cleanedBase58);
} catch (e) {
  console.error("[CRITICAL ERROR] Failed to decode Base58 key from GitHub Secrets.");
  process.exit(1);
}

if (secretKey.length !== 64) {
  console.error(`[CRITICAL ERROR] Decoded key length is invalid! Got ${secretKey.length} bytes, expected exactly 64.`);
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');
const payer = Keypair.fromSecretKey(secretKey);

function getLondonHour() {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "Europe/London", hour: "2-digit", hour12: false }), 10);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  if (!IS_TEST) {
    const randomDelay = Math.floor(Math.random() * 7200000);
    await sleep(randomDelay);
  }

  console.log("[INFO] Connection established. Scanning for holders...");
  let accounts;
  try {
    const parsedAccounts = await connection.getParsedProgramAccounts(
      TOKEN_PROGRAM_ID,
      {
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: TOKEN_MINT.toBase58() } }
        ]
      }
    );
    accounts = parsedAccounts;
  } catch (err) {
    console.error("[CRITICAL ERROR] Your RPC_URL connection failed:", err.message);
    process.exit(1);
  }

  const snapshot = [];
  for (const acc of accounts) {
    const data = acc.account.data.parsed.info;
    const amount = BigInt(data.tokenAmount.amount);
    const owner = data.owner;

    if (amount > 0n && owner !== payer.publicKey.toBase58()) {
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
    console.error("[CRITICAL ERROR] Could not resolve associated token account for your payer wallet.");
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

        
