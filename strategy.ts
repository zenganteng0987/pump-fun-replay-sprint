// Second-wave recovery bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: ignore launches entirely. Only trade coins that already survived their opening
// minutes (aged at least minAge slots), dipped, and are now being bought back up: the price
// has recovered a few percent off its recent low, the last few trades show fresh buyers
// stepping in with positive net SOL flow, and the price is still well below its longer
// high (so this is a recovery leg, not chasing a top). The creator must never have sold
// (a creator sale is a rug tell and disqualifies the coin for good).
//
// Positions are small and short-lived: one first buy, at most one add into strength, and
// a whole-position exit on take-profit, stop-loss, a trailing stop once the trade is up,
// a time limit, a creator sale, or one very large single sell. At most maxOpen coins are
// held at once and total cost exposure is capped, so a bad day cannot draw the account
// down far. One entry per coin per cooldown keeps the bot from re-buying the same rug.
//
// Deterministic by construction: every decision is a pure function of the batches the
// harness sends (insertion-ordered maps only, no clock, no randomness, no I/O), so the
// two graded executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Minimum age (slots since CreateEvent) before a coin may be bought. */
  minAge: number;
  /** Recent window (slots) for the recovery / flow read. */
  window: number;
  /** Price now must be at least this far above the window low (fraction). */
  recover: number;
  /** Price now must be at least this far below the long-window high (fraction). */
  belowHigh: number;
  /** Long window (slots) for the high the price must stay below. */
  highWindow: number;
  /** Buys in the recent window. */
  minBuys: number;
  /** Distinct buying wallets in the recent window. */
  minBuyers: number;
  /** Net SOL (buys minus sells) over the recent window. */
  minNetSol: number;
  /** The most recent trade on the coin must be a buy. */
  lastMustBeBuy: boolean;
  /** Real SOL reserve window at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** First buy (SOL) and the single add-on buy (SOL). */
  firstSol: number;
  addSol: number;
  /** Add only once price is this far above the first entry price (fraction). */
  addStep: number;
  /** Most SOL at cost in one position. */
  maxStakeSol: number;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit when close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then exit on a fall of this fraction from the best close value. */
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit at once on a single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Most positions open at once. */
  maxOpen: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

// Settings traded by main.ts. Tuned on the dev window with the local sim; see README.
export const DEFAULT_PARAMS: Params = {
  minAge: 500,
  window: 40,
  recover: 0.05,
  belowHigh: 0.05,
  highWindow: 500,
  minBuys: 3,
  minBuyers: 3,
  minNetSol: 0.1,
  lastMustBeBuy: true,
  minRqSol: 1,
  maxRqSol: 40,
  firstSol: 0.05,
  addSol: 0.1,
  addStep: 0.03,
  maxStakeSol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 0.15,
  stopLoss: 0.08,
  trailArm: 0.05,
  trail: 0.06,
  maxHold: 150,
  bigSellSol: 0.5,
  cooldown: 200,
  maxEntries: 1,
  maxOpen: 5,
  maxExposureSol: 0.5,
};

const LAMPORTS = 1e9;
/** Curve fee taken on each side (95 bps protocol + 30 bps creator fallback). */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  creatorSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  entryPrice: number;
  peakValue: number;
  invested: number;
  adds: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, creatorSold: false, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Price of a curve from reserves: virtual quote per virtual token. */
  const priceOf = (vq: bigint, vt: bigint): number =>
    vt === 0n ? 0 : Number(vq) / Number(vt);

  /** Entry read on a coin's tape at slot `now`. */
  const entryOk = (t: Tape, now: number, rqSol: number): boolean => {
    if (t.creatorSold) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    const highFrom = now - p.highWindow;
    let buys = 0;
    let net = 0;
    let low = Infinity;
    let high = 0;
    let lastBuy = false;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        if (tr.slot > highFrom && tr.price > high) high = tr.price;
        continue;
      }
      if (tr.price < low) low = tr.price;
      if (tr.slot > highFrom && tr.price > high) high = tr.price;
      if (tr.buy) {
        buys++;
        net += tr.sol;
        buyers.add(tr.user);
      } else {
        net -= tr.sol;
      }
      lastBuy = tr.buy;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (net < p.minNetSol) return false;
    if (p.lastMustBeBuy && !lastBuy) return false;
    if (low === Infinity || low <= 0) return false;
    const price = t.trades.length > 0 ? t.trades[t.trades.length - 1]!.price : 0;
    if (price <= 0) return false;
    if (price < low * (1 + p.recover)) return false;
    if (high > 0 && price > high * (1 - p.belowHigh)) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          traded.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      // Prune tapes: only the long high window plus a margin is ever read.
      const keep = p.highWindow + 5;
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: whole-position sells, one per coin per batch at most.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && t.creatorSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries and the single add-on into strength.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = Math.min(p.maxOpen, state.hello.caps.max_open_positions) - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entryOk(t, now, rqSol)) continue;
          want = Math.min(p.firstSol, p.maxStakeSol);
        } else {
          if (h.exiting || !h.filled || h.adds >= 1 || h.invested >= p.maxStakeSol - p.minBuySol) continue;
          if (price < h.entryPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS) continue;
          if (flow(t, now, p.window) < p.minNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.maxStakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            entryPrice: price,
            peakValue: 0,
            invested: amount,
            adds: 0,
            exiting: false,
            filled: false,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.adds++;
        }
      }
      return orders;
    },
  };
}
