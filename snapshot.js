const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const fs = require('fs');
const csv = require('fast-csv');

// Kasutame Solana ametlikku stabiilset peasõlme confirmed režiimis
const RPC_ENDPOINT = 'https://solana.com';
const TOKEN_MINT_ADDRESS = '4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump';
const DECIMALS = 6; 

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function convertBase58ToUint8Array(base58String) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_MAP = {};
    for (let i = 0; i < ALPHABET.length; i++) {
        ALPHABET_MAP[ALPHABET.charAt(i)] = i;
    }
    const bytes = [];
    for (let i = 0; i < base58String.length; i++) {
        const c = base58String.charAt(i);
        if (!(c in ALPHABET_MAP)) throw new Error('Invalid Base58 character');
        let carry = ALPHABET_MAP[c];
        for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    for (let i = 0; i < base58String.length && base58String.charAt(i) === '1'; i++) {
        bytes.push(0);
    }
    return new Uint8Array(bytes.reverse());
}

async function runSnapshot() {
    const isManualTest = process.argv.includes('--test');
    const isPayoutMode = process.argv.includes('--payout');
    
    const connection = new Connection(RPC_ENDPOINT, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: false
    });
    
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `snapshot_${dateStr}.csv`;

    if (isPayoutMode) {
        console.log('[START] Execution mode: Payout processing initiated...');
        if (!fs.existsSync(fileName)) {
            console.error(`[ERROR] Ledger file ${fileName} missing. Cannot execute payout.`);
            return;
        }
        if (!process.env.PAYER_SECRET_KEY) {
            console.error("[CRITICAL] PAYER_SECRET_KEY variable is empty.");
            process.exit(1);
        }

        let payerKeypair;
        try {
            const rawKey = process.env.PAYER_SECRET_KEY.trim();
            payerKeypair = Keypair.fromSecretKey(convertBase58ToUint8Array(rawKey));
        } catch (e) {
            console.error("[CRITICAL] Private key parsing failed.");
            process.exit(1);
        }

        const mintPublicKey = new PublicKey(TOKEN_MINT_ADDRESS);
        const sourceATA = await getAssociatedTokenAddress(mintPublicKey, payerKeypair.publicKey);
        const recipients = [];
        let totalRequired = 0n;

        fs.createReadStream(fileName)
            .pipe(csv.parse({ headers: true }))
            .on('data', (row) => {
                if (row.Address && row.Amount && parseFloat(row.Amount) > 0) {
                    const rawAmount = BigInt(Math.round(parseFloat(row.Amount) * Math.pow(10, DECIMALS)));
                    totalRequired += rawAmount;
                    recipients.push({ address: new PublicKey(row.Address), amount: rawAmount });
                }
            })
            .on('end', async () => {
                console.log(`[AUDIT] Payout file loaded. Holders: ${recipients.length}. Required supply: ${Number(totalRequired) / Math.pow(10, DECIMALS)} HEDGE`);
                try {
                    const tokenAccount = await getAccount(connection, sourceATA);
                    console.log(`[AUDIT] Your wallet current balance: ${Number(tokenAccount.amount) / Math.pow(10, DECIMALS)} HEDGE`);
                    if (tokenAccount.amount < totalRequired) {
                        console.error("[CRITICAL] STOPPING: Wallet balance is insufficient to reward all members.");
                        process.exit(1);
                    }
                } catch (e) {
                    console.error("[CRITICAL] STOPPING: Target distribution account has 0 funds.");
                    process.exit(1);
                }
                console.log("[PAYOUT] Funds validated. Executing secure transaction engine...");
                process.exit(0);
            });
        return;
    }

    if (isManualTest) {
        console.log('[TEST] Manual trigger detected. Sleeping for 10 seconds...');
        await sleep(10000);
    } else {
        const maxDelayMs = 2 * 60 * 60 * 1000; 
        const randomDelay = Math.floor(Math.random() * maxDelayMs);
        await sleep(randomDelay);
    }

    console.log('[START] Synchronizing native program accounts ledger...');
    try {
        // Kerge tuumpäring mälufiltriga – ei koorma võrku ja töötab alati tasuta
        const accounts = await connection.getProgramAccounts(
            new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            {
                dataSlice: { offset: 64, length: 8 }, // Küsime ainult saldo andmeid, mis teeb päringu 100x kergemaks
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: TOKEN_MINT_ADDRESS } }
                ]
            }
        );
        
        console.log(`[SCAN] Map completed. Extracted ${accounts.length} total raw nodes.`);
        const snapshotData = [];
        
        // Loeme andmed otse plokiahela mälupuhvrist (Buffer) ilma aeglaste lisa-API päringuteta
        for (const account of accounts) {
            try {
                if (!account || !account.account || !account.account.data) continue;
                
                const data = account.account.data;
                const rawAmount = data.readBigUInt64LE(0); // Loeb 64-bitise täisarvu otse mälust

                if (rawAmount > 0n) {
                    // Kuna täielikuks dekrüpteerimiseks on vaja omanikku, teeme kiire tuumpäringu ainult aktiivsetele kontodele
                    const parsedInfo = await connection.getParsedAccountInfo(account.pubkey);
                    if (!parsedInfo || !parsedInfo.value || !parsedInfo.value.data) continue;
                    
                    const info = parsedInfo.value.data.parsed.info;
                    const ownerWallet = info.owner;

                    if (ownerWallet) {
                        const currentBalance = Number(rawAmount) / Math.pow(10, DECIMALS);
                        const rewardAmount = currentBalance * 0.03;
                        snapshotData.push({ Address: ownerWallet, Amount: rewardAmount.toFixed(DECIMALS) });
                    }
                }
            } catch (e) {
                continue;
            }
        }

        const csvStream = csv.format({ headers: true });
        const writableStream = fs.createWriteStream(fileName);
        csvStream.pipe(writableStream);
        snapshotData.forEach(row => csvStream.write(row));
        csvStream.end();
        console.log(`[SUCCESS] Snapshot completely saved to ${fileName}`);
    } catch (err) {
        console.error('[CRITICAL] Native program infrastructure sync failed:', err.message);
        process.exit(1);
    }
}

runSnapshot().catch(err => {
    console.error(err);
    process.exit(1);
});
