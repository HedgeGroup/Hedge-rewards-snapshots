const fs = require('fs');
const csv = require('fast-csv');

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

    console.log('[START] Downloading all token holders via free tracking infrastructure...');
    
    try {
        const response = await fetch(`https://solanatracker.io{TOKEN_MINT_ADDRESS}/holders`);
        if (!response.ok) {
            throw new Error(`Tracking network responded with status: ${response.status}`);
        }
        
        const data = await response.json();
        const holders = data.holders || [];
        console.log(`[SCAN] Successfully extracted ${holders.length} active wallet addresses.`);

        const snapshotData = [];
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        
        for (const holder of holders) {
            const ownerWallet = holder.wallet;
            const currentBalance = parseFloat(holder.amount);

            if (currentBalance > 0 && ownerWallet) {
                const rewardAmount = currentBalance * 0.03;

                snapshotData.push({
                    Address: ownerWallet,
                    Amount: rewardAmount.toFixed(DECIMALS)
                });
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
        console.error('[CRITICAL ERROR] Failed to fetch data from tracking network:', err.message);
        process.exit(1);
    }
}

runSnapshot();




