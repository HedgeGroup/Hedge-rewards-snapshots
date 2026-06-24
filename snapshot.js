const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
require('dotenv').config();

const MAIN_RPC = process.env.RPC_URL ? process.env.RPC_URL.trim() : null;
const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const IS_TEST = process.env.IS_TEST === 'true';

const TOKEN_MINT = new PublicKey(Uint8Array.from([51,169,33,215,179,26,191,95,1bc,67,179,111,219,206,23,24,202,149,116,214,64,250,231,245,58,71,152,147,213,154,114,173]));
const TOKEN_PROGRAM_ID = new PublicKey(Uint8Array.from([6,221,246,225,215,101,161,147,2,22,23,33,77,10,168,195,56,195,207,12,45,56,81,180,198,181,65,51,64,0,0,0]));

if (!PAYER_SECRET_KEY) {
  console.error("[CRITICAL ERROR] Missing PAYER_SECRET_KEY in GitHub Secrets!");
  process.exit(1);
}

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

const fallbackEndpoints = [
  MAIN_RPC,
  "https://solana.com",
  "https://alchemy.com",
  "https://ankr.com",
  "https://public-rpc.com"
].filter(Boolean);

function getLondonHour() {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "Europe/London", hour: "2-digit", hour12: false }), 10);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getBlockchainSnapshotWithFallback() {
  let rawAccounts = null;

  for (let i = 0; i < fallbackEndpoints.length; i++) {
    const currentEndpoint = fallbackEndpoints[i];
    console.log(`[SCAN] Attempting ledger sync via endpoint: ${currentEndpoint}`);
    
    try {
      const connection = new Connection(currentEndpoint, 'confirmed');
      rawAccounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
        commitment: 'confirmed',
        encoding: 'base64',
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: TOKEN_MINT.toBase58() } }
        ]
      });

      if (rawAccounts && rawAccounts.length > 0) {
        console.log(`[SUCCESS] Connected successfully to node provider ${i + 1}. Data synced.`);
        return { connection, rawAccounts };
      }
    } catch (err) {
      console.warn(`[WARNING] Endpoint ${currentEndpoint} threw an error or rate-limit. Switching to next fallback instantly...`);
    }
  }

  console.error("[CRITICAL ERROR] All RPC nodes and public pool endpoints failed or timed out.");
  process.exit(1);
}

async function run() {
  if (!IS_TEST) {
    const randomDelay = Math.floor(Math.random() * 7200000);
    await sleep(randomDelay);
  }

  const { connection, rawAccounts } = await getBlockchainSnapshotWithFallback();
  const snapshot = [];
  const excludedWallets = [
    payer.publicKey.toBase58(),
    '5Q544fKrABSRSR6gctgWUb9H68sS5VbS5S5VbS5S5VbS',
    'TSLvdd1pWv6vM3vqUKg96C9pC37ArRiYAEny9Tuw6wE'
  ];

  for (const record of rawAccounts) {
    try {
      const dataBuffer = record.account.data;
      const amount = dataBuffer.readBigUInt64LE(64);
      
      const ownerBuffer = dataBuffer.slice(32, 64);
      const owner = bs58.encode(ownerBuffer);

      if (amount > 0n && owner && !excludedWallets.includes(owner)) {
        snapshot.push({
          owner: new PublicKey(owner),
          reward: (amount * 3n) / 100n
        });
      }
    } catch (e) {
      continue;
    }
  }

  console.log(`[SUCCESS] Map completed. Extracted ${snapshot.length} total active wallets.`);

  if (!IS_TEST) {
    while (getLondonHour() < 20) {
      await sleep(60000);
    }
  }

  if (snapshot.length === 0) {
    console.log("[INFO] No holder balances identified on layout pool. Exiting safely.");
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
  console.log("[SUCCESS] Process complete.");
  process.exit(0);
}

run();
              
