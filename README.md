# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/zenganteng0987/pump-fun-replay-sprint/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/zenganteng0987/pump-fun-replay-sprint/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Paper-money trading bot (10 SOL, no real funds) for the pump.fun bonding-curve replay
(`agent-fun/replay/v2`). The grader runs `node main.ts`; the strategy lives in
`strategy.ts` and the SDK shim is the kit's `sdk/ts/makefun-bot.ts`, vendored byte for
byte as `vendor/makefun-bot.ts`.

## Strategy: second-wave recovery on seasoned coins

Launches are ignored entirely. A coin becomes a buy only once it has survived its
opening minutes (age ≥ 500 slots) and is being bought back up: price ≥ 5% above its
40-slot low, still within 5% of its 500-slot high (a breakout leg, not chasing a top),
≥ 3 buys from ≥ 3 distinct wallets with ≥ 0.1 SOL net inflow over the window, last
trade a buy, real SOL reserve 1–40 SOL, and the creator must never have sold.

Positions are small and short-lived: a 0.05 SOL first buy, at most one 0.10 SOL
add-on into strength (price +3% and still flowing in), max 0.15 SOL per coin and
0.5 SOL total exposure across at most 5 open positions. The whole position exits on
take-profit +15%, stop-loss −8%, a 6% trailing stop once up 5%, a 150-slot time
limit, a creator sale, or one single sell ≥ 0.5 SOL. One entry per coin per run
(cooldown 200 slots after an exit).

The bot is deterministic: every decision is a pure function of the batches the
harness sends (no clock, no randomness, no I/O), so the two graded executions
produce byte-identical action logs.

## Dev-window backtest (local sim, full 24 h dev window, all 3 dataset parts)

Final settings (`DEFAULT_PARAMS` in `strategy.ts`), graded with the kit's own
`grade-local` (`--driver process`, two executions, L1 regrade reproduced byte for
byte — deterministic):

- **Net PnL: −0.045529 SOL** (−45,529,114 lamports; 90% interval −0.170 … +0.087 SOL)
- Fills: 119 · Coins traded: 50 · Round trips: 50 · Win rate: 24% · Max drawdown: 1.30%
- Rejected orders: 0 · Failed txs: 0 · Fees: 0.1039 SOL curve + 0.0125 SOL tx
- At 2x fees: −0.160219 SOL · Top 3 coins made 61% of the gains; without them −0.14 SOL
- Guardrails: 50 distinct coins ≥ 20 required, each round trip ≥ 0.01 SOL; max
  drawdown 1.30% ≤ 50% — met.
- result_sha256: `deed173ac193f58cd7be823d22b87bdebdd197c0015ff9285a648107e54c8265`
  (process driver on Node v24.22.1; the server runs Node v26.13.1, so its
  result_sha256 will differ — the score itself is what matters)
- The local sim agrees within 0.001 SOL (net −0.046374 SOL, 117 fills, 2 failed
  txs under its own fail-draw seed).

Variant comparison (same sim, full dev window):

| Variant | Net PnL (SOL) | Coins | Trips | Wins | Drawdown |
| --- | --- | --- | --- | --- | --- |
| V1: dip-recovery, age ≥ 200, TP +10%, hold 400 | −0.2109 | 69 | 69 | 14 | 2.19% |
| V1 + TP +15%, hold 150 | −0.1905 | 69 | 69 | 12 | 1.90% |
| Breakout tilt (near high, recover 8%) | −0.1394 | 75 | 75 | 18 | 1.60% |
| + age ≥ 500, recover 5%, net flow ≥ 0.1 SOL | −0.0558 | 50 | 50 | 13 | 1.10% |
| **Final: + add 0.10 SOL, max stake 0.15 SOL** | **−0.0464** | **50** | **50** | **12** | **1.27%** |

Reference pilots on the same full window (kit baselines, for context only —
this strategy was written independently): momentum −9.66 SOL (DD 97%),
reversion −4.08 SOL (DD 49%), sniper −0.49 SOL (DD 5.3%).

Honest note: the dev window is unforgiving — every pilot and every variant of this
bot loses a little after fees, and the per-quartile PnL swings from −0.055 to
+0.042 SOL, so the dev score leans on which coins the window holds. This entry is
the least-bad shape found: small, fast, selective, and it preserves capital
(1.27% drawdown) while clearing the guardrails with margin.
