defmodule Blockball.Game.Leaderboard do
  @moduledoc false

  use Agent

  def start_link(_opts) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  def record(name, patch) do
    Agent.update(__MODULE__, fn board ->
      row =
        Map.get(board, name, %{
          name: name,
          matches: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          goals: 0,
          points: 0
        })

      row =
        row
        |> Map.update!(:matches, &(&1 + Map.get(patch, :matches, 0)))
        |> Map.update!(:wins, &(&1 + Map.get(patch, :wins, 0)))
        |> Map.update!(:losses, &(&1 + Map.get(patch, :losses, 0)))
        |> Map.update!(:draws, &(&1 + Map.get(patch, :draws, 0)))
        |> Map.update!(:goals, &(&1 + Map.get(patch, :goals, 0)))

      row = %{row | points: row.wins * 3 + row.draws}
      Map.put(board, name, row)
    end)
  end

  def top(limit \\ 12) do
    Agent.get(__MODULE__, fn board ->
      board
      |> Map.values()
      |> Enum.sort_by(fn row -> {-row.points, -row.wins, -row.goals, row.name} end)
      |> Enum.take(limit)
    end)
  end
end
