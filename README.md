# SolSift

Scans newly launched Solana tokens, screens them for rug-pull mechanics, scores each one 0-100, and keeps a public record of how its own scores turned out.

- **Scanner** (`scanner/`): a dependency-free Node.js script that runs every 15 minutes on GitHub Actions.
- **Website** (`site/`): a static page on GitHub Pages that lists the scored tokens and lets a visitor buy one with their own wallet through the Jupiter plugin.
- **Learning loop**: every score is re-checked 1, 6 and 24 hours later; the outcomes train a small model that gradually takes a share of the score.
- **Paper bot**: a simulated portfolio that "buys" the high scores, so the scoring has to prove itself before anyone trusts it with money.

> **Not financial advice.** Published studies put pump.fun graduation rates at roughly 0.5-2%, and one found about 76% of DEX-listed Solana tokens rugged within 24 hours. A good filter still leaves most picks losing. The site never holds funds or keys: swaps are signed in the visitor's own wallet via Jupiter Ultra (Powered by Jupiter). Jupiter's terms exclude some jurisdictions, including the United States.

## How a scan works

1. **Discover** about 400 candidate mints from Jupiter (recent, trending, top organic, top traded, launchpad "gems"), DEX Screener (paid profiles, boosts, community takeovers), GeckoTerminal (new and trending pools) and Raydium LaunchLab.
2. **Track** them across runs. Most feeds only reach back a few minutes, so mints are remembered and re-checked; anything with no traction after 30 minutes is dropped, and nothing older than 72 hours is shown.
3. **Enrich** tokens that have real activity with market data (Jupiter, DEX Screener), an on-chain risk report (RugCheck), and social lookups (X account age and followers, Telegram size, domain registration date).
4. **Score** each token (below), detect narratives, and probe the best candidates for a sell route.
5. **Learn**: record outcomes for earlier scores and re-fit the model.
6. **Publish** `tokens.json`, `trends.json`, `model.json` and `paper.json` to the site.

## The score

**Hard gates** cap the score regardless of anything else, and the learned model can never override them:

| Gate | Cap |
|---|---|
| Already marked rugged | 5 |
| Freeze authority active (honeypot mechanic) | 12 |
| Token-2022 permanent delegate, transfer hook, non-transferable, default-frozen, pausable | 12 |
| Mint authority active; transfer fee above 5% | 15 |
| Liquidity under $1k; one wallet above 30% (confirmed by the risk engine); over half the supply bundled; creator with a rug history | 15 |
| Large share of LP unlocked | 22 |
| Top 10 holders above 70% | 25 |
| No sell route on Jupiter; serial deployer with 100+ launches and no graduations | 30 |
| Liquidity under $5k | 32 |

**Weighted components**:

| Component | Weight | Main inputs |
|---|---|---|
| Safety and distribution | 35 | authorities, top-10 share, developer share, LP lock, snipers/insiders/bundles, RugCheck risk score, creator track record |
| Market health | 20 | liquidity depth, liquidity vs market cap, age (median time-to-rug is about 35 minutes) |
| Organic momentum | 25 | trade count, buy/sell balance, average trade size, trades per wallet, turnover, volume persistence, holders, Jupiter organic score |
| Social credibility | 10 | X account age, followers and follower growth rate, whether the account mentions the token, Telegram size, domain age, links reused across tokens |
| Trend fit | 10 | whether the token belongs to a narrative that is attracting volume now |

Unknown data always scores below neutral: a missing data point is never treated as good news. Red flags that are not hard gates (wash-trading tells, a large X account that never mentions the token, a reused token image, a duplicated ticker) each cost 5 points.

Verdicts: 75+ Strong, 60+ Promising, 45+ Speculative, 25+ Weak, below that Avoid. Gated tokens show as High risk or Likely rug.

The thresholds are priors taken from published risk tables and research (Solidus Labs, SolRugDetector, MemeTrans, Pine Analytics, Solana Tracker, Mobula). None of them is outcome-validated, which is the reason for the learning loop.

## How it learns

- When a token is first scored, its 29-feature vector, price and liquidity are stored.
- At 1h, 6h and 24h the scanner records price and liquidity again. A token that has vanished from every feed is recorded as a failure, so survivors cannot flatter the results.
- A token "held up" if, after 24 hours, the price is at least half the discovery price and the pool kept its liquidity.
- Once there are 150 labelled outcomes with at least 15 winners and 15 losers, a class-weighted, L2-regularised logistic regression is fitted. It is tested on the most recent 20% of outcomes, which it has not seen.
- The model's share of the final score is `0.5 x skill x evidence`, where skill is how far out-of-sample AUC sits above 0.5 and evidence grows with sample count. A model that cannot beat a coin flip gets a share of zero.

The **Bot performance** tab shows the result: realised hold-up rate per score bucket, what the model weights, and the paper portfolio.

## Paper bot

Simulated money only. It never signs or sends a transaction.

- Starts with $1,000, stakes $50 per position, holds at most 10.
- Enters tokens scoring 70+ with no gates, at least $20k liquidity, older than 45 minutes.
- Exits at +100%, at -35%, when a rug flag appears, when liquidity drains, after 24 hours, or at -100% if the token vanishes.
- Charges 1.5% per side for fees and slippage. Prices are sampled once per scan, so real fills would be worse.

## Buying

The Buy button opens the [Jupiter plugin](https://plugin.jup.ag/) with SOL as input and the token fixed as output. The visitor connects Phantom, Solflare or Backpack and approves the transaction in the wallet. If the plugin fails to load, the button opens the same swap on jup.ag. Flagged tokens ask for confirmation first.

There is deliberately **no automated trading with real funds** in this repository. That would mean storing a private key in CI, and the scores have no track record yet.

## Run it yourself

Requires Node.js 20 or newer. No dependencies to install.

```bash
npm test
```

```bash
npm run scan
```

```bash
npm run serve
```

`npm run scan` writes `data/*.json`; `npm run serve` previews the site at http://localhost:4173.

Optional: set a free `JUPITER_API_KEY` (from the Jupiter developer portal) as an environment variable or repository secret to double the Jupiter rate limit.

## Deployment

`.github/workflows/scan.yml` runs on a 15-minute schedule, on manual dispatch and on pushes to `main`. Each run restores state from the orphan `data` branch, scans, force-pushes the new state back to `data`, then builds and deploys the site to GitHub Pages. Keeping state on a branch that is overwritten each run stops the repository growing without bound.

Things to know:

- GitHub delays scheduled workflows under load and can skip runs. The site shows the age of the last scan.
- GitHub disables scheduled workflows in public repositories after 60 days without repository activity. Re-enable it from the Actions tab if that happens.
- All data sources are free and keyless and can change or rate-limit without notice. Each one is optional: a failed source lowers confidence rather than breaking the run. `datapi.jup.ag` is an undocumented Jupiter endpoint and the most likely to break.

## Data sources

Jupiter Tokens API and Swap API, DEX Screener, GeckoTerminal, RugCheck, Raydium LaunchLab, FxTwitter, Telegram public previews, and RDAP. Swaps by Jupiter Ultra. Powered by Jupiter.

## Layout

```
scanner/index.js    one scan run, start to finish
scanner/sources.js  discovery and enrichment APIs, input sanitising
scanner/social.js   X, Telegram and domain-age lookups
scanner/score.js    hard gates, weighted components, feature vector
scanner/trends.js   narrative and keyword detection
scanner/learn.js    outcome labels, logistic regression, calibration
scanner/paper.js    simulated portfolio
site/               static front end
test/               unit tests
```

## License

MIT
