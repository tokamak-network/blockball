# blockball contracts

Foundry workspace for Blockball's on-chain pieces. Currently houses `UserRegistry`,
the wallet ↔ (identifier, nickname) registry written by the server submitter when a
ranked player signs up. `BlockballReceipts` lives elsewhere for now.

## Layout

```
contracts/
├── foundry.toml
├── foundry.lock                  # dependency pins (committed)
├── lib/                          # forge-std + openzeppelin-contracts (gitignored)
├── src/UserRegistry.sol
├── script/DeployUserRegistry.s.sol
└── test/UserRegistry.t.sol
```

`lib/` is *not* committed — `forge build` re-installs the pinned versions from
`foundry.lock` on first run.

## Install

```sh
cd contracts
forge install                    # populates lib/ from foundry.lock
```

> ⚠️ `forge install <pkg>` walks up to the first git repo it finds and adds the
> dependency as a submodule there. If you run it from `contracts/` it will register
> the submodule in the **parent** repo. After adding a new dep, clean up with:
> ```
> git rm --cached .gitmodules <added-path>
> rm -f .gitmodules
> ```

## Test

```sh
forge build
forge test -vvv
```

All 17 tests should pass.

## Deploy to Ethereum Sepolia

1. Copy env template and fill in:
   ```sh
   cp .env.example .env
   # edit .env: SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, (optional) INITIAL_OWNER
   ```
2. Fund the deployer with Sepolia ETH (any public faucet).
3. Broadcast:
   ```sh
   set -a; source .env; set +a
   forge script script/DeployUserRegistry.s.sol:DeployUserRegistry \
     --rpc-url "$SEPOLIA_RPC_URL" \
     --broadcast \
     -vvvv
   ```
4. Copy the deployed address from the logs and set
   `BLOCKBALL_USER_REGISTRY_CONTRACT=0x…` in the app's runtime env (next session
   wires the Elixir side).

Etherscan verification is intentionally deferred to a later session.

## Notes

- `INITIAL_OWNER` should be the server submitter address that will sign
  `register` / `updateNickname` transactions — it's the same kind of role as
  `BLOCKBALL_RECEIPT_SUBMITTER_PRIVATE_KEY` for receipts.
- `UserRegistry` deliberately enforces only nickname **length** (2–18 bytes).
  Character policy and identifier hashing live in the server (next session).
