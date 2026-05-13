defmodule BlockballWeb.UserSocket do
  use Phoenix.Socket

  channel "room:*", BlockballWeb.RoomChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    {:ok, assign(socket, :client_id, "p-" <> random_id(9))}
  end

  @impl true
  def id(socket), do: "player_socket:#{socket.assigns.client_id}"

  defp random_id(length) do
    length
    |> :crypto.strong_rand_bytes()
    |> Base.url_encode64(padding: false)
    |> String.slice(0, length)
  end
end
