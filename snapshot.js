const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL ? process.env.RPC_URL.trim() : null;
let PAYER_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const IS_TEST = process.env.IS_TEST === 'true';

const TOKEN_MINT = new PublicKey('4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNw56KuPNas3ndOaahv8KW3Rw5C9m');

if (PAYER_KEY) {
  PAYER_KEY = PAYER_KEY.replace(/[\r\n]/g, '').trim();
  if (PAYER_KEY.startsWith('"') || PAYER_KEY.startsWith("'")) PAYER_KEY = PAYER_KEY.slice(1);
  if (PAYER_KEY.endsWith('"') || PAYER_KEY.endsWith("'")) PAYER_KEY = PAYER_KEY.slice(0, -1);
  PAYER_KEY = PAYER_KEY.trim();
}

if (!RPC_URL || !PAYER_KEY) {
  console.error("[ERROR] Missing RPC_URL or PAYER_SECRET_KEY in GitHub Secrets!");
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');

let secretKey;
try {
  if (PAYER_KEY.startsWith('[')) {
    const cleanedJson = PAYER_KEY.replace(/[^0-9,\[\]]/g, '');
    secretKey = Uint8Array.from(JSON.parse(cleanedJson));
  } else {
    const cleanedBase58 = PAYER_KEY.replace(/[^a-zA-Z0-9]/g, '');
    secretKey = bs58.decode(cleanedBase58);
  }
} catch (e) {
  console.error("[ERROR] Invalid PAYER_SECRET_KEY format. Verification failed.");
  process.exit(1);
}
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
    console.log(`[INFO] Waiting for scheduled Saturday execution. Delaying for ${(randomDelay/1000/60).toFixed(2)} minutes.`);
    await sleep(randomDelay);
  }

  console.log("[INFO] Scanning blockchain for all token holders...");
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
    console.error("[ERROR] Free RPC node rate limit hit or request failed:", err.message);
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
  console.log(`[SUCCESS] Captured ${snapshot.length} total holder accounts.`);

  if (!IS_TEST) {
    console.log("[INFO] Waiting until exactly 20:00 London time for payout...");
    while (getLondonHour() < 20) {
      await sleep(60000);
    }
  }

  let payerAta;
  try {
    payerAta = await getAssociatedTokenAddress(TOKEN_MINT, payer.publicKey);
  } catch (err) {
    console.error("[ERROR] Your distribution wallet does not have a HEDGE token account setup.");
    process.exit(1);
  }

  console.log("[INFO] Starting automatic payout distributions...");
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
      
      const sig = await connection.sendTransaction(transaction, [payer], { skipPreflight: true, commitment: 'confirmed' });
      console.log(`[PAYOUT SUCCESS] Sent reward to ${holder.owner.toBase58()}. Tx: ${sig}`);
      await sleep(300);
    } catch (txErr) {
      console.error(`[PAYOUT FAILED] Distribution failed for wallet ${holder.owner.toBase58()}:`, txErr.message);
      await sleep(300);
      continue;
    }
  }
  console.log("[SUCCESS] All reward distributions finalized.");
  process.exit(0);
}

run();
