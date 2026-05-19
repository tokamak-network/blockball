defmodule Blockball.WalletAuth.Identifier do
  @moduledoc """
  Hashing helper for the off-chain login identifier stored on `UserRegistry.users`.

  Currently every identifier is an email. The contract only stores
  `keccak256(toLower(identifier))`; the plaintext never leaves the server.
  """

  @doc """
  Normalize and hash an identifier. Returns `{:ok, <<32 bytes>>}` or `{:error, reason}`.
  """
  def hash(identifier) when is_binary(identifier) do
    case normalize(identifier) do
      {:ok, normalized} -> {:ok, ExKeccak.hash_256(normalized)}
      err -> err
    end
  end

  def hash(_), do: {:error, :invalid_identifier}

  @doc """
  Trim surrounding whitespace and lower-case so callers can compare identifiers in
  the same form the contract sees.
  """
  def normalize(identifier) when is_binary(identifier) do
    case String.trim(identifier) do
      "" -> {:error, :invalid_identifier}
      trimmed -> {:ok, String.downcase(trimmed)}
    end
  end

  def normalize(_), do: {:error, :invalid_identifier}
end
