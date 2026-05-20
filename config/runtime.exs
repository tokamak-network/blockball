import Config

# Auto-load project-root .env so `mix phx.server` works without manual
# sourcing. The file is gitignored — used for local dev secrets like the
# Sepolia RPC URL and UserRegistry submitter private key. Existing env
# vars win over .env values so CI/prod overrides keep working.
dotenv_path = Path.expand("../.env", __DIR__)

if File.exists?(dotenv_path) do
  strip_quotes = fn value ->
    cond do
      String.length(value) >= 2 and String.starts_with?(value, "\"") and
          String.ends_with?(value, "\"") ->
        String.slice(value, 1..-2//1)

      String.length(value) >= 2 and String.starts_with?(value, "'") and
          String.ends_with?(value, "'") ->
        String.slice(value, 1..-2//1)

      true ->
        value
    end
  end

  dotenv_path
  |> File.stream!()
  |> Enum.each(fn raw ->
    line = raw |> String.trim() |> String.replace_prefix("export ", "")

    case line do
      "" ->
        :ok

      "#" <> _ ->
        :ok

      kv ->
        case String.split(kv, "=", parts: 2) do
          [k, v] ->
            key = String.trim(k)
            value = v |> String.trim() |> strip_quotes.()

            if System.get_env(key) in [nil, ""] do
              System.put_env(key, value)
            end

          _ ->
            :ok
        end
    end
  end)
end

if System.get_env("PHX_SERVER") do
  config :blockball, BlockballWeb.Endpoint, server: true
end

if config_env() == :prod do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"
  port = String.to_integer(System.get_env("PORT") || "4000")

  config :blockball, BlockballWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      ip: {0, 0, 0, 0, 0, 0, 0, 0},
      port: port
    ],
    secret_key_base: secret_key_base
end
