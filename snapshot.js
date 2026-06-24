const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL ? process.env.RPC_URL.trim() : null;
let PAYER_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const IS_TEST = process.env.IS_TEST === 'true';

const TOKEN_MINT = new PublicKey(new Uint8Array([54,166,134,228,88,86,165,110,31,236,104,185,14,142,40,78,169,219,84,183,16,108,187,143,184,87,31,88,32,159,165,58]));
const TOKEN_PROGRAM_ID = new PublicKey(new Uint8Array([6,221,246,225,215,101,161,147,217,203,225,70,206,235,121,172,28,180,133,237,95,91,55,145,58,140,245,133,126,255,0,169]));

if (!RPC_URL) {
  console.error("[CRITICAL ERROR] RPC_URL is empty inside your GitHub Secrets!");
  process.exit(1);
}

if (!PAYER_KEY) {
  console.error("[CRITICAL ERROR] PAYER_SECRET_KEY is empty inside your GitHub Secrets!");
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');

let secretKey = null;
try {
  let cleaned = PAYER_KEY.replace(/[\r\n\t]/g, '').trim();
  if (cleaned.startsWith('"') || cleaned.startsWith("'")) cleaned = cleaned.slice(1);
  if (cleaned.endsWith('"') || cleaned.endsWith("'")) cleaned = cleaned.slice(0, -1);
  cleaned = cleaned.trim();

  if (cleaned.includes(',') || cleaned.startsWith('[') || cleaned.endsWith(']')) {
    if (!cleaned.startsWith('[')) cleaned = '[' + cleaned;
    if (!cleaned.endsWith(']')) cleaned = cleaned + ']';
    const jsonNumbers = cleaned.replace(/[^0-9,]/g, '');
    secretKey = Uint8Array.from(jsonNumbers.split(',').map(Number));
  } else {
    const pureBase58 = cleaned.replace(/[^a-zA-Z0-9]/g, '');
    secretKey = bs58.decode(pureBase58);
  }
} catch (e) {
  secretKey = null;
}

if (!secretKey || secretKey.length !== 64) {
  console.error("[CRITICAL ERROR] Your PAYER_SECRET_KEY text inside GitHub Secrets is broken or missing characters!");
  process.exit(1);
}

let payer;
try {
  payer = Keypair.fromSecretKey(secretKey);
} catch (e) {
  console.error("[CRITICAL ERROR] Keypair generation failed. Your secret key is not a valid Solana wallet key!");
  process.exit(1);
}

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
    console.error("[CRITICAL ERROR] Your RPC_URL connection failed or hit an aggressive rate limit:", err.message);
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
        
