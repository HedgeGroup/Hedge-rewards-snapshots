name: HEDGE Reward System

on:
  workflow_dispatch:
    inputs:
      test_mode:
        required: true
        default: 'true'
  schedule:
    - cron: '0 15 * * 6'

jobs:
  hedge-rewards:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Install Solana Libraries
        run: npm install @solana/web3.js @solana/spl-token dotenv bs58

      - name: Variables
        run: |
          echo "RPC_URL=${{ secrets.SOLANA_RPC_URL }}" >> .env
          echo "PAYER_KEY=${{ secrets.PAYER_PRIVATE_KEY }}" >> .env
          echo "TOKEN_MINT=4TKoRYDzXfSSY3NkFafstKey2cJrQxdw27rGtoV5pump" >> .env
          echo "IS_TEST=${{ github.event.inputs.test_mode || 'false' }}" >> .env

      - name: Run Reward System
        run: node snapshot.js
