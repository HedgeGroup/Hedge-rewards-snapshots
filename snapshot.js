const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const csv = require('fast-csv');

const RPC_ENDPOINT = 'https://mainnet-triton.one';
const TOKEN_MINT_ADDRESS = '4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump';
const DECIMALS = 6; 

async function runSnapshot() {
    const connection = new Connection(RPC_ENDPOINT, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 120000
    });

    const accounts = await connection.getParsedProgramAccounts(
        new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        {
            filters: [
                { dataSize: 165 },
                { memcmp: { offset: 0, bytes: TOKEN_MINT_ADDRESS } }
            ]
        }
    );

    const snapshotData = [];
    const dateStr = new Date().toISOString().split('T')[0];
    
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

            if (rawBalance > 0n && ownerWallet) {
                const currentBalance = Number(rawBalance) / Math.pow(10, DECIMALS);
                const rewardAmount = currentBalance * 0.03;

                snapshotData.push({
                    Address: ownerWallet,
                    Amount: rewardAmount.toFixed(DECIMALS)
                });
            }
        } catch (e) {
            const pubkeyStr = account?.pubkey ? account.pubkey.toBase58() : 'Unknown';
            console.error(`Error processing ${pubkeyStr}:`, e.message);
            continue;
        }
    }

    const fileName = `snapshot_${dateStr}.csv`;
    const csvStream = csv.format({ headers: true });
    const writableStream = fs.createWriteStream(fileName);

    csvStream.pipe(writableStream);
    snapshotData.forEach(row => csvStream.write(row));
    csvStream.end();
}

runSnapshot().catch(err => {
    console.error(err);
    process.exit(1);
});
