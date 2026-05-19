defmodule BlockballWeb.WalletAuthController do
  use BlockballWeb, :controller

  alias Blockball.Game.{Nickname, RankedMatchReceipt}
  alias Blockball.Onchain.UserRegistry
  alias Blockball.WalletAuth.{Challenges, Identifier, Privy}

  def challenge(conn, %{"wallet_address" => wallet_address}) do
    case RankedMatchReceipt.normalize_address(wallet_address) do
      nil ->
        conn |> put_status(422) |> json(%{ok: false, error: "invalid_wallet_address"})

      address ->
        host = get_req_header(conn, "host") |> List.first() || "blockball"
        challenge = Challenges.issue(address, domain: host)

        json(conn, %{
          ok: true,
          wallet_address: address,
          message: challenge.message,
          nonce: challenge.nonce,
          issued_at: DateTime.to_iso8601(challenge.issued_at),
          expires_at: DateTime.to_iso8601(challenge.expires_at)
        })
    end
  end

  def challenge(conn, _params) do
    conn |> put_status(422) |> json(%{ok: false, error: "wallet_address_required"})
  end

  def lookup(conn, %{"wallet_address" => wallet}) do
    with {:ok, _claims} <- verify_privy(conn),
         address when is_binary(address) <- RankedMatchReceipt.normalize_address(wallet),
         {:ok, result} <- UserRegistry.lookup_by_wallet(address) do
      respond_lookup(conn, result)
    else
      nil -> json_error(conn, 422, "invalid_wallet_address")
      {:error, reason} -> json_error(conn, status_for(reason), error_code(reason))
    end
  end

  def lookup(conn, _), do: json_error(conn, 422, "wallet_address_required")

  def register(conn, %{
        "wallet_address" => wallet,
        "email" => email,
        "nickname" => nickname
      }) do
    with {:ok, _claims} <- verify_privy(conn),
         address when is_binary(address) <- RankedMatchReceipt.normalize_address(wallet),
         {:ok, nick} <- Nickname.sanitize(nickname),
         {:ok, id_hash} <- Identifier.hash(email),
         {:ok, true} <- ensure_nickname_free(nick),
         {:ok, confirmation} <- UserRegistry.register(address, id_hash, nick) do
      json(conn, %{
        ok: true,
        nickname: nick,
        tx_hash: confirmation.tx_hash,
        block_number: confirmation.block_number,
        identifier_hash: hex(id_hash)
      })
    else
      nil -> json_error(conn, 422, "invalid_wallet_address")
      {:error, reason} -> json_error(conn, status_for(reason), error_code(reason))
    end
  end

  def register(conn, _), do: json_error(conn, 422, "missing_fields")

  def update_nickname(conn, %{"wallet_address" => wallet, "nickname" => nickname}) do
    with {:ok, _claims} <- verify_privy(conn),
         address when is_binary(address) <- RankedMatchReceipt.normalize_address(wallet),
         {:ok, nick} <- Nickname.sanitize(nickname),
         {:ok, true} <- ensure_nickname_available_for(address, nick),
         {:ok, confirmation} <- UserRegistry.update_nickname(address, nick) do
      json(conn, %{
        ok: true,
        nickname: nick,
        tx_hash: confirmation.tx_hash,
        block_number: confirmation.block_number
      })
    else
      nil -> json_error(conn, 422, "invalid_wallet_address")
      {:error, reason} -> json_error(conn, status_for(reason), error_code(reason))
    end
  end

  def update_nickname(conn, _), do: json_error(conn, 422, "missing_fields")

  def me(conn, %{"wallet_address" => wallet}) do
    with {:ok, _claims} <- verify_privy(conn),
         address when is_binary(address) <- RankedMatchReceipt.normalize_address(wallet),
         {:ok, result} <- UserRegistry.lookup_by_wallet(address) do
      payload = %{
        ok: true,
        wallet_address: address,
        contract_address: registry_contract_address(),
        chain_id: chain_id()
      }

      json(conn, Map.merge(payload, profile_fields(result)))
    else
      nil -> json_error(conn, 422, "invalid_wallet_address")
      {:error, reason} -> json_error(conn, status_for(reason), error_code(reason))
    end
  end

  def me(conn, _), do: json_error(conn, 422, "wallet_address_required")

  def players(conn, _params) do
    with {:ok, _claims} <- verify_privy(conn),
         {:ok, players} <- UserRegistry.list_registered() do
      json(conn, %{
        ok: true,
        contract_address: registry_contract_address(),
        chain_id: chain_id(),
        players: players
      })
    else
      {:error, reason} -> json_error(conn, status_for(reason), error_code(reason))
    end
  end

  defp registry_contract_address do
    Application.get_env(:blockball, :user_registry, [])[:contract_address] ||
      System.get_env("BLOCKBALL_USER_REGISTRY_CONTRACT")
  end

  defp profile_fields(:not_registered), do: %{registered: false}

  defp profile_fields(%{identifier: id, nickname: nick}) do
    %{registered: true, nickname: nick, identifier_hash: hex(id)}
  end

  defp chain_id do
    Application.get_env(:blockball, :user_registry, [])[:chain_id]
  end

  defp respond_lookup(conn, :not_registered),
    do: json(conn, %{ok: true, registered: false})

  defp respond_lookup(conn, %{identifier: id, nickname: nick}) do
    json(conn, %{
      ok: true,
      registered: true,
      nickname: nick,
      identifier_hash: hex(id)
    })
  end

  defp ensure_nickname_free(nick) do
    case UserRegistry.nickname_free?(nick) do
      {:ok, true} -> {:ok, true}
      {:ok, false} -> {:error, :nickname_taken}
      err -> err
    end
  end

  defp ensure_nickname_available_for(wallet, nick) do
    case UserRegistry.nickname_free?(nick) do
      {:ok, true} ->
        {:ok, true}

      {:ok, false} ->
        case UserRegistry.lookup_by_wallet(wallet) do
          {:ok, %{nickname: current}} when is_binary(current) ->
            if String.downcase(current) == String.downcase(nick),
              do: {:ok, true},
              else: {:error, :nickname_taken}

          _ ->
            {:error, :nickname_taken}
        end

      err ->
        err
    end
  end

  defp verify_privy(conn) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         {:ok, claims} <- Privy.verify_access_token(token) do
      {:ok, claims}
    else
      _ -> {:error, :invalid_privy_token}
    end
  end

  defp json_error(conn, status, code) do
    conn |> put_status(status) |> json(%{ok: false, error: code})
  end

  defp hex(<<bin::binary>>), do: "0x" <> Base.encode16(bin, case: :lower)

  defp status_for(:invalid_privy_token), do: 401
  defp status_for(:nickname_taken), do: 409
  defp status_for(:contract_address_not_configured), do: 503
  defp status_for(:rpc_url_not_configured), do: 503
  defp status_for(:submitter_private_key_not_configured), do: 503
  defp status_for({:cast_failed, _, _}), do: 502
  defp status_for({:invalid_cast_json, _}), do: 502
  defp status_for(_), do: 422

  defp error_code(:invalid_privy_token), do: "invalid_privy_token"
  defp error_code(:nickname_too_short), do: "nickname_too_short"
  defp error_code(:nickname_too_long), do: "nickname_too_long"
  defp error_code(:nickname_invalid_chars), do: "nickname_invalid_chars"
  defp error_code(:nickname_invalid), do: "nickname_invalid"
  defp error_code(:invalid_identifier), do: "invalid_identifier"
  defp error_code(:nickname_taken), do: "nickname_taken"
  defp error_code(:contract_address_not_configured), do: "contract_address_not_configured"
  defp error_code(:rpc_url_not_configured), do: "rpc_url_not_configured"
  defp error_code(:submitter_private_key_not_configured), do: "submitter_private_key_not_configured"
  defp error_code({:cast_failed, _, _}), do: "onchain_call_failed"
  defp error_code({:invalid_cast_json, _}), do: "onchain_response_invalid"
  defp error_code({:unexpected_output, _}), do: "onchain_response_invalid"
  defp error_code({:invalid_lookup_output, _}), do: "onchain_response_invalid"
  defp error_code(:empty_lookup_output), do: "onchain_response_invalid"
  defp error_code(:invalid_bytes32), do: "onchain_response_invalid"
  defp error_code(other), do: inspect(other)
end
