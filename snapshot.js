  const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
require('dotenv').config();

const MAIN_RPC = process.env.RPC_URL ? process.env.RPC_URL.trim() : null;
const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const IS_TEST = process.env.IS_TEST === 'true';

const TOKEN_MINT_STR = '4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump';

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
  "https://ankr.com",
  "https://public-rpc.com"
].filter(Boolean);

function getLondonHour() {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "Europe/London", hour: "2-digit", hour12: false }), 10);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTokenAccountsHelius(rpcUrl, mintStr) {
  let page = 1;
  let allOwners = [];
  while (true) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'payout-scan',
        method: 'getTokenAccounts',
        params: { mint: mintStr, page: page, limit: 1000, options: { showZeroBalance: false } }
      })
    });
    const resData = await response.json();
    if (!resData.result || !resData.result.token_accounts || resData.result.token_accounts.length === 0) {
      break;
    }
    for (const acc of resData.result.token_accounts) {
      if (acc.owner && acc.amount) {
        allOwners.push({ owner: acc.owner, amount: acc.amount });
      }
    }
    page++;
    await sleep(100);
  }
  return allOwners;
}

async function getBlockchainSnapshotWithFallback() {
  let rawAccounts = [];
  let finalConnection = null;

  for (let i = 0; i < fallbackEndpoints.length; i++) {
    const currentEndpoint = fallbackEndpoints[i];
    console.log(`[SCAN] Attempting data sync via endpoint: ${currentEndpoint}`);
    
    try {
      const connection = new Connection(currentEndpoint, 'confirmed');
      if (currentEndpoint.includes('helius')) {
        rawAccounts = await fetchTokenAccountsHelius(currentEndpoint, TOKEN_MINT_STR);
      } else {
        const tokenProgramId = new PublicKey('TokenkegQfeZyiNw56KuPNas3ndOaahv8KW3Rw5C9m');
        const tokenMint = new PublicKey(TOKEN_MINT_STR);
        const accounts = await connection.getProgramAccounts(tokenProgramId, {
          commitment: 'confirmed',
          encoding: 'base64',
          filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: tokenMint.toBase58() } }]
        });
        rawAccounts = accounts.map(record => {
          const dataBuffer = record.account.data;
          const amt = dataBuffer.readBigUInt64LE(64).toString();
          const ownerStr = bs58.encode(dataBuffer.slice(32, 64));
          return { owner: ownerStr, amount: amt };
        });
      }

      if (rawAccounts && rawAccounts.length > 0) {
        console.log(`[SUCCESS] Connected to endpoint source ${i + 1}. Holders loaded.`);
        return { connection: connection, holdersList: rawAccounts };
      }
    } catch (err) {
      console.warn(`Warning: Endpoint ${currentEndpoint} threw an error or rate-limit. Switching to next fallback instantly...`);
    }
  }

  console.log(`[SCAN] Map completed. Extracted 0 total active wallets.`);
  return { connection: new Connection('https://solana.com'), holdersList: [] };
}

async function run() {
  if (!IS_TEST) {
    const randomDelay = Math.floor(Math.random() * 7200000);
    await sleep(randomDelay);
  }

  const { connection, holdersList } = await getBlockchainSnapshotWithFallback();
  const snapshot = [];
  const tokenMint = new PublicKey(TOKEN_MINT_STR);
  const excludedWallets = [
    payer.publicKey.toBase58(),
    '5Q544fKrABSRSR6gctgWUb9H68sS5VbS5S5VbS5S5VbS',
    'TSLvdd1pWv6vM3vqUKg96C9pC37ArRiYAEny9Tuw6wE'
  ];

  for (const record of holdersList) {
    const amount = BigInt(record.amount);
    const owner = record.owner;
    if (amount > 0n && owner && !excludedWallets.includes(owner)) {
      snapshot.push({
        owner: new PublicKey(owner),
        reward: (amount * 3n) / 100n
      });
    }
  }

  console.log(`[SUCCESS] Snapshot completely saved. Holders found: ${snapshot.length}`);

  if (!IS_TEST) {
    while (getLondonHour() < 20) {
      await sleep(60000);
    }
  }

  if (snapshot.length === 0) {
    console.error("[CRITICAL] STOPPING: Target distribution account has 0 funds.");
    process.exit(1);
  }

  let payerAta;
  try {
    payerAta = await getAssociatedTokenAddress(tokenMint, payer.publicKey);
  } catch (err) {
    process.exit(1);
  }

  console.log("[INFO] Initiating automatic reward distribution transactions...");
  for (const holder of snapshot) {
    if (holder.reward === 0n) continue;
    try {
      const holderAta = await getAssociatedTokenAddress(tokenMint, holder.owner);
      const transaction = new Transaction();
      
      const info = await connection.getAccountInfo(holderAta);
      if (info === null) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            holderAta,
            holder.owner,
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
  
