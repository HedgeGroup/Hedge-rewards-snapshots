const { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY ? process.env.PAYER_SECRET_KEY.trim() : null;
const TOKEN_MINT_STR = '4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump';

const FIXED_HOLDERS = [
  { owner: "CgqDnm3YLPUGBoDy3PGTzF7gEmpXNnaBFc4o83VMBaXd", reward: "1000000000" },
  { owner: "FtHhkad3SAW3pyLgLG522urGGQnJDw4Ydtgr2ta9Ep5j", reward: "5000000000" }
];

const RPC_ENDPOINTS = [
  "https://helius-rpc.com",
  "https://ankr.com",
  "https://solana.com"
];

if (!PAYER_SECRET_KEY) {
  console.error("[CRITICAL ERROR] Missing PAYER_SECRET_KEY inside GitHub Secrets!");
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

async function requestCustom(method, params) {
  for (let rpcUrl of RPC_ENDPOINTS) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        // PARANDUS: Lisame kohustusliku User-Agent päise, et serverid päringut ei blokeeriks
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'payout-task', method, params }),
        signal: AbortSignal.timeout(8000)
      });
      const json = await response.json();
      if (json.result !== undefined) return json.result;
    } catch (err) {
      continue;
    }
  }
  throw new Error("All RPC servers failed or rate-limited.");
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

      const info = await requestCustom('getAccountInfo', [holderAta.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
      if (!info || info.value === null) {
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
      
      const blockhashData = await requestCustom('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      transaction.recentBlockhash = blockhashData.value.blockhash;
      transaction.feePayer = payer.publicKey;
      
      transaction.sign(payer);
      const serializedTx = transaction.serialize().toString('base64');
      
      const txid = await requestCustom('sendTransaction', [serializedTx, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]);

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

      
