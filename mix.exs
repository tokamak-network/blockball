defmodule Blockball.MixProject do
  use Mix.Project

  def project do
    [
      app: :blockball,
      version: "0.1.0",
      elixir: "~> 1.18",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      mod: {Blockball.Application, []},
      extra_applications: [:logger, :runtime_tools, :inets, :ssl, :public_key]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_env), do: ["lib"]

  defp deps do
    [
      {:phoenix, "~> 1.8.5"},
      {:phoenix_html, "~> 4.3"},
      {:phoenix_pubsub, "~> 2.2"},
      {:phoenix_live_view, "~> 1.1"},
      {:jason, "~> 1.4"},
      {:jose, "~> 1.11"},
      {:ex_keccak, "~> 0.7.8"},
      {:ex_secp256k1, "~> 0.8.0"},
      {:bandit, "~> 1.10"}
    ]
  end
end
