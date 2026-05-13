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
    get "/play/:room_id", PageController, :home
    get "/lobby", PageController, :home
  end

  scope "/api", BlockballWeb do
    pipe_through :api

    get "/rooms", LobbyController, :list
    post "/rooms", LobbyController, :create
  end
end
