export type ClaimAttemptView = {
  symbol: string;
  direction: string;
  status: "claimed" | "skipped" | "failed";
  reason: string;
  payoutEstimate?: number | null;
  transactionHash?: string;
  marketId?: string;
};

function formatClaimLine(
  a: ClaimAttemptView & { marketId?: string },
  explorerTxBaseUrl?: string,
): string {
  const head = `${a.symbol} ${a.direction.toUpperCase()}`;
  const lines = [`${head}`];
  if (a.marketId) lines.push(`   Market ID: ${a.marketId}`);
  lines.push(`   Status: claimed`);
  if (a.payoutEstimate != null) {
    lines.push(`   Payout: ${a.payoutEstimate} tUSDC`);
  }
  if (a.transactionHash && explorerTxBaseUrl) {
    const href = `${explorerTxBaseUrl.replace(/\/$/, "")}/${a.transactionHash}`.replace(/&/g, "&");
    lines.push(`   <a href="${href}">View transaction</a>`);
  }
  return lines.join("\n");
}

export function formatClaimMessage(
  attempts: ClaimAttemptView[],
  explorerTxBaseUrl?: string,
): string {
  const claimed = attempts.filter((a) => a.status === "claimed");
  if (claimed.length === 0) {
    return "No new claims.";
  }
  return [
    claimed.length === 1 ? "Claimed 1 position" : `Claimed ${claimed.length} positions`,
    "",
    ...claimed.map((a, i) => `${i + 1}. ${formatClaimLine(a, explorerTxBaseUrl)}`),
  ].join("\n");
}

export type EarlyExitAttemptView = {
  marketId: string;
  symbol?: string;
  direction?: string;
  status: "exited" | "held" | "failed";
  pnl?: number;
  proceeds?: number;
};

export function formatEarlyExitMessage(
  attempts: EarlyExitAttemptView[],
): string | null {
  const notable = attempts.filter((a) => a.status === "exited" || a.status === "failed");
  if (notable.length === 0) return null;
  return [
    "Position management",
    "",
    ...notable.map((a, i) => {
      const market = a.symbol?.trim() || "Market";
      const dir = a.direction ? ` ${a.direction.toUpperCase()}` : "";
      if (a.status === "exited") {
        const pnl =
          a.pnl !== undefined && Number.isFinite(a.pnl)
            ? `\n   PnL: ${a.pnl > 0 ? "+" : ""}${a.pnl} tUSDC`
            : "";
        const proceeds =
          a.proceeds !== undefined && Number.isFinite(a.proceeds)
            ? `\n   Proceeds: ${Math.round(a.proceeds * 1e6) / 1e6} tUSDC`
            : "";
        return `${i + 1}. ${market}${dir} closed early${proceeds}${pnl}`;
      }
      return `${i + 1}. ${market}${dir} could not be closed right now. Position left open.`;
    }),
  ].join("\n");
}
