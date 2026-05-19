defmodule Blockball.Game.Nickname do
  @moduledoc """
  Server-side nickname policy for ranked accounts.

  The on-chain `UserRegistry` only enforces byte length (2–18). Character rules,
  reserved names, and any future moderation live here.
  """

  @min_bytes 2
  @max_bytes 18
  @pattern ~r/^[A-Za-z0-9_]+$/

  def min_bytes, do: @min_bytes
  def max_bytes, do: @max_bytes

  @doc """
  Trim, validate, and return the canonical form. The returned value is what should
  be passed to the contract (case is preserved; uniqueness is case-insensitive
  on-chain).
  """
  def sanitize(nickname) when is_binary(nickname) do
    trimmed = String.trim(nickname)
    bytes = byte_size(trimmed)

    cond do
      bytes < @min_bytes -> {:error, :nickname_too_short}
      bytes > @max_bytes -> {:error, :nickname_too_long}
      not Regex.match?(@pattern, trimmed) -> {:error, :nickname_invalid_chars}
      true -> {:ok, trimmed}
    end
  end

  def sanitize(_), do: {:error, :nickname_invalid}

  @doc """
  Case-insensitive uniqueness key. Mirrors `UserRegistry._nickKey` for ASCII names.
  """
  def key(nickname) when is_binary(nickname) do
    nickname |> String.downcase() |> ExKeccak.hash_256()
  end
end
