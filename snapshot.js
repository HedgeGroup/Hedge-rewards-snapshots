const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL ? process.env.RPC_URL.trim() : null;
let PAYER_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const IS_TEST = process.env.IS_TEST === 'true';

const TOKEN_MINT = new PublicKey(new Uint8Array([51, 150, 203, 114, 5, 235, 12, 107, 49, 140, 2, 90, 95, 246, 219, 210, 8, 207, 96, 240, 112, 219, 44, 21, 172, 85, 224, 210, 228, 9, 252, 155]));
const TOKEN_PROGRAM_ID = new PublicKey(new Uint8Array([6, 221, 232, 242, 225, 208, 149, 18, 177, 190, 87, 194, 225, 126, 32, 236, 175, 48, 186, 30, 229, 61, 244, 119, 177, 242, 211, 48, 43, 163, 184, 137]));

if (PAYER_KEY) {
  PAYER_KEY = PAYER_KEY.replace(/[\r\n]/g, '').trim();
  if (PAYER_KEY.startsWith('"') || PAYER_KEY.startsWith("'")) PAYER_KEY = PAYER_KEY.slice(1);
  if (PAYER_KEY.endsWith('"') || PAYER_KEY.endsWith("'")) PAYER_KEY = PAYER_KEY.slice(0, -1);
  PAYER_KEY = PAYER_KEY.trim();
}

if (!RPC_URL || !PAYER_KEY) {
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
    await sleep(randomDelay);
  }

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

  if (!IS_TEST) {
    while (getLondonHour() < 20) {
      await sleep(60000);
    }
  }

  let payerAta;
  try {
    payerAta = await getAssociatedTokenAddress(TOKEN_MINT, payer.publicKey);
  } catch (err) {
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
      
      await connection.sendTransaction(transaction, [payer], { skipPreflight: true, commitment: 'confirmed' });
      await sleep(300);
    } catch (txErr) {
      await sleep(300);
      continue;
    }
  }
  process.exit(0);
}

run();

