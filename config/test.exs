import Config

config :blockball, BlockballWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  server: false

config :logger, level: :warning

config :blockball, :ranked_receipts,
  chain_id: 31_337,
  contract_address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  signer_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
