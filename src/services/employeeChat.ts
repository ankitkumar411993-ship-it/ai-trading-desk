import axios from "axios";
import { config } from "../config";
import { getLatestScanState } from "../state/latestScanState";

export type EmployeeId = "trend" | "liquidity" | "risk" | "portfolio" | "ceo";

const EMPLOYEE_PERSONAS: Record<EmployeeId, { title: string; weight: string; role: string }> = {
  trend: {
    title: "Trend Analyst",
    weight: "30% of the combined score",
    role: "You determine trend direction and quality using EMA9/EMA21 crossovers, separation, slope, and market structure (HH/HL/LH/LL).",
  },
  liquidity: {
    title: "Liquidity Analyst",
    weight: "30% of the combined score",
    role: "You detect smart-money liquidity events: sweeps, stop hunts, equal highs/lows, confirmed by volume spikes and rejection candles.",
  },
  risk: {
    title: "Risk Manager",
    weight: "20% of the combined score",
    role: "You protect capital: you grade trades A-F based on volatility (ATR), distance from the mean, and set stop-loss/position-size suggestions.",
  },
  portfolio: {
    title: "Portfolio Manager",
    weight: "used by the CEO to rank all contracts",
    role: "You scan every contract the desk tracks and rank the top opportunities by combined score (Trend 30% / Liquidity 30% / Risk 20% / Volume 10% / Structure 10%).",
  },
  ceo: {
    title: "CEO",
    weight: "final decision maker",
    role: "You receive reports from all four other employees and make the final call: 1 Primary trade + 2 Alternatives, or NO TRADE if nothing clears the bar (score ≥80, Risk grade A/B, confirmed liquidity sweep, volume confirmation, max one trade per coin family).",
  },
};

function buildContextForEmployee(employee: EmployeeId, symbol: string | undefined) {
  const state = getLatestScanState();

  switch (employee) {
    case "trend":
      return symbol ? state.trends.get(symbol) ?? null : null;
    case "liquidity":
      return symbol ? state.liquidity.get(symbol) ?? null : null;
    case "risk":
      return symbol ? state.risk.get(symbol) ?? null : null;
    case "portfolio":
      return { top20: state.rankings };
    case "ceo":
      return state.ceoReport;
  }
}

export interface ChatResult {
  employee: EmployeeId;
  symbol: string | null;
  answer: string;
}

/**
 * Answers a question "as" one of the 5 AI employees, using their real current analysis as the
 * only source of truth. The system prompt explicitly instructs the model to say so and decline
 * to speculate if the relevant data isn't available (e.g. no symbol selected yet, or this
 * employee genuinely has no opinion on a question that belongs to a different employee's role)
 * rather than inventing numbers that don't match what's on screen.
 */
export async function askEmployee(
  employee: EmployeeId,
  symbol: string | undefined,
  question: string
): Promise<ChatResult> {
  if (!config.anthropic.enabled) {
    throw new Error(
      "Chat isn't configured on this deployment. Set ANTHROPIC_API_KEY in the backend's environment variables to enable it."
    );
  }

  const persona = EMPLOYEE_PERSONAS[employee];
  const context = buildContextForEmployee(employee, symbol);

  const systemPrompt = `You are the ${persona.title} at an AI hedge-fund-style trading desk that scans Binance Futures perpetual contracts. ${persona.role} Your output feeds into ${persona.weight}.

You're answering a question from the desk's user, a real trader looking at your analysis on their dashboard right now. Speak in first person as this employee, in a concise, professional, trading-floor tone — a sentence or two for simple questions, a short paragraph at most for complex ones. No bullet-point essays.

CRITICAL — grounding rules:
- Below is your ACTUAL current analysis data (or null if none is available yet). This is the only source of truth you have. Never invent, estimate, or hallucinate numbers, scores, or reasoning that aren't in this data.
- If the data is null (e.g. no symbol selected, or you haven't analyzed this symbol yet), say so plainly and ask them to select a symbol first — don't make something up to seem helpful.
- If the question is really about a different employee's job (e.g. someone asks you, the Trend Analyst, about position sizing — that's the Risk Manager's call), say so and redirect them, briefly, rather than answering outside your role.
- Never give financial advice framed as a personal recommendation ("you should buy X") — describe what your analysis shows and let them decide, consistent with how the rest of this dashboard is written.

YOUR CURRENT DATA (symbol: ${symbol ?? "none selected"}):
${JSON.stringify(context, null, 2)}`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: config.anthropic.model,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: question }],
    },
    {
      headers: {
        "x-api-key": config.anthropic.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 30000,
    }
  );

  const answer = response.data.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();

  return { employee, symbol: symbol ?? null, answer: answer || "(no response)" };
}
