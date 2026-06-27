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

async function run() {
  const connection = new Connection(MAIN_RPC, 'confirmed');
  const tokenMint = new PublicKey(TOKEN_MINT_STR);

  console.log("[INFO] Running airdrop test mode to self wallet...");

  let payerAta;
  try {
    payerAta = await getAssociatedTokenAddress(tokenMint, payer.publicKey);
  } catch (err) {
    console.error("[CRITICAL] Could not find payer token account.");
    process.exit(1);
  }

  try {
    const transaction = new Transaction();
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }));

    // Saadame testiks 1000000000000 base-unitit (sõltub tokeni decimalitest, tavaliselt väike summa) sinna samasse kontole tagasi
    transaction.add(
      createTransferCheckedInstruction(
        payerAta,
        tokenMint,
        payerAta,
        payer.publicKey,
        1n,
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

    console.log(`[REAL SUCCESS] Test transfer successful to yourself! Tx: ${txid}`);
  } catch (txErr) {
    console.error(`[FAILED] Test transfer failed! Reason: ${txErr.message}`);
  }
  
  console.log("[SUCCESS] Process complete.");
  process.exit(0);
}

run();
  
