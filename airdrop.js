const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const fs = require('fs');
const csv = require('fast-csv');

const RPC_ENDPOINT = 'https://solana.com';
const TOKEN_MINT_ADDRESS = '4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump';
const DECIMALS = 6;

if (!process.env.PAYER_SECRET_KEY) {
    console.error("[CRITICAL] PAYER_SECRET_KEY variable is missing!");
    process.exit(1);
}

const payerSecretKey = JSON.parse(process.env.PAYER_SECRET_KEY);
const payerKeypair = Keypair.fromSecretKey(Uint8Array.from(payerSecretKey));

async function runAirdrop() {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `snapshot_${dateStr}.csv`;

    if (!fs.existsSync(fileName)) {
        console.error(`[ERROR] Snapshot file ${fileName} not found. Skipping distribution.`);
        return;
    }

    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    const mintPublicKey = new PublicKey(TOKEN_MINT_ADDRESS);
    const sourceATA = await getAssociatedTokenAddress(mintPublicKey, payerKeypair.publicKey);

    const recipients = [];
    let totalRequiredTokens = 0n;
    
    fs.createReadStream(fileName)
        .pipe(csv.parse({ headers: true }))
        .on('data', (row) => {
            if (row.Address && row.Amount && parseFloat(row.Amount) > 0) {
                const rawAmount = BigInt(Math.round(parseFloat(row.Amount) * Math.pow(10, DECIMALS)));
                totalRequiredTokens += rawAmount;
                recipients.push({
                    address: new PublicKey(row.Address),
                    amount: rawAmount
                });
            }
        })
        .on('end', async () => {
            console.log(`[AUDIT] Extracted ${recipients.length} addresses. Total required: ${Number(totalRequiredTokens) / Math.pow(10, DECIMALS)} HEDGE`);
            
            try {
                const tokenAccount = await getAccount(connection, sourceATA);
                const currentBalance = tokenAccount.amount;
                console.log(`[AUDIT] Payer wallet balance: ${Number(currentBalance) / Math.pow(10, DECIMALS)} HEDGE`);

                if (currentBalance < totalRequiredTokens) {
                    const missing = Number(totalRequiredTokens - currentBalance) / Math.pow(10, DECIMALS);
                    console.error(`[CRITICAL] STOPPING AIRDROP: Insufficient funds. You need to deposit ${missing} more HEDGE tokens into your payer wallet.`);
                    process.exit(1);
                }
            } catch (e) {
                console.error("[CRITICAL] Source token account does not exist or has 0 tokens. Deposit HEDGE tokens first.");
                process.exit(1);
            }

            const batchSize = 10; 
            for (let i = 0; i < recipients.length; i += batchSize) {
                const batch = recipients.slice(i, i + batchSize);
                const transaction = new Transaction();
                
                const { blockhash } = await connection.getLatestBlockhash('confirmed');
                transaction.recentBlockhash = blockhash;
                transaction.feePayer = payerKeypair.publicKey;

                for (const recipient of batch) {
                    try {
                        const destinationATA = await getAssociatedTokenAddress(mintPublicKey, recipient.address);
                        transaction.add(
                            createTransferCheckedInstruction(
                                sourceATA,
                                mintPublicKey,
                                destinationATA,
                                payerKeypair.publicKey,
                                recipient.amount,
                                DECIMALS
                            )
                        );
                    } catch (e) {
                        continue;
                    }
                }

                try {
                    const signature = await connection.sendTransaction(transaction, [payerKeypair], {
                        skipPreflight: true,
                        preflightCommitment: 'confirmed'
                    });
                    console.log(`[SUCCESS] Batch ${Math.floor(i / batchSize) + 1} sent. Tx: ${signature}`);
                } catch (err) {
                    console.error(`[ERROR] Batch failed:`, err.message);
                }
            }
            console.log("[FINISHED] Distribution cycle completed.");
        });
}

runAirdrop().catch(err => {
    console.error(err);
    process.exit(1);
});
