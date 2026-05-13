import Config

config :blockball, BlockballWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [html: BlockballWeb.ErrorHTML, json: BlockballWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Blockball.PubSub,
  secret_key_base: "fjwIcy8VypEpQ0xTpvo9ZBTjHgP4MsCpahdVQ9BDzvh5ry1uIB3OSzXB38UYn1kk"

config :phoenix, :json_library, Jason

import_config "#{config_env()}.exs"
