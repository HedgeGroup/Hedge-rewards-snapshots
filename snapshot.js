const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL;
const PAYER_KEY = process.env.PAYER_KEY;
const TOKEN_MINT = new PublicKey(process.env.TOKEN_MINT);

if (!RPC_URL || !PAYER_KEY) process.exit(1);

const connection = new Connection(RPC_URL, 'confirmed');

let secretKey;
try {
  secretKey = PAYER_KEY.startsWith('[') ? Uint8Array.from(JSON.parse(PAYER_KEY)) : bs58.decode(PAYER_KEY);
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
  const randomDelay = Math.floor(Math.random() * 7200000);
  await sleep(randomDelay);

  let accounts;
  try {
    const response = await connection.getTokenLargestAccounts(TOKEN_MINT);
    accounts = response.value;
  } catch (err) {
    process.exit(1);
  }

  const snapshot = [];
  for (const acc of accounts) {
    const amount = BigInt(acc.amount);
    if (amount > 0n) {
      snapshot.push({
        address: acc.address.toString(),
        reward: (amount * 3n) / 100n
      });
    }
  }

  while (getLondonHour() < 20) {
    await sleep(60000);
  }

  const payerAta = await getAssociatedTokenAddress(TOKEN_MINT, payer.publicKey);

  for (const holder of snapshot) {
    if (holder.reward === 0n) continue;
    try {
      const holderPubkey = new PublicKey(holder.address);
      const transaction = new Transaction().add(
        createTransferCheckedInstruction(
          payerAta,
          TOKEN_MINT,
          holderPubkey,
          payer.publicKey,
          holder.reward,
          9
        )
      );
      await connection.sendTransaction(transaction, [payer], { skipPreflight: false, commitment: 'confirmed' });
      await sleep(200);
    } catch (txErr) {
      await sleep(200);
      continue;
    }
  }
  process.exit(0);
}

run();
