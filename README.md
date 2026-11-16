# SolSift

Scans newly launched Solana tokens, screens them for rug-pull mechanics, scores each one 0-100, and keeps a public record of how its own scores turned out.

- **Scanner** (`scanner/`): a dependency-free Node.js script that runs every 5 minutes on GitHub Actions (GitHub's minimum; real cadence is often slower).
- **Website** (`site/`): a static page on GitHub Pages that lists the scored tokens and lets a visitor connect a wallet and buy or sell through Jupiter, non-custodially.
- **Learning loop**: every score is re-checked 1, 6 and 24 hours later; the outcomes train a small model that gradually takes a share of the score.
- **Live launches**: the page itself polls Jupiter every 5 seconds and scores brand-new tokens in the browser with the scanner's own rules.
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

## Two feeds

| Feed | Freshness | What has been checked |
|---|---|---|
| Scored feed | each full scan (minutes) | everything: on-chain risk report, LP lock, socials, sell route, trend fit, learned model |
| Live launches | 5 seconds | only what Jupiter reports: authorities, holder and developer share, snipers and insiders, liquidity, trades, organic score |

The live feed runs entirely in the visitor's browser (`site/app.js` imports `scanner/normalize.js` and `scanner/score.js`), so a live score is a first impression, not the full verdict. Tokens seconds old are nearly always capped as high risk: thin liquidity and no track record is exactly what high risk means. The live feed pauses while the tab is in the background and backs off if Jupiter rate-limits the visitor.

Both feeds can be filtered by platform (pump.fun, Raydium, Meteora, LetsBonk and whatever else appears), by stage (on the bonding curve or graduated), by age, by minimum score, and, for the scored feed, by tokens promoted on DEX Screener.

## Buying and selling

The site talks to Jupiter's Swap API V2 directly (`site/trade.js`); there is no third-party script on the page.

- **Connect** Phantom, Solflare, Backpack or any other Wallet Standard wallet. The site only receives the public address.
- **Buy** buttons (0.1 / 0.3 / 0.5 / 1 SOL by default, editable, plus a custom amount) ask Jupiter for a quote and an unsigned transaction, hand it to the wallet, and send the signed result back to Jupiter to land it. The wallet shows the transaction and nothing happens without approval there.
- **Sell** buttons sell 25 / 50 / 75 / 100% of the balance. The **My tokens** tab lists every token in the wallet, so positions stay sellable after they leave the feeds.
- **Settings**: slippage (Auto or fixed), priority fee (Auto or fixed, capped at 0.05 SOL), buy amounts, a price-impact prompt, and a prompt before buying flagged tokens.
- Jupiter charges its own fee on each swap (shown as `feeBps` in its quote).

The site never holds a private key, so every trade needs the wallet's approval. Wallets that offer auto-approval for trusted sites can remove that click; that is a wallet setting, not something this code does. There is deliberately **no automated trading with real funds** in this repository: that would mean storing a private key, and the scores have no track record yet.

The swap path was tested end to end against a mock wallet with the send step stubbed. It has not been exercised with a real wallet and real funds by the author, so start with a small amount.

## Your own filters

**My filters** on the token list sets limits on the same measurements the score uses, and hides everything that breaks one: top-10 holder share, developer share, snipers, insiders and bundles, holder count, creator's launch count, liquidity, market cap range, hourly volume and trades, buy share, age, organic score, LP lock, X account age and followers, Telegram size, plus switches such as "mint authority revoked" and "no red flags". Filters are saved in the browser. Measurements that only exist after a full scan are marked and ignored in the live feed.

## Your paper bot

The **Paper bot** tab runs a simulated portfolio in the browser (`site/paperbot.js`) with rules you set, and shows them in plain language:

- **Buy rules**: which feed it watches (scored, live or both), a minimum score, whether hard red flags are allowed, and any of the same limits and switches as My filters (top-10 share, developer share, snipers, liquidity, market cap, age, organic score and so on). Every rule must be true.
- **Sell rules**: take profit and stop loss (judged after costs), trailing stop, time limit, a hard red flag appearing, the score falling below a level, liquidity dropping by a percentage. The first one that triggers closes the position. A position with no price for 15 minutes is counted as a total loss.
- **Sizing**: paper money per buy, maximum open positions, the cost charged per side, starting balance.

Each position records why it was bought and why it was sold, and the stats break results down by exit reason. The bot never buys at a stale price: it fetches a fresh one first. It runs while the page is open (and keeps managing open positions in a background tab), samples prices about every 10 seconds, and assumes no price impact, so real results on thin pools will be worse. It cannot sign or send anything; each open position has a Buy button if you want to make the same trade yourself through your wallet.

The scanner keeps its own fixed-rule paper bot (`scanner/paper.js`) as a public scoreboard, shown on the Bot performance tab.

## Live history and storage

The live feeds only ever return the newest ~30 tokens, so `site/livestore.js` remembers the ones worth a second look:

- Tokens that pass your filters, or score 45+, are **keepers**: held for up to 12 hours and refreshed in the background.
- Everything else is dropped 20 minutes after it leaves the feed.
- One compact record per token (about 1 KB). At most 5,000 tokens in memory and at most 800 keepers / 1.2 MB in `localStorage`, so a reload restores the list. Settings shows current usage and has a clear button.

## Run it yourself

Requires Node.js 20 or newer. No dependencies to install.

On Windows, double-click **Start SolSift.bat**. Otherwise:

```bash
npm run serve -- --open
```

The local launcher (`scripts/serve.js`):

- serves the site at http://localhost:4173, reachable from this machine only;
- runs the full scanner immediately and then every 5 minutes, so the scored feed does not depend on GitHub's scheduler;
- if `.env` contains `JUPITER_API_KEY=...` (copy `.env.example`), proxies Jupiter requests through `/jup/*` and attaches the key on the server side. The key never reaches the browser, the public site or the repository.

Other commands:

```bash
npm test
```

```bash
npm run scan
```

To give the GitHub Actions scanner the same key, add it as a repository secret named `JUPITER_API_KEY`. Never put an API key in the site's code: anything served to a browser is public.

## Deployment

`.github/workflows/scan.yml` runs on a 5-minute schedule, on manual dispatch and on pushes to `main`. Each run restores state from the orphan `data` branch, scans, force-pushes the new state back to `data`, then builds and deploys the site to GitHub Pages. Keeping state on a branch that is overwritten each run stops the repository growing without bound.

Things to know:

- GitHub delays scheduled workflows under load and can skip runs. The site shows the age of the last scan.
- GitHub disables scheduled workflows in public repositories after 60 days without repository activity. Re-enable it from the Actions tab if that happens.
- All data sources are free and keyless and can change or rate-limit without notice. Each one is optional: a failed source lowers confidence rather than breaking the run. `datapi.jup.ag` is an undocumented Jupiter endpoint and the most likely to break.

## Data sources

Jupiter Tokens API and Swap API, DEX Screener, GeckoTerminal, RugCheck, Raydium LaunchLab, FxTwitter, Telegram public previews, and RDAP. Swaps by Jupiter Ultra. Powered by Jupiter.

## Layout

```
scanner/index.js    one scan run, start to finish
scanner/sources.js  discovery and enrichment APIs
scanner/normalize.js  raw API objects -> one sanitised token record (also runs in the browser)
scanner/math.js     numeric helpers (also runs in the browser)
scanner/social.js   X, Telegram and domain-age lookups
scanner/score.js    hard gates, weighted components, feature vector
scanner/trends.js   narrative and keyword detection
scanner/learn.js    outcome labels, logistic regression, calibration
scanner/paper.js    simulated portfolio
site/app.js         page logic: feeds, filters, drawer, settings
site/trade.js       wallet connection (Wallet Standard) and Jupiter swaps
site/userfilters.js your own filter limits
site/livestore.js   capped live-launch history
site/paperbot.js    your rule-driven paper bot
scripts/serve.js    local launcher: site, scanner loop, private API-key proxy
test/               unit tests
```

## License

MIT
