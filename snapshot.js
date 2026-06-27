const { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
require('dotenv').config();

const fetch = require('node-fetch');

const MAIN_RPC = "https://helius-rpc.com";
const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const TOKEN_MINT_STR = '4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump';

const FIXED_HOLDERS = [
  { owner: "CgqDnm3YLPUGBoDy3PGTzF7gEmpXNnaBFc4o83VMBaXd", reward: "1000000000" },
  { owner: "FtHhkad3SAW3pyLgLG522urGGQnJDw4Ydtgr2ta9Ep5j", reward: "5000000000" }
];

if (!PAYER_SECRET_KEY) {
  console.error("[CRITICAL ERROR] Missing PAYER_SECRET_KEY!");
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
      secretKey = Uint8Array.from(cleanedKey.replace(/[^0-9,]/g, '').split(',').map(Number));
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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAccountInfoCustom(rpcUrl, accountPublicKey) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'get-info',
      method: 'getAccountInfo',
      params: [accountPublicKey.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]
    })
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result ? json.result.value : null;
}

async function getLatestBlockhashCustom(rpcUrl) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'get-hash',
      method: 'getLatestBlockhash',
      params: [{ commitment: 'confirmed' }]
    })
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result.value;
}

async function sendTransactionCustom(rpcUrl, base64Tx) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'send-tx',
      method: 'sendTransaction',
      params: [base64Tx, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]
    })
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function run() {
  const tokenMint = new PublicKey(TOKEN_MINT_STR);
  console.log(`[SUCCESS] Fixed snapshot loaded. Total targets to process: ${FIXED_HOLDERS.length}`);
  console.log("[INFO] Initiating automatic verified reward distribution... ");

  let payerAta;
  try {
    payerAta = await getAssociatedTokenAddress(tokenMint, payer.publicKey);
  } catch (err) {
    console.error("[CRITICAL] Could not find payer token account.");
    process.exit(1);
  }

  for (const entry of FIXED_HOLDERS) {
    const holderOwner = new PublicKey(entry.owner);
    const holderReward = BigInt(entry.reward);

    if (holderReward === 0n) continue;
    try {
      const holderAta = await getAssociatedTokenAddress(tokenMint, holderOwner);
      const transaction = new Transaction();
      
      transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300000 }));

      const info = await getAccountInfoCustom(MAIN_RPC, holderAta);
      if (info === null) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            holderAta,
            holderOwner,
            tokenMint
          )
        );
      }

      transaction.add(
        createTransferCheckedInstruction(
          payerAta,
          tokenMint,
          holderAta,
          payer.publicKey,
          holderReward,
          9
        )
      );
      
      const blockhashData = await getLatestBlockhashCustom(MAIN_RPC);
      transaction.recentBlockhash = blockhashData.blockhash;
      transaction.feePayer = payer.publicKey;
      
      transaction.sign(payer);
      const serializedTx = transaction.serialize().toString('base64');
      
      const txid = await sendTransactionCustom(MAIN_RPC, serializedTx);

      console.log(`[REAL SUCCESS] Delivered reward to ${holderOwner.toBase58()}. Tx: ${txid}`);
      await sleep(1500);
    } catch (txErr) {
      console.error(`[FAILED] Target ${holderOwner.toBase58()} failed! Reason: ${txErr.message}`);
      await sleep(1500);
    }
  }
  console.log("[SUCCESS] Process complete.");
  process.exit(0);
}

run();


      
      
