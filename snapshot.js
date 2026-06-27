   const { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
require('dotenv').config();

const MAIN_RPC = "https://helius-rpc.com";
const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const TOKEN_MINT_STR = '4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump';

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

async function fetchTokenAccountsHelius(rpcUrl, mintStr) {
  let page = 1;
  let allOwners = [];
  while (true) {
    try {
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
    } catch (err) {
      break;
    }
  }
  return allOwners;
}

async function run() {
  console.log(`[SCAN] Loading token holders using Helius RPC API...`);
  const connection = new Connection(MAIN_RPC, 'confirmed');
  const holdersList = await fetchTokenAccountsHelius(MAIN_RPC, TOKEN_MINT_STR);
  
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

  console.log(`[SUCCESS] Snapshot saved. Holders found: ${snapshot.length}`);

  if (snapshot.length === 0) {
    console.error("[CRITICAL] STOPPING: 0 active token holders found.");
    process.exit(1);
  }

  let payerAta;
  try {
    payerAta = await getAssociatedTokenAddress(tokenMint, payer.publicKey);
  } catch (err) {
    console.error("[CRITICAL] Could not find payer token account.");
    process.exit(1);
  }

  console.log("[INFO] Initiating automatic verified reward distribution...");
  for (const holder of snapshot) {
    if (holder.reward === 0n) continue;
    try {
      const holderAta = await getAssociatedTokenAddress(tokenMint, holder.owner);
      const transaction = new Transaction();
      
      transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }));

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
      
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payer.publicKey;
      
      const txid = await connection.sendTransaction(transaction, [payer], { 
        skipPreflight: false, 
        commitment: 'confirmed' 
      });
      
      await connection.confirmTransaction({
        signature: txid,
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight
      }, 'confirmed');

      console.log(`[REAL SUCCESS] Delivered 3% to ${holder.owner.toBase58()}. Tx: ${txid}`);
      await sleep(1000);
    } catch (txErr) {
      console.error(`[FAILED] Target ${holder.owner.toBase58()} failed! Reason: ${txErr.message}`);
      await sleep(1000);
    }
  }
  console.log("[SUCCESS] Process complete.");
  process.exit(0);
}

run();
     
