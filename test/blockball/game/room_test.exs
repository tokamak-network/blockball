defmodule Blockball.Game.RoomTest do
  use ExUnit.Case, async: false

  alias Blockball.Game

  test "first player joins a live practice room with a bot" do
    {:ok, reply} =
      Game.join(
        "practice-#{System.unique_integer([:positive])}",
        "player-1",
        "Alice",
        mode: :practice
      )

    assert reply.spectator == false
    assert reply.team == :red
    assert reply.snapshot.match.status == "live"
    assert Enum.any?(reply.snapshot.players, & &1.is_bot)
  end

  test "second player creates a human team room and removes the practice bot" do
    room = "duel-#{System.unique_integer([:positive])}"

    {:ok, _first} = Game.join(room, "player-1", "Alice")
    {:ok, second} = Game.join(room, "player-2", "Bob")

    assert second.spectator == false
    assert second.team == :blue
    refute Enum.any?(second.snapshot.players, & &1.is_bot)
    assert Enum.count(second.snapshot.players) == 2
  end

  test "public rooms accept team players until capacity" do
    room = "spectate-#{System.unique_integer([:positive])}"

    replies =
      for index <- 1..8 do
        {:ok, reply} = Game.join(room, "player-#{index}", "Player #{index}")
        reply
      end

    assert Enum.all?(replies, &(&1.spectator == false))
    assert Enum.count(List.last(replies).snapshot.players, &(!&1.is_bot)) == 8

    red_count = Enum.count(List.last(replies).snapshot.players, &(&1.team == "red"))
    blue_count = Enum.count(List.last(replies).snapshot.players, &(&1.team == "blue"))
    assert red_count == 4
    assert blue_count == 4

    {:ok, ninth} = Game.join(room, "player-9", "Player 9")
    assert ninth.spectator == true
    assert ninth.player_id == nil
  end

  test "practice mode locks out additional human joiners" do
    room = "prac-#{System.unique_integer([:positive])}"
    _pid = Game.ensure_room(room, mode: :practice, name: "Practice")

    {:ok, first} = Game.join(room, "p1", "Alice")
    assert first.spectator == false
    assert Enum.any?(first.snapshot.players, & &1.is_bot)

    assert {:error, :practice_locked} = Game.join(room, "p2", "Bob")
  end

  test "create_room and list_rooms exposes active rooms with metadata" do
    {:ok, room_id, _pid} =
      Game.create_room("Lobby Showcase #{System.unique_integer([:positive])}", :vs4)

    rooms = Game.list_rooms()
    assert Enum.any?(rooms, fn r -> r.id == room_id and r.mode == "vs4" end)
  end

  test "ranked room rejects missing or unverified wallet identity" do
    {:ok, room_id, _pid} =
      Game.create_room("Ranked #{System.unique_integer([:positive])}", :vs2, true)

    assert {:error, :wallet_required} =
             Game.join(room_id, "p1", "Alice", registration: nil)

    assert {:error, :wallet_required} =
             Game.join(room_id, "p2", "Bob", registration: %{"kind" => "privy"})

    assert {:ok, reply} =
             Game.join(room_id, "p3", "Carol",
               registration: %{
                 "kind" => "privy",
                 "wallet_address" => "0x1000000000000000000000000000000000000001",
                 "verified_wallet_address" => "0x1000000000000000000000000000000000000001"
               }
             )

    assert reply.spectator == false
    assert [%{wallet: "0x1000…0001"}] = reply.snapshot.players
  end

  test "casual room accepts join without registration" do
    {:ok, room_id, _pid} =
      Game.create_room("Casual #{System.unique_integer([:positive])}", :vs2, false)

    assert {:ok, reply} = Game.join(room_id, "p1", "Alice", registration: nil)
    assert reply.spectator == false
  end

  test "chat broadcasts to room subscribers" do
    room = "chat-#{System.unique_integer([:positive])}"
    _pid = Game.ensure_room(room)
    {:ok, _} = Game.join(room, "p1", "Alice")

    BlockballWeb.Endpoint.subscribe("room:#{Game.sanitize_room(room)}")

    BlockballWeb.Endpoint.broadcast("room:#{Game.sanitize_room(room)}", "chat", %{
      from: "Alice",
      text: "gg",
      ts: 0
    })

    assert_receive %Phoenix.Socket.Broadcast{
                     event: "chat",
                     payload: %{text: "gg", from: "Alice"}
                   },
                   200
  end

  test "goal updates score and scorer goal count" do
    room = "goal-#{System.unique_integer([:positive])}"

    pid = Game.ensure_room(room, mode: :practice)
    {:ok, _reply} = Game.join(room, "player-1", "Alice", mode: :practice)

    :sys.replace_state(pid, fn state ->
      state
      |> put_in([:match, :goal_pause], 0.0)
      |> put_in([:ball, :x], 1_670.0)
      |> put_in([:ball, :y], 450.0)
      |> put_in([:players, "player-1", :x], 1_540.0)
      |> put_in([:players, "player-1", :y], 450.0)
    end)

    Process.sleep(40)
    state = :sys.get_state(pid)

    assert state.match.red_score == 1
    assert state.players["player-1"].goals == 1
  end
end
