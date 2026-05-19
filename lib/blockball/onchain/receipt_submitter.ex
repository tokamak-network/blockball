defmodule Blockball.Onchain.ReceiptSubmitter do
  @moduledoc """
  Async boundary for ranked receipt submission.

  The room GenServer hands the signed receipt to this module and continues. When
  RPC submission is configured, this module calls `BlockballReceipts.submitReceipt`,
  waits for confirmation, and broadcasts `chain_confirmed`. Otherwise the signed
  receipt remains available for permissionless fallback submission.
  """

  alias BlockballWeb.Endpoint

  require Logger

  def submit_async(room_id, receipt) do
    Task.start(fn -> submit_or_broadcast_fallback(room_id, receipt) end)
    :ok
  end

  def submit_or_broadcast_fallback(room_id, receipt) do
    case submit(receipt) do
      {:ok, confirmation} -> broadcast_confirmed(room_id, receipt, confirmation)
      {:error, reason} -> broadcast_failed(room_id, receipt, inspect(reason))
    end
  rescue
    error ->
      Logger.warning("ranked receipt submission failed: #{Exception.message(error)}")
      broadcast_failed(room_id, receipt, "submission error")
  end

  def submit(receipt) do
    with {:ok, config} <- submitter_config(),
         {:ok, receipt_tuple} <- cast_receipt_tuple(receipt),
         signature when is_binary(signature) <- receipt[:server_signature],
         {output, 0} <-
           System.cmd(config.cast_path, cast_args(config, receipt_tuple, signature),
             stderr_to_stdout: true
           ),
         {:ok, confirmation} <- parse_cast_output(output) do
      {:ok, confirmation}
    else
      nil -> {:error, :signature_missing}
      {output, status} when is_integer(status) -> {:error, {:cast_failed, status, output}}
      {:error, reason} -> {:error, reason}
      other -> {:error, {:unexpected_submitter_result, other}}
    end
  end

  def cast_args(config, receipt_tuple, signature) do
    [
      "send",
      "--rpc-url",
      config.rpc_url,
      "--private-key",
      config.submitter_private_key,
      "--confirmations",
      Integer.to_string(config.confirmations),
      "--json",
      config.contract_address,
      "submitReceipt((bytes32,uint64,bytes32,uint8,uint8,uint8,uint8,bytes32,uint64,uint64,address[],address[]),bytes)",
      receipt_tuple,
      signature
    ]
  end

  def cast_receipt_tuple(%{l2_payload: %{receipt: r}}) do
    tuple =
      "(#{r.matchId},#{r.seasonId},#{r.roomId},#{r.matchType},#{r.outcome},#{r.scoreRed},#{r.scoreBlue},#{r.replayHash},#{r.startedAt},#{r.endedAt},#{address_array(r.redPlayers)},#{address_array(r.bluePlayers)})"

    {:ok, tuple}
  rescue
    _ -> {:error, :invalid_receipt_payload}
  end

  def cast_receipt_tuple(_), do: {:error, :invalid_receipt_payload}

  defp submitter_config do
    config = Application.get_env(:blockball, :ranked_receipts, [])

    rpc_url = config[:rpc_url] || System.get_env("BLOCKBALL_RPC_URL")
    contract_address = config[:contract_address] || System.get_env("BLOCKBALL_RECEIPTS_CONTRACT")

    submitter_private_key =
      config[:submitter_private_key] ||
        System.get_env("BLOCKBALL_RECEIPT_SUBMITTER_PRIVATE_KEY") ||
        config[:signer_private_key] ||
        System.get_env("BLOCKBALL_RECEIPT_SIGNER_PRIVATE_KEY")

    cond do
      is_nil(rpc_url) or rpc_url == "" ->
        {:error, :rpc_url_not_configured}

      is_nil(contract_address) or contract_address == "" ->
        {:error, :contract_address_not_configured}

      is_nil(submitter_private_key) or submitter_private_key == "" ->
        {:error, :submitter_private_key_not_configured}

      true ->
        {:ok,
         %{
           rpc_url: rpc_url,
           contract_address: contract_address,
           submitter_private_key: submitter_private_key,
           cast_path: config[:cast_path] || System.get_env("CAST_PATH") || "cast",
           confirmations:
             config[:confirmations] || env_int("BLOCKBALL_RECEIPT_CONFIRMATIONS") || 1
         }}
    end
  end

  defp parse_cast_output(output) do
    with {:ok, decoded} <- Jason.decode(output) do
      {:ok,
       %{
         tx_hash: decoded["transactionHash"] || decoded["hash"],
         block_number: decoded["blockNumber"],
         raw: decoded
       }}
    else
      _ -> {:error, {:invalid_cast_json, output}}
    end
  end

  defp address_array(addresses) do
    "[" <> Enum.join(addresses, ",") <> "]"
  end

  defp broadcast_confirmed(room_id, receipt, confirmation) do
    Endpoint.broadcast("room:#{room_id}", "receipt_status", %{
      status: "chain_confirmed",
      recorded: true,
      match_id: receipt[:match_id],
      tx_hash: confirmation.tx_hash,
      block_number: confirmation.block_number
    })
  end

  defp broadcast_failed(room_id, receipt, reason) do
    Endpoint.broadcast("room:#{room_id}", "receipt_status", %{
      status: "submission_failed_permissionless_available",
      recorded: false,
      reason: reason,
      match_id: receipt[:match_id],
      receipt: receipt
    })
  end

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
