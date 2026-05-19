import Config

config :blockball, BlockballWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: String.to_integer(System.get_env("PORT") || "4000")],
  check_origin: false,
  code_reloader: false,
  debug_errors: true,
  server: true

config :blockball, :wallet_auth,
  dev_auth_enabled: true,
  privy_app_id: "cmp4u9vgm00730cl55urjud3k",
  privy_client_id: "client-WY6ZNDFiBKy1932hhey31XMCWZbFwiZutWFoMYiQs9gKd"

config :logger, :console, format: "[$level] $message\n"

config :blockball, :ranked_receipts,
  chain_id: 31_337,
  contract_address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  signer_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

config :blockball, :user_registry,
  chain_id: 11_155_111,
  contract_address:
    System.get_env("BLOCKBALL_USER_REGISTRY_CONTRACT") ||
      "0xCCce9E12Cf11F1a2754625EeC66843E1edC084b9"
