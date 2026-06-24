name: Saturday Snapshot and Same-Day Payout

on:
  schedule:
    - cron: '0 16 * * 6' # Saturdays at 16:00 UTC (Snapshot)
    - cron: '0 20 * * 6' # Saturdays at 20:00 UTC (Payout)
  workflow_dispatch:

jobs:
  process:
    runs-on: ubuntu-latest

    permissions:
      contents: write

    steps:
    - name: Checkout Code Base
      uses: actions/checkout@v4

    - name: Set up Node.js Environment
      uses: actions/setup-node@v4
      with:
        node-version: '24'

    - name: Install Runtime Dependencies
      run: npm install

    - name: Run Snapshot Logic (Saturdays 16:00)
      if: github.event.schedule == '0 16 * * 6'
      run: node snapshot.js

    - name: Run Payout Logic (Saturdays 20:00)
      if: github.event.schedule == '0 20 * * 6'
      run: node snapshot.js --payout
      env:
        PAYER_SECRET_KEY: ${{ secrets.PAYER_SECRET_KEY }}

    - name: Run Manual Full Simulation Test
      if: github.event_name == 'workflow_dispatch'
      run: |
        node snapshot.js --test
        node snapshot.js --payout
      env:
        PAYER_SECRET_KEY: ${{ secrets.PAYER_SECRET_KEY }}

    - name: Push CSV Logs Openly to Repository
      run: |
        git config --global user.name "Satoshi-Proof-Bot"
        git config --global user.email "bot@github.internal"
        git add snapshot_*.csv
        git commit -m "Automated Weekly Yield Cycle: $(date +'%Y-%m-%d')" || exit 0
        git push origin main
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

