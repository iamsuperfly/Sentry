import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseEther,
  parseUnits,
  type Hash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config";
import { decryptPrivateKey } from "./wallet-crypto";

export const TUSDC_ADDRESS = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as const;
const tusdcAbi = [
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const chain = (config: AppConfig) => ({
  id: 50312 as const,
  name: "Somnia Shannon" as const,
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

const account = (privateKey: string) =>
  privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`);

export function createWallet() {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

function client(config: AppConfig) {
  return createPublicClient({ chain: chain(config), transport: http(config.rpcUrl) });
}

export async function balances(config: AppConfig, address: string) {
  if (!isAddress(address)) throw new Error("Invalid wallet address.");
  const publicClient = client(config);
  const [stt, tusdc] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: TUSDC_ADDRESS,
      abi: tusdcAbi,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  return { stt: formatEther(stt), tusdc: formatUnits(tusdc, 6) };
}

export async function sponsor(config: AppConfig, destination: string) {
  if (!isAddress(destination)) throw new Error("Invalid destination wallet.");
  const treasury = account(config.treasuryPrivateKey);
  const publicClient = client(config);
  const amount = parseEther(config.initialGasSponsorAmount);
  const gasPrice = await publicClient.getGasPrice();
  const gas = await publicClient.estimateGas({ account: treasury, to: destination, value: amount });
  const treasuryBalance = await publicClient.getBalance({ address: treasury.address });
  if (treasuryBalance < amount + gas * gasPrice) throw new Error("Treasury has insufficient STT.");
  const walletClient = createWalletClient({
    account: treasury,
    chain: chain(config),
    transport: http(config.rpcUrl),
  });
  const hash = await walletClient.sendTransaction({ account: treasury, to: destination, value: amount });
  return { hash, from: treasury.address };
}

export async function faucet(config: AppConfig, encryptedPrivateKey: string) {
  const amount = parseUnits(config.initialTusdcFaucetAmount, 6);
  if (amount <= 0n || amount > parseUnits("10000", 6)) {
    throw new Error("Faucet amount must be greater than zero and no more than 10,000 tUSDC.");
  }
  const user = account(decryptPrivateKey(config, encryptedPrivateKey));
  const publicClient = client(config);
  const gasPrice = await publicClient.getGasPrice();
  const gas = await publicClient.estimateContractGas({
    account: user,
    address: TUSDC_ADDRESS,
    abi: tusdcAbi,
    functionName: "faucet",
    args: [amount],
  });
  if ((await publicClient.getBalance({ address: user.address })) < gas * gasPrice) {
    throw new Error("User wallet has insufficient STT.");
  }
  const walletClient = createWalletClient({ account: user, chain: chain(config), transport: http(config.rpcUrl) });
  const hash = await walletClient.writeContract({
    account: user,
    address: TUSDC_ADDRESS,
    abi: tusdcAbi,
    functionName: "faucet",
    args: [amount],
  });
  return { hash, from: user.address };
}

export async function receipt(config: AppConfig, hash: Hash) {
  const result = await client(config).waitForTransactionReceipt({ hash, timeout: 120_000 });
  return { status: result.status === "success" ? "confirmed" : "failed", blockNumber: Number(result.blockNumber) };
}

export function explorer(config: AppConfig, hash: string) {
  return `${config.explorerTxBaseUrl.replace(/\/$/, "")}/${hash}`;
}