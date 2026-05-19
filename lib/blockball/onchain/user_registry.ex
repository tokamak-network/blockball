defmodule Blockball.Onchain.UserRegistry do
  @moduledoc """
  `cast`-based wrapper around the `UserRegistry` contract.

  Lookups are synchronous so signup flows can wait on them. Writes (`register`,
  `update_nickname`) are also synchronous because the user is sitting in front of
  the signup screen; if that ever becomes a bottleneck we can move them behind a
  Task like `Blockball.Onchain.ReceiptSubmitter`.
  """

  require Logger

  # ---------------------------------------------------------------------------
  # Reads
  # ---------------------------------------------------------------------------

  def lookup_by_wallet(wallet) when is_binary(wallet) do
    with {:ok, config} <- registry_config(),
         {output, 0} <- run_cast(config, call_args(config, "lookupByWallet(address)((bytes32,string))", [wallet])) do
      parse_lookup_output(output)
    else
      {:error, _} = err -> err
      {output, status} when is_integer(status) -> {:error, {:cast_failed, status, output}}
    end
  end

  def lookup_by_wallet(_), do: {:error, :invalid_wallet}

  def nickname_free?(nickname) when is_binary(nickname) do
    with {:ok, config} <- registry_config(),
         {output, 0} <- run_cast(config, call_args(config, "isNicknameFree(string)(bool)", [nickname])) do
      case String.trim(output) do
        "true" -> {:ok, true}
        "false" -> {:ok, false}
        other -> {:error, {:unexpected_output, other}}
      end
    else
      {:error, _} = err -> err
      {output, status} when is_integer(status) -> {:error, {:cast_failed, status, output}}
    end
  end

  def nickname_free?(_), do: {:error, :invalid_nickname}

  # ---------------------------------------------------------------------------
  # Writes
  # ---------------------------------------------------------------------------

  def register(wallet, <<_::binary-size(32)>> = identifier_hash, nickname)
      when is_binary(wallet) and is_binary(nickname) do
    with {:ok, config} <- registry_config(),
         args = send_args(config, "register(address,bytes32,string)",
                          [wallet, to_hex(identifier_hash), nickname]),
         {output, 0} <- run_cast(config, args) do
      parse_send_output(output)
    else
      {:error, _} = err -> err
      {output, status} when is_integer(status) -> {:error, {:cast_failed, status, output}}
    end
  end

  def register(_, _, _), do: {:error, :invalid_register_arguments}

  def update_nickname(wallet, nickname) when is_binary(wallet) and is_binary(nickname) do
    with {:ok, config} <- registry_config(),
         args = send_args(config, "updateNickname(address,string)", [wallet, nickname]),
         {output, 0} <- run_cast(config, args) do
      parse_send_output(output)
    else
      {:error, _} = err -> err
      {output, status} when is_integer(status) -> {:error, {:cast_failed, status, output}}
    end
  end

  def update_nickname(_, _), do: {:error, :invalid_update_arguments}

  # ---------------------------------------------------------------------------
  # Player roster (UserRegistered events)
  # ---------------------------------------------------------------------------

  @user_registered_sig "UserRegistered(address,bytes32,string)"

  def list_registered do
    with {:ok, config} <- registry_config(),
         {:ok, raw_logs} <- fetch_user_registered_logs(config) do
      {:ok, decode_event_logs(raw_logs)}
    end
  end

  defp fetch_user_registered_logs(config) do
    args = [
      "logs",
      @user_registered_sig,
      "--address",
      config.contract_address,
      "--from-block",
      logs_from_block(config),
      "--rpc-url",
      logs_rpc_url(config),
      "--json"
    ]

    case run_cast(config, args) do
      {output, 0} ->
        case Jason.decode(output) do
          {:ok, logs} when is_list(logs) -> {:ok, logs}
          _ -> {:error, {:invalid_cast_json, output}}
        end

      {output, status} when is_integer(status) ->
        {:error, {:cast_failed, status, output}}
    end
  end

  @logs_rpc_default "https://ethereum-sepolia-rpc.publicnode.com"

  defp logs_rpc_url(_config) do
    System.get_env("BLOCKBALL_LOGS_RPC_URL") ||
      Application.get_env(:blockball, :user_registry, [])[:logs_rpc_url] ||
      @logs_rpc_default
  end

  # Sepolia deploy block of the active UserRegistry. Keeps eth_getLogs
  # within a sane range when no explicit override is configured.
  @deploy_block_default "0xa5fdf4"

  defp logs_from_block(_config) do
    System.get_env("BLOCKBALL_USER_REGISTRY_DEPLOY_BLOCK") ||
      Application.get_env(:blockball, :user_registry, [])[:deploy_block] ||
      @deploy_block_default
  end

  def decode_event_logs(logs) when is_list(logs) do
    logs
    |> Enum.map(&decode_user_registered/1)
    |> Enum.reject(&is_nil/1)
  end

  defp decode_user_registered(%{
         "topics" => [_topic0, wallet_topic, identifier_topic],
         "data" => data,
         "blockNumber" => block,
         "transactionHash" => tx
       }) do
    with {:ok, wallet} <- extract_address(wallet_topic),
         {:ok, identifier} <- decode_bytes32(identifier_topic),
         {:ok, nickname} <- decode_event_string(data) do
      %{
        wallet: wallet,
        identifier_hash: "0x" <> Base.encode16(identifier, case: :lower),
        nickname: nickname,
        block_number: block,
        tx_hash: tx
      }
    else
      _ -> nil
    end
  end

  defp decode_user_registered(_), do: nil

  defp extract_address("0x" <> hex) when byte_size(hex) == 64 do
    case Base.decode16(hex, case: :mixed) do
      {:ok, <<_padding::binary-size(12), addr::binary-size(20)>>} ->
        {:ok, "0x" <> Base.encode16(addr, case: :lower)}

      _ ->
        {:error, :invalid_address_topic}
    end
  end

  defp extract_address(_), do: {:error, :invalid_address_topic}

  def decode_event_string("0x" <> hex) do
    case Base.decode16(hex, case: :mixed) do
      {:ok, bin} when byte_size(bin) >= 64 ->
        <<_offset::binary-size(32), len::256, rest::binary>> = bin

        if byte_size(rest) >= len do
          <<value::binary-size(len), _::binary>> = rest
          {:ok, value}
        else
          {:error, :invalid_string_data}
        end

      _ ->
        {:error, :invalid_string_data}
    end
  end

  def decode_event_string(_), do: {:error, :invalid_string_data}

  # ---------------------------------------------------------------------------
  # Cast argument shaping (exposed for tests)
  # ---------------------------------------------------------------------------

  def call_args(config, signature, fn_args) do
    ["call", config.contract_address, signature] ++ fn_args ++ ["--rpc-url", config.rpc_url]
  end

  def send_args(config, signature, fn_args) do
    ["send", config.contract_address, signature] ++
      fn_args ++
      [
        "--rpc-url",
        config.rpc_url,
        "--private-key",
        config.submitter_private_key,
        "--confirmations",
        Integer.to_string(config.confirmations),
        "--json"
      ]
  end

  # ---------------------------------------------------------------------------
  # Parsing (exposed for tests)
  # ---------------------------------------------------------------------------

  @zero_bytes32 <<0::256>>

  def parse_lookup_output(output) when is_binary(output) do
    cleaned = String.trim(output)

    cond do
      cleaned == "" ->
        {:error, :empty_lookup_output}

      String.starts_with?(cleaned, "(") ->
        parse_tuple_line(cleaned)

      true ->
        parse_lookup_lines(String.split(cleaned, "\n", trim: true))
    end
  end

  defp parse_tuple_line(text) do
    inner = text |> String.trim_leading("(") |> String.trim_trailing(")")

    case String.split(inner, ",", parts: 2) do
      [id_part, nick_part] ->
        with {:ok, identifier} <- decode_bytes32(String.trim(id_part)) do
          nickname = nick_part |> String.trim() |> strip_quotes()
          finalize_lookup(identifier, nickname)
        end

      _ ->
        {:error, {:invalid_lookup_output, text}}
    end
  end

  defp parse_lookup_lines(lines) do
    with {:ok, identifier, rest_lines} <- pop_bytes32(lines) do
      nickname = join_nickname(rest_lines)
      finalize_lookup(identifier, nickname)
    end
  end

  defp finalize_lookup(identifier, nickname) do
    if identifier == @zero_bytes32 and nickname == "" do
      {:ok, :not_registered}
    else
      {:ok, %{identifier: identifier, nickname: nickname}}
    end
  end

  def parse_send_output(output) when is_binary(output) do
    case Jason.decode(output) do
      {:ok, decoded} ->
        {:ok,
         %{
           tx_hash: decoded["transactionHash"] || decoded["hash"],
           block_number: decoded["blockNumber"],
           raw: decoded
         }}

      _ ->
        {:error, {:invalid_cast_json, output}}
    end
  end

  defp pop_bytes32([head | tail]) do
    case decode_bytes32(String.trim(head)) do
      {:ok, bytes} -> {:ok, bytes, tail}
      err -> err
    end
  end

  defp pop_bytes32([]), do: {:error, :empty_lookup_output}

  defp join_nickname(lines) do
    lines |> Enum.map(&String.trim/1) |> Enum.join("\n") |> strip_quotes()
  end

  defp strip_quotes(<<?", rest::binary>>) do
    case String.split(rest, "\"", parts: 2) do
      [body, _] -> body
      [body] -> body
    end
  end

  defp strip_quotes(other), do: other

  defp decode_bytes32("0x" <> hex) do
    case Base.decode16(hex, case: :mixed) do
      {:ok, <<bin::binary-size(32)>>} -> {:ok, bin}
      _ -> {:error, :invalid_bytes32}
    end
  end

  defp decode_bytes32(_), do: {:error, :invalid_bytes32}

  defp to_hex(<<_::binary-size(32)>> = bin), do: "0x" <> Base.encode16(bin, case: :lower)

  # ---------------------------------------------------------------------------
  # Config
  # ---------------------------------------------------------------------------

  def registry_config do
    config = Application.get_env(:blockball, :user_registry, [])
    ranked = Application.get_env(:blockball, :ranked_receipts, [])

    rpc_url = config[:rpc_url] || ranked[:rpc_url] || System.get_env("BLOCKBALL_RPC_URL")
    contract_address = config[:contract_address] || System.get_env("BLOCKBALL_USER_REGISTRY_CONTRACT")

    submitter_private_key =
      config[:submitter_private_key] ||
        ranked[:submitter_private_key] ||
        System.get_env("BLOCKBALL_RECEIPT_SUBMITTER_PRIVATE_KEY") ||
        ranked[:signer_private_key] ||
        System.get_env("BLOCKBALL_RECEIPT_SIGNER_PRIVATE_KEY")

    cond do
      blank?(rpc_url) ->
        {:error, :rpc_url_not_configured}

      blank?(contract_address) ->
        {:error, :contract_address_not_configured}

      blank?(submitter_private_key) ->
        {:error, :submitter_private_key_not_configured}

      true ->
        {:ok,
         %{
           rpc_url: rpc_url,
           contract_address: contract_address,
           submitter_private_key: submitter_private_key,
           cast_path: config[:cast_path] || System.get_env("CAST_PATH") || "cast",
           confirmations:
             config[:confirmations] || env_int("BLOCKBALL_USER_REGISTRY_CONFIRMATIONS") || 1
         }}
    end
  end

  defp run_cast(config, args), do: System.cmd(config.cast_path, args, stderr_to_stdout: true)

  defp blank?(nil), do: true
  defp blank?(""), do: true
  defp blank?(_), do: false

  defp env_int(name) do
    case System.get_env(name) do
      nil ->
        nil

      value ->
        case Integer.parse(value) do
          {int, ""} -> int
          _ -> nil
        end
    end
  end
end
