defmodule BlockballWeb.UserSocket do
  use Phoenix.Socket

  alias Blockball.Util

  channel "room:*", BlockballWeb.RoomChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    {:ok, assign(socket, :client_id, "p-" <> Util.random_id(9))}
  end

  @impl true
  def id(socket), do: "player_socket:#{socket.assigns.client_id}"
end
