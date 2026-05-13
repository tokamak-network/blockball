defmodule Blockball.Game do
  @moduledoc """
  Facade for supervised realtime game rooms.
  """

  alias Blockball.Game.Room

  def join(room_id, player_id, name, opts \\ []) do
    room_id
    |> ensure_room(opts)
    |> GenServer.call({:join, player_id, name})
  end

  def leave(room_id, player_id) do
    if pid = lookup(room_id) do
      GenServer.cast(pid, {:leave, player_id})
    end

    :ok
  end

  def input(room_id, player_id, input) do
    if pid = lookup(room_id) do
      GenServer.cast(pid, {:input, player_id, input})
    end

    :ok
  end

  def reset(room_id) do
    if pid = lookup(room_id) do
      GenServer.cast(pid, :reset)
    end

    :ok
  end

  def start_match(room_id, player_id) do
    if pid = lookup(room_id) do
      GenServer.call(pid, {:start_match, player_id})
    else
      {:error, :no_room}
    end
  end

  def create_room(name, mode) when mode in [:practice, :vs1, :vs2, :vs3, :vs4] do
    room_id = random_id(6)
    pid = ensure_room(room_id, name: sanitize_name_for_room(name), mode: mode)
    {:ok, room_id, pid}
  end

  def list_rooms do
    Blockball.Game.Registry
    |> Registry.select([{{:"$1", :"$2", :"$3"}, [], [{{:"$1", :"$2"}}]}])
    |> Enum.map(fn {_id, pid} ->
      try do
        GenServer.call(pid, :meta, 250)
      catch
        :exit, _ -> nil
      end
    end)
    |> Enum.reject(&is_nil/1)
    |> Enum.sort_by(& &1.created_at, :desc)
  end

  def ensure_room(room_id, opts \\ []) do
    room_id = sanitize_room(room_id)

    case lookup(room_id) do
      nil ->
        spec = %{
          id: {Room, room_id},
          start: {Room, :start_link, [{room_id, opts}]},
          restart: :transient
        }

        case DynamicSupervisor.start_child(Blockball.Game.RoomSupervisor, spec) do
          {:ok, pid} -> pid
          {:error, {:already_started, pid}} -> pid
        end

      pid ->
        pid
    end
  end

  def via(room_id), do: {:via, Registry, {Blockball.Game.Registry, sanitize_room(room_id)}}

  def sanitize_room(room_id) do
    room_id
    |> to_string()
    |> String.replace(~r/[^A-Za-z0-9-]/, "")
    |> String.slice(0, 12)
    |> String.upcase()
    |> case do
      "" -> random_id(5)
      room -> room
    end
  end

  def sanitize_name(name) do
    name
    |> to_string()
    |> String.replace(~r/[^\w .-]/u, "")
    |> String.trim()
    |> String.slice(0, 18)
    |> case do
      "" -> "Player #{random_id(4)}"
      value -> value
    end
  end

  def sanitize_name_for_room(name) do
    name
    |> to_string()
    |> String.replace(~r/[^\w .-]/u, "")
    |> String.trim()
    |> String.slice(0, 28)
    |> case do
      "" -> "Untitled Room"
      value -> value
    end
  end

  defp lookup(room_id) do
    case Registry.lookup(Blockball.Game.Registry, sanitize_room(room_id)) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  defp random_id(length) do
    length
    |> :crypto.strong_rand_bytes()
    |> Base.url_encode64(padding: false)
    |> String.slice(0, length)
    |> String.upcase()
  end
end
