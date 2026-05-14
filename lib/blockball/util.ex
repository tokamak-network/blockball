defmodule Blockball.Util do
  @moduledoc """
  Common utilities shared across Blockball modules.
  """

  @doc """
  Generates a random URL-safe id of the given length, upper-cased.

  Used for room ids, player ids, client ids, and similar short identifiers.
  """
  @spec random_id(pos_integer()) :: String.t()
  def random_id(length) when is_integer(length) and length > 0 do
    length
    |> :crypto.strong_rand_bytes()
    |> Base.url_encode64(padding: false)
    |> String.slice(0, length)
    |> String.upcase()
  end
end
