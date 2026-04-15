/** llm402.ai API response types */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

export interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelsResponse {
  object: 'list';
  data: ModelEntry[];
}

/** 402 Payment Required response from llm402.ai */
export interface PaymentRequiredResponse {
  error: string;
  description: string;
  price: number;
  model: string;
  provider: string;
  max_tokens: number;
  estimated_input_tokens: number;
  invoice?: string;
  macaroon?: string;
  paymentHash?: string;
  cashu?: {
    price_sats: number;
    unit: string;
    description: string;
  };
  x402?: {
    price_usd: string;
    network: string;
    address: string;
    asset: string;
    scheme: string;
  };
  routed_model?: string;
  route_category?: string;
}

/** Wallet persistence format — v1 (Cashu only) */
export interface WalletDataV1 {
  version: 1;
  nsec: string;
  npub: string;
  mints: string[];
  /** Serialized proofs per mint URL */
  proofs: Record<string, SerializedProof[]>;
  createdAt: string;
  lastSyncAt: string | null;
}

/** Wallet persistence format — v2 (Cashu + EVM) */
export interface WalletDataV2 {
  version: 2;
  nsec: string;
  npub: string;
  evmPrivateKey: string;  // 0x-prefixed hex, 32 bytes
  evmAddress: string;     // 0x-prefixed checksummed address
  mints: string[];
  proofs: Record<string, SerializedProof[]>;
  createdAt: string;
  lastSyncAt: string | null;
}

/** Union — loadFromDisk() can return either */
export type WalletData = WalletDataV1 | WalletDataV2;

export interface SerializedProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
}

/** Mint balance info */
export interface MintBalance {
  url: string;
  sats: number;
}

/** Balance summary */
export interface BalanceSummary {
  total: number;
  perMint: MintBalance[];
  estimatedRequests: number;
}

/** Funding result */
export interface FundingResult {
  invoice: string;
  quoteId: string;
  mintUrl: string;
  amountSats: number;
}

/** x402 v2 Payment-Required header: single payment option from accepts[] */
export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;           // Pre-calculated atomic USDC (string, no float math needed)
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

/** x402 v2 envelope — decoded from base64 Payment-Required HTTP header */
export interface X402Envelope {
  x402Version: 2;
  error: string;
  accepts: X402PaymentRequirement[];
  resource: { url: string; description: string; mimeType: string };
  price: string;
}

/** Combined probe result — body + optional v2 header */
export interface ProbeResult {
  body: PaymentRequiredResponse;
  envelope: X402Envelope | null;
}

/** x402 payment payload sent via Payment-Signature header */
export interface X402PaymentPayload {
  x402Version: 2;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepted: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: { name: string; version: string };
  };
  payload: {
    signature: string;  // 0x-prefixed EIP-712 signature
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;    // 0x-prefixed bytes32
    };
  };
}
