defmodule BlockballWeb.LobbyController do
  use BlockballWeb, :controller

  alias Blockball.Game

  def list(conn, _params) do
    rooms = Game.list_rooms() |> Enum.map(&public_view/1)
    json(conn, %{rooms: rooms})
  end

  def create(conn, params) do
    name = Map.get(params, "name", "") |> to_string()
    mode = parse_mode(Map.get(params, "mode", "vs2"))
    # Casual is the default; ranked is opt-in. Practice rooms are forced casual server-side.
    ranked = parse_bool(Map.get(params, "ranked", false)) and mode != :practice

    case Game.create_room(name, mode, ranked) do
      {:ok, room_id, _pid} ->
        json(conn, %{
          ok: true,
          room_id: room_id,
          mode: Atom.to_string(mode),
          ranked: ranked
        })

      _ ->
        conn |> put_status(422) |> json(%{ok: false})
    end
  end

  defp parse_mode("practice"), do: :practice
  defp parse_mode("vs1"), do: :vs1
  defp parse_mode("vs2"), do: :vs2
  defp parse_mode("vs3"), do: :vs3
  defp parse_mode("vs4"), do: :vs4
  defp parse_mode("public"), do: :vs4
  defp parse_mode(_), do: :vs2

  defp parse_bool(true), do: true
  defp parse_bool("true"), do: true
  defp parse_bool("1"), do: true
  defp parse_bool("on"), do: true
  defp parse_bool(_), do: false

  defp public_view(meta) do
    %{
      id: meta.id,
      name: meta.name,
      mode: meta.mode,
      ranked: Map.get(meta, :ranked, false),
      capacity: meta.capacity,
      player_count: meta.player_count,
      status: meta.status,
      created_at: meta.created_at,
      has_password: false
    }
  end
end
