/**
 * @llm402/openclaw-provider/lib — payment client, wallet, and shared types.
 *
 * Before 0.3.0 this source shipped as the standalone npm package @llm402/core
 * (deprecated, see RUNBOOK.md). From 0.3.0 it lives under this package's
 * `./lib` subpath export and is consumed internally by the plugin.
 *
 * Public surface (via `@llm402/openclaw-provider/lib` subpath export):
 *   - `LLM402Client`           — payment-aware HTTP client
 *   - `Llm402Wallet`           — Cashu ecash + EVM wallet
 *   - `parsePaymentRequiredHeader`, `resolveX402Requirement` — x402 parsing
 *   - `USDC_*`, `EXPECTED_*`   — pinned x402 security constants
 *   - types for chat, models, wallet data, x402 envelopes
 */

export { LLM402Client, isValidBaseUrl } from './client.js';
export type { LLM402ClientOptions } from './client.js';
export { Llm402Wallet, validateMintUrl, validateRelayUrl } from './wallet.js';
export {
  parsePaymentRequiredHeader,
  resolveX402Requirement,
  USDC_ADDRESS,
  EXPECTED_PAYTO,
  EXPECTED_NETWORK,
  MAX_USDC_PER_REQUEST_ATOMIC,
  USDC_EIP712_DOMAIN,
} from './x402.js';
export type {
  ChatMessage,
  ChatCompletionChoice,
  ChatCompletionUsage,
  ChatCompletionResponse,
  ModelEntry,
  ModelsResponse,
  PaymentRequiredResponse,
  WalletData,
  WalletDataV1,
  WalletDataV2,
  SerializedProof,
  MintBalance,
  BalanceSummary,
  FundingResult,
  X402PaymentPayload,
  X402PaymentRequirement,
  X402Envelope,
  ProbeResult,
} from './types.js';
