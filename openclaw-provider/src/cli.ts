#!/usr/bin/env node
/**
 * llm402-openclaw CLI — wallet management for llm402.ai
 *
 * Commands: init, fund, balance, check-funding, sync
 * Run `llm402-openclaw --help` for usage.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Llm402Wallet, validateMintUrl, validateRelayUrl } from './lib/index.js';

const WALLET_DIR = join(homedir(), '.llm402');
const WALLET_FILE = join(WALLET_DIR, 'wallet.json');
const PENDING_DIR = join(WALLET_DIR, 'pending');

const [,, command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'init':
      await handleInit(args);
      break;
    case 'fund':
      await handleFund(args);
      break;
    case 'balance':
      await handleBalance(args);
      break;
    case 'check-funding':
      await handleCheckFunding(args);
      break;
    case 'sync':
      await handleSync(args);
      break;
    case '--help':
    case '-h':
      printUsage();
      break;
    case undefined:
      printUsage();
      process.exit(1);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run llm402-openclaw --help for usage.');
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`llm402-openclaw — wallet CLI for llm402.ai

Usage:
  llm402-openclaw <command> [options]

Commands:
  init            Create or load a wallet
  fund <amount>   Get a Lightning invoice, pay, mint Cashu proofs
  balance         Show Cashu balance (+ optional USDC with --check-usdc)
  check-funding   Resolve pending quotes from prior fund timeouts
  sync            Pull wallet state from Nostr relays (opt-in)

Options:
  --help, -h      Show this help

Environment:
  LLM402_NSEC          Nostr secret key (bech32 nsec1...) for init/sync
  LLM402_EVM_KEY       EVM private key (0x hex) for init
  LLM402_SHOW_SECRETS  Set to 1 to reveal secrets in init output

Docs: https://llm402.ai/docs`);
}

async function handleInit(initArgs: string[]): Promise<void> {
  // Reject --nsec / --evm-key flags — they leak via /proc/cmdline and shell history
  if (initArgs.some(a => a === '--nsec' || a.startsWith('--nsec=') ||
                         a === '--evm-key' || a.startsWith('--evm-key='))) {
    console.error('Error: --nsec/--evm-key flags expose secrets in /proc/cmdline and shell history.');
    console.error('Use environment variables instead:');
    console.error('  LLM402_NSEC=nsec1... llm402-openclaw init');
    console.error('  LLM402_EVM_KEY=0x... llm402-openclaw init');
    process.exit(1);
  }

  const envNsec = process.env.LLM402_NSEC;
  const envEvmKey = process.env.LLM402_EVM_KEY;
  const showSecrets = process.env.LLM402_SHOW_SECRETS === '1';

  // Scope restriction: if wallet exists AND LLM402_NSEC is set AND nsec differs → hard fail.
  // Prevents silent overwrite of an existing wallet with a different identity.
  if (envNsec && existsSync(WALLET_FILE)) {
    try {
      const stored = JSON.parse(readFileSync(WALLET_FILE, 'utf-8'));
      if (stored.nsec && stored.nsec !== envNsec) {
        console.error('Error: wallet exists at ~/.llm402/wallet.json with a different nsec.');
        console.error('Unset LLM402_NSEC, or delete the existing wallet if you intend to replace it.');
        console.error('Aborting to prevent silent overwrite.');
        process.exit(1);
      }
    } catch {
      // Corrupt or unreadable — let wallet.init() handle gracefully
    }
  }

  const wallet = new Llm402Wallet();

  try {
    await wallet.init(envNsec, envEvmKey);
  } catch (err) {
    console.error(`Error initializing wallet: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Summary output
  const balance = wallet.getBalance();
  const nsec = wallet.getNsec();
  const evmAddress = wallet.getEvmAddress();
  const evmKey = wallet.getEvmPrivateKey();
  const mints = wallet.getMintUrls();
  const hidden = '[hidden — run with LLM402_SHOW_SECRETS=1 to reveal]';

  console.log('Wallet ready at ~/.llm402/wallet.json');
  console.log();
  console.log(`Nostr (Cashu) nsec: ${showSecrets ? nsec : hidden}`);
  console.log(`EVM address:        ${evmAddress}`);
  console.log();
  console.log(`Default mints: ${mints.join(', ')}`);
  if (balance.total > 0) {
    console.log(`Balance: ${balance.total} sats`);
  }
  console.log();
  console.log('Next:');
  console.log('  npx llm402-openclaw fund 5000       # get a Lightning invoice, pay, mint Cashu proofs');
  console.log('  npx llm402-openclaw balance          # check balance');
  console.log('  npx llm402-openclaw sync             # opt-in: pull wallet from Nostr relays');
  console.log();
  console.log('OpenClaw host config (paste into your plugin auth config):');
  if (showSecrets) {
    console.log(JSON.stringify({
      paymentMode: 'cashu',
      cashuNsec: nsec,
      evmPrivateKey: evmKey,
    }, null, 2));
  } else {
    console.log('  Run with LLM402_SHOW_SECRETS=1 to reveal the config snippet with real keys.');
  }
}

const QUOTE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PENDING_EXPIRY_MS = 65 * 60 * 1000; // 65 minutes

async function handleFund(fundArgs: string[]): Promise<void> {
  // Parse args: fund <amount> [--mint <url>]
  let amountStr: string | undefined;
  let mintUrl: string | undefined;

  for (let i = 0; i < fundArgs.length; i++) {
    if (fundArgs[i] === '--mint') {
      mintUrl = fundArgs[++i];
      if (!mintUrl) {
        console.error('Error: --mint requires a URL argument.');
        process.exit(1);
      }
    } else if (!amountStr && !fundArgs[i].startsWith('-')) {
      amountStr = fundArgs[i];
    }
  }

  if (!amountStr) {
    console.error('Usage: llm402-openclaw fund <amount> [--mint <url>]');
    process.exit(1);
  }

  // Validate amount
  const amount = Number(amountStr);
  if (!Number.isInteger(amount) || amount <= 0) {
    console.error('Error: amount must be a positive integer.');
    process.exit(1);
  }
  if (amount >= 100_000_000) {
    console.error('Error: amount must be less than 100,000,000 sats (1 BTC).');
    process.exit(1);
  }
  if (amount < 10) {
    console.error('Warning: amounts below 10 sats may fail at some mints.');
  }

  // Validate --mint URL
  if (mintUrl) {
    try {
      mintUrl = validateMintUrl(mintUrl);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    mintUrl = mintUrl.replace(/\/$/, '');
  }

  // Init wallet
  const wallet = new Llm402Wallet();
  await wallet.init();

  // Auto-recover pending quotes
  if (!existsSync(PENDING_DIR)) {
    mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 });
  }

  const pendingFiles = readdirSync(PENDING_DIR);
  for (const file of pendingFiles) {
    if (!file.endsWith('.json')) continue;
    const baseName = file.slice(0, -5);
    if (!QUOTE_ID_RE.test(baseName)) continue;

    const filePath = join(PENDING_DIR, file);
    try {
      const pending = JSON.parse(readFileSync(filePath, 'utf-8'));

      if (Date.now() - pending.createdAt > PENDING_EXPIRY_MS) {
        unlinkSync(filePath);
        console.log(`[expired: ${baseName}]`);
        continue;
      }

      const status = await wallet.checkFunding(
        pending.quoteId,
        pending.mintUrl,
        pending.amount,
      );
      if (status === 'paid') {
        console.log(`[recovered ${pending.amount} sats from pending quote ${baseName}]`);
        unlinkSync(filePath);
      }
    } catch {
      // Skip corrupt files
    }
  }

  // Request funding
  const funding = await wallet.requestFunding(amount, mintUrl);

  if (!QUOTE_ID_RE.test(funding.quoteId)) {
    throw new Error('Mint returned invalid quoteId format');
  }

  // Print invoice
  console.log(`Pay this Lightning invoice (${amount} sats):`);
  console.log();
  console.log(`lightning:${funding.invoice}`);
  console.log();
  console.log(`BOLT11: ${funding.invoice}`);
  console.log(`Quote ID: ${funding.quoteId}`);
  console.log();
  console.log('Polling for payment (5 minutes)...');

  // Record balance before polling
  const balanceBefore = wallet.getBalance().total;

  // Poll: every 3s for up to 300s (100 iterations)
  let fundingStatus: 'paid' | 'expired' | 'unpaid' = 'unpaid';
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 3000));
    fundingStatus = await wallet.checkFunding(funding.quoteId, funding.mintUrl, amount);
    if (fundingStatus === 'paid' || fundingStatus === 'expired') break;
  }

  if (fundingStatus === 'paid') {
    const balanceAfter = wallet.getBalance().total;
    const delta = balanceAfter - balanceBefore;
    const feeNote = delta < amount ? ` — mint retained ${amount - delta} sats in fees` : '';
    console.log(`Received ${delta} sats (requested ${amount})${feeNote}`);
  } else {
    // Save pending quote for later resolution
    const pendingFile = join(PENDING_DIR, `${funding.quoteId}.json`);
    writeFileSync(pendingFile, JSON.stringify({
      quoteId: funding.quoteId,
      mintUrl: funding.mintUrl,
      amount,
      createdAt: Date.now(),
    }), { mode: 0o600 });

    console.log('Timeout — invoice may still be valid at mint.');
    console.log(`Saved to ~/.llm402/pending/${funding.quoteId}.json`);
    console.log('To resolve later: npx llm402-openclaw check-funding');
  }
}

async function handleCheckFunding(checkArgs: string[]): Promise<void> {
  // Parse optional --quote <id> --mint <url> for single-shot resolution
  let singleQuote: string | undefined;
  let singleMint: string | undefined;

  for (let i = 0; i < checkArgs.length; i++) {
    if (checkArgs[i] === '--quote') {
      singleQuote = checkArgs[++i];
    } else if (checkArgs[i] === '--mint') {
      singleMint = checkArgs[++i];
    }
  }

  const wallet = new Llm402Wallet();
  await wallet.init();

  // Single-shot mode: resolve one specific quote
  if (singleQuote && singleMint) {
    if (!QUOTE_ID_RE.test(singleQuote)) {
      console.error('Error: invalid quote ID format.');
      process.exit(1);
    }
    const status = await wallet.checkFunding(singleQuote, singleMint);
    if (status === 'paid') {
      console.log(`Minted proofs from quote ${singleQuote}`);
    } else if (status === 'expired') {
      console.log(`Quote ${singleQuote} expired at mint.`);
    } else {
      console.log(`Quote ${singleQuote} still unpaid.`);
    }
    return;
  }

  // Batch mode: iterate ~/.llm402/pending/ directory
  if (!existsSync(PENDING_DIR)) {
    console.log('No pending quotes.');
    return;
  }

  const pendingFiles = readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
  if (pendingFiles.length === 0) {
    console.log('No pending quotes.');
    return;
  }

  let mintedSats = 0;
  let removedCount = 0;
  let probed = 0;

  for (const file of pendingFiles) {
    const baseName = file.slice(0, -5);
    if (!QUOTE_ID_RE.test(baseName)) continue;

    const filePath = join(PENDING_DIR, file);
    try {
      const pending = JSON.parse(readFileSync(filePath, 'utf-8'));

      // Age-based expiry
      if (Date.now() - pending.createdAt > PENDING_EXPIRY_MS) {
        unlinkSync(filePath);
        console.log(`  ${baseName}: expired (age > 65 min), removed`);
        removedCount++;
        continue;
      }

      probed++;
      const status = await wallet.checkFunding(
        pending.quoteId,
        pending.mintUrl,
        pending.amount,
      );

      if (status === 'paid') {
        console.log(`  ${baseName}: minted ${pending.amount} sats`);
        mintedSats += pending.amount;
        unlinkSync(filePath);
        removedCount++;
      } else if (status === 'expired') {
        console.log(`  ${baseName}: expired at mint, removed`);
        unlinkSync(filePath);
        removedCount++;
      } else {
        console.log(`  ${baseName}: still unpaid`);
      }
    } catch {
      // Skip corrupt files
    }
  }

  console.log(`Probed ${probed} pending quotes. Minted ${mintedSats} sats. Removed ${removedCount}.`);
}

async function handleSync(syncArgs: string[]): Promise<void> {
  // Reject --nsec flag (same reason as init)
  if (syncArgs.some(a => a === '--nsec' || a.startsWith('--nsec='))) {
    console.error('Error: --nsec flag exposes secrets in /proc/cmdline and shell history.');
    console.error('Use LLM402_NSEC env var instead.');
    process.exit(1);
  }

  // Parse args: sync [--relays <comma-separated>] [--allow-remote-mints]
  let relayList: string[] | undefined;
  let allowRemoteMints = false;

  for (let i = 0; i < syncArgs.length; i++) {
    if (syncArgs[i] === '--relays') {
      const val = syncArgs[++i];
      if (!val) {
        console.error('Error: --relays requires a comma-separated list of wss:// URLs.');
        process.exit(1);
      }
      relayList = val.split(',').map(s => s.trim()).filter(Boolean);
      if (relayList.length === 0) {
        console.error('Error: --relays list is empty.');
        process.exit(1);
      }
      if (relayList.length > 10) {
        console.error('Error: maximum 10 relays allowed.');
        process.exit(1);
      }
      // Validate each relay URL
      for (const url of relayList) {
        try {
          validateRelayUrl(url);
        } catch (err) {
          console.error(`Error: relay ${url} — ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      }
    } else if (syncArgs[i] === '--allow-remote-mints') {
      allowRemoteMints = true;
    }
  }

  const envNsec = process.env.LLM402_NSEC;

  // If wallet doesn't exist, require LLM402_NSEC to create one for sync
  if (!existsSync(WALLET_FILE) && !envNsec) {
    console.error('Error: no wallet at ~/.llm402/wallet.json and LLM402_NSEC not set.');
    console.error('Create a wallet first: npx llm402-openclaw init');
    console.error('Or set LLM402_NSEC to sync an existing Nostr wallet.');
    process.exit(1);
  }

  const wallet = new Llm402Wallet();
  try {
    await wallet.init(envNsec);
  } catch (err) {
    console.error(`Error initializing wallet: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log('Syncing from Nostr relays...');
  const result = await wallet.syncFromNostr({
    relays: relayList,
    allowRemoteMints,
  });

  console.log(`Found ${result.events} wallet event(s). Added ${result.proofsAdded} new proof(s) (${result.sats} sats).`);

  const balance = wallet.getBalance();
  console.log(`Balance: ${balance.total} sats`);
}

async function handleBalance(balanceArgs: string[]): Promise<void> {
  const checkUsdc = balanceArgs.includes('--check-usdc');

  const wallet = new Llm402Wallet();

  try {
    await wallet.init();
  } catch (err) {
    console.error(`Error initializing wallet: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Cashu balance breakdown
  const balance = wallet.getBalance();
  console.log(`Cashu balance: ${balance.total} sats`);
  for (const mint of balance.perMint) {
    console.log(`  ${mint.url}  ${mint.sats} sats`);
  }
  console.log(`Est. requests remaining: ~${balance.estimatedRequests} (at ~21 sats/request)`);

  // Pending funding quotes
  if (existsSync(PENDING_DIR)) {
    try {
      const entries = readdirSync(PENDING_DIR);
      if (entries.length > 0) {
        console.log(`Pending quotes: ${entries.length} (run \`check-funding\` to probe)`);
      }
    } catch {
      // Directory unreadable — skip
    }
  }

  // EVM address (always shown)
  console.log(`EVM address: ${wallet.getEvmAddress()}`);

  // Optional on-chain USDC balance check
  if (checkUsdc) {
    try {
      const { createPublicClient, http } = await import('viem');
      const { base } = await import('viem/chains');
      const client = createPublicClient({ chain: base, transport: http() });
      const usdcBalance = await client.readContract({
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        abi: [{
          name: 'balanceOf',
          type: 'function',
          stateMutability: 'view' as const,
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        }],
        functionName: 'balanceOf',
        args: [wallet.getEvmAddress() as `0x${string}`],
      });
      const formatted = (Number(usdcBalance) / 1e6).toFixed(2);
      console.log(`USDC balance: $${formatted} on Base`);
    } catch {
      console.log('USDC balance: unavailable (RPC error)');
    }
  }
}

main().catch(err => {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
