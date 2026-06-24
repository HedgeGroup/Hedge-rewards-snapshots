
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const csv = require('fast-csv');

// Kasutame optimeeritud ja töökindlat QuickNode otselinki masspäringute jaoks
const RPC_ENDPOINT = 'https://quiknode.pro';
const TOKEN_MINT_ADDRESS = '4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump';
const DECIMALS = 6; 

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runSnapshot() {
    const isManualTest = process.argv.includes('--test');
    
    if (isManualTest) {
        console.log('[TEST] Manual trigger detected. Sleeping for 10 seconds for quick test...');
        await sleep(10000);
    } else {
        const maxDelayMs = 2 * 60 * 60 * 1000; 
        const randomDelay = Math.floor(Math.random() * maxDelayMs);
        const minutes = Math.floor(randomDelay / 60000);
        console.log(`[INIT] Automated Saturday run. Anti-bot activated. Sleeping for ${minutes} minutes...`);
        await sleep(randomDelay);
    }

    console.log('[START] Downloading EVERY single token holder from the ledger...');
    
    try {
        const connection = new Connection(RPC_ENDPOINT, 'confirmed');
        const accounts = await connection.getParsedProgramAccounts(
            new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            {
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: TOKEN_MINT_ADDRESS } }
                ]
            }
        );
        
        console.log(`[SCAN] Successfully found ${accounts.length} total active wallets.`);

        const snapshotData = [];
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        
        for (const account of accounts) {
            try {
                if (!account || !account.account || !account.account.data || !account.account.data.parsed) {
                    continue;
                }

                const info = account.account.data.parsed.info;
                if (!info || !info.tokenAmount) {
                    continue;
                }

                const ownerWallet = info.owner;
                const rawBalance = BigInt(info.tokenAmount.amount);

                // Loeb sisse KÕIK rahakotid, mille saldo on suurem kui null
                if (rawBalance > 0n && ownerWallet) {
                    const currentBalance = Number(rawBalance) / Math.pow(10, DECIMALS);
                    const rewardAmount = currentBalance * 0.03;

                    snapshotData.push({
                        Address: ownerWallet,
                        Amount: rewardAmount.toFixed(DECIMALS)
                    });
                }
            } catch (e) {
                continue;
            }
        }

        const fileName = `snapshot_${dateStr}.csv`;
        const csvStream = csv.format({ headers: true });
        const writableStream = fs.createWriteStream(fileName);

        csvStream.pipe(writableStream);
        snapshotData.forEach(row => csvStream.write(row));
        csvStream.end();
        
        console.log(`[SUCCESS] Snapshot completely saved to ${fileName}`);

    } catch (err) {
        console.error('[CRITICAL ERROR] High-performance pipeline failed:', err.message);
        process.exit(1);
    }
}

runSnapshot();




