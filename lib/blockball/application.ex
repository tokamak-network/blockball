defmodule Blockball.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Phoenix.PubSub, name: Blockball.PubSub},
      {Registry, keys: :unique, name: Blockball.Game.Registry},
      {DynamicSupervisor, strategy: :one_for_one, name: Blockball.Game.RoomSupervisor},
      Blockball.Game.Leaderboard,
      Blockball.WalletAuth.Challenges,
      BlockballWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: Blockball.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    BlockballWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
