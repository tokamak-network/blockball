defmodule BlockballWeb.Router do
  use BlockballWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", BlockballWeb do
    pipe_through :browser

    get "/", PageController, :home
    get "/signup", PageController, :home
    get "/play", PageController, :home
    get "/play/casual", PageController, :home
    get "/play/ranked", PageController, :home
    get "/play/casual/:room_id", PageController, :home
    get "/play/ranked/:room_id", PageController, :home
    get "/play/:room_id", PageController, :home
    get "/lobby", PageController, :home
    get "/lobby/:mode", PageController, :home
    get "/profile", PageController, :home
    get "/players", PageController, :home
  end

  scope "/api", BlockballWeb do
    pipe_through :api

    get "/rooms", LobbyController, :list
    post "/rooms", LobbyController, :create
    post "/wallet/challenge", WalletAuthController, :challenge
    post "/wallet/lookup", WalletAuthController, :lookup
    post "/wallet/register", WalletAuthController, :register
    post "/wallet/update-nickname", WalletAuthController, :update_nickname
    post "/wallet/me", WalletAuthController, :me
    post "/wallet/players", WalletAuthController, :players
  end
end
