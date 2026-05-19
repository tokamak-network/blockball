defmodule Blockball.WalletAuth.Challenges do
  @moduledoc """
  Short-lived, single-use ranked wallet registration challenges.
  """

  use Agent

  alias Blockball.Game.RankedMatchReceipt

  @ttl_seconds 300

  def start_link(_opts) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  def issue(address, opts \\ []) do
    normalized = RankedMatchReceipt.normalize_address!(address)
    issued_at = Keyword.get(opts, :issued_at, DateTime.utc_now())
    nonce = Keyword.get(opts, :nonce, random_nonce())
    domain = Keyword.get(opts, :domain, "blockball")

    challenge = %{
      address: normalized,
      domain: domain,
      nonce: nonce,
      issued_at: issued_at,
      expires_at: DateTime.add(issued_at, @ttl_seconds, :second),
      message: message(normalized, domain, issued_at, nonce)
    }

    Agent.update(__MODULE__, fn state -> Map.put(state, nonce, challenge) end)
    challenge
  end

  def consume(message, address) when is_binary(message) do
    normalized = RankedMatchReceipt.normalize_address(address)

    Agent.get_and_update(__MODULE__, fn state ->
      now = DateTime.utc_now()

      state =
        Enum.reject(state, fn {_nonce, challenge} ->
          DateTime.compare(challenge.expires_at, now) == :lt
        end)
        |> Map.new()

      match =
        Enum.find(state, fn {_nonce, challenge} ->
          challenge.address == normalized and challenge.message == message and
            DateTime.compare(challenge.expires_at, now) != :lt
        end)

      case match do
        {nonce, challenge} -> {{:ok, challenge}, Map.delete(state, nonce)}
        nil -> {{:error, :invalid_or_expired_challenge}, state}
      end
    end)
  end

  def consume(_, _), do: {:error, :invalid_or_expired_challenge}

  def message(address, domain, issued_at, nonce) do
    "Blockball registration\nDomain: #{domain}\nAddress: #{address}\nIssued At: #{DateTime.to_iso8601(issued_at)}\nNonce: #{nonce}"
  end

  defp random_nonce do
    16 |> :crypto.strong_rand_bytes() |> Base.url_encode64(padding: false)
  end
end
