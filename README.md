# blockball MVP

blockball is a Phoenix-based web MVP for testing the Tokamak Games thesis:

> Keep real-time gameplay on fast Web2 servers, then put the competitive meta-game layer on Tokamak L2.

The game is a HaxBall-like 2D physics sports prototype. It does not use HaxBall code, assets, maps, or branding.

## Why Phoenix

Phoenix is a better fit for this MVP than a single Node server because the core product needs room-based realtime sessions, server-authoritative state, supervision, restartability, and a clean path toward accounts, persisted rankings, tournament workflows, and chain indexer jobs.

This MVP uses:

- Phoenix Endpoint and Channels for realtime browser communication
- OTP GenServer rooms for authoritative physics and match lifecycle
- A supervised in-memory leaderboard Agent
- Static Canvas UI served by Phoenix
- Raw Phoenix socket protocol in the browser, so no asset bundler is required for the MVP
- A pre-play account gate for Privy embedded wallets and injected external wallets

## Run

```bash
mix deps.get
mix phx.server
```

Open:

```text
http://localhost:4000
```

Open the same room in several browser tabs to play up to 4v4. If only one human joins, a lightweight practice bot fills the opposing side.

## Wallet Login

Ranked players must register a wallet before joining a ranked room. Casual rooms remain nickname-only. The MVP supports:

- Privy email OTP login with embedded Ethereum wallet creation
- Injected browser wallets such as MetaMask, Rabby, and Coinbase Wallet
- Local dev account fallback in `config/dev.exs`

Set these environment variables to enable the Privy path:

```bash
export PRIVY_APP_ID="your-privy-app-id"
export PRIVY_CLIENT_ID="your-privy-client-id"
export PRIVY_VERIFICATION_KEY="your-privy-access-token-verification-key"
export WALLETCONNECT_PROJECT_ID="optional-future-walletconnect-id"
```

Ranked Privy joins fail closed unless the backend can verify the Privy access token
(or local development explicitly enables the dev auth bypass). External wallets use a
server-issued, single-use registration challenge before `personal_sign`.

The current static frontend uses Privy's vanilla Core SDK from `PRIVY_SDK_URL` or `https://esm.sh/@privy-io/js-sdk-core@latest?bundle`. A later bundled React client can swap this for `@privy-io/react-auth` plus RainbowKit/WalletConnect without changing the game server room flow.

## Controls

- Move: `WASD` or arrow keys
- Kick (charge + fire on contact): `Space` or `Shift`
- Dribble: touch the ball without holding the kick key

Hold the kick key before you touch the ball. The ball fires on contact, in the direction from your player to the ball. Without holding kick, touching the ball just pushes it forward so you can dribble.

## MVP Scope

- Phoenix Channel room create / join
- Server-authoritative 2D physics — HaxBall-equivalent mechanics, clean-room implementation
- Up to 4v4 public rooms or solo practice against a bot
- 2-minute matches with score, timer, and automatic reset
- In-memory season leaderboard
- Ranked EIP-712 match receipts with replay hash, verified wallet arrays, and server signature

## Deliberate Non-Scope

- No token, NFT, wallet, betting, or P2E loop
- No durable receipt outbox yet; if configured RPC submission fails, clients receive a permissionless fallback payload
- No production anti-cheat
- No persistent database yet

## Next Validation Steps

1. Tune movement, kick charge, and arena physics until the loop is fun.
2. Persist player profiles and ranked receipt outbox/retry state.
3. Configure RPC submission to a Tokamak testnet `BlockballReceipts` deployment.
4. Add smart wallet gas sponsorship / paymaster transaction flows.
5. Add tournament escrow only after legal and platform risk review.
