import Config

config :blockball, BlockballWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: String.to_integer(System.get_env("PORT") || "4000")],
  check_origin: false,
  code_reloader: false,
  debug_errors: true,
  server: true

config :blockball, :wallet_auth, dev_auth_enabled: true

config :logger, :console, format: "[$level] $message\n"
