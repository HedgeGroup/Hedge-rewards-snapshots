const axios = require('axios');
const fs = require('fs');
const PUBLIC_SOLANA_RPC = "https://solana.com";
const TOKEN_MINT = process.env.TOKEN_MINT_ADDRESS;
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function runRandomSnapshot() {
    console.log("START_WINDOW");
    const randomSeconds = Math.floor(Math.random() * 7200);
    console.log("DELAY_SECONDS: " + randomSeconds);
    await sleep(randomSeconds * 1000);
    const executionTime = new Date().toISOString();
    console.log("SNAPSHOT_TRIGGERED: " + executionTime);
    try {
        const response = await axios.post(PUBLIC_SOLANA_RPC, {
            jsonrpc: "2.0",
            id: "solana-snapshot",
            method: "getTokenLargestAccounts",
            params: [TOKEN_MINT]
        });
        if (!response.data || !response.data.result || !response.data.result.value) { throw new Error("INVALID_RESPONSE"); }
        let csvContent = "wallet_address,token_balance,reward_amount_3_percent\n";
        response.data.result.value.forEach(account => {
            const wallet = account.address;
            const balance = parseFloat(account.amount);
            if (balance > 0) {
                const reward = (balance * 0.03).toFixed(2);
                csvContent += `${wallet},${balance},${reward}\n`;
            }
        });
        const fileName = `snapshot_${executionTime.substring(0,10)}.csv`;
        fs.writeFileSync(fileName, csvContent);
        console.log("FILE_CREATED: " + fileName);
    } catch (error) {
        console.error("ERROR: " + error.message);
        process.exit(1);
    }
}
runRandomSnapshot();
