defmodule Blockball.Game.RankedMatchReceipt do
  @moduledoc """
  Builds and signs Blockball ranked match receipts in the same EIP-712 shape as
  `BlockballReceipts.MatchReceipt`.

  These receipts are server attestations: they prove the configured Blockball
  server key signed a wallet-bound ranked result. They are only canonical after
  `BlockballReceipts.submitReceipt/2` confirms on-chain.
  """

  @type player :: %{team: atom(), is_bot: boolean(), verified_wallet_address: binary() | nil}

  @match_type_ranked 1
  @outcome_draw 0
  @outcome_red 1
  @outcome_blue 2

  @receipt_type "MatchReceipt(bytes32 matchId,uint64 seasonId,bytes32 roomId,uint8 matchType,uint8 outcome,uint8 scoreRed,uint8 scoreBlue,bytes32 replayHash,uint64 startedAt,uint64 endedAt,address[] redPlayers,address[] bluePlayers)"
  @domain_type "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"

  @receipt_typehash ExKeccak.hash_256(@receipt_type)
  @domain_typehash ExKeccak.hash_256(@domain_type)
  @domain_name_hash ExKeccak.hash_256("BlockballReceipts")
  @domain_version_hash ExKeccak.hash_256("1")

  def match_type_ranked, do: @match_type_ranked

  def build(match, room_id, players, winner, opts \\ []) when is_map(match) do
    humans = players |> Enum.reject(& &1.is_bot)

    red =
      humans
      |> Enum.filter(&(&1.team == :red))
      |> Enum.map(&normalize_address!(&1.verified_wallet_address))

    blue =
      humans
      |> Enum.filter(&(&1.team == :blue))
      |> Enum.map(&normalize_address!(&1.verified_wallet_address))

    ended_at = Keyword.get(opts, :ended_at, DateTime.utc_now())
    replay_hash = replay_hash(match.events || [])

    receipt = %{
      matchId: bytes32_hash(["blockball-match", match.id]),
      seasonId: normalize_uint!(match.season_id, 64, "seasonId"),
      roomId: bytes32_hash(["blockball-room", room_id]),
      matchType: @match_type_ranked,
      outcome: outcome(winner),
      scoreRed: normalize_uint!(match.red_score, 8, "scoreRed"),
      scoreBlue: normalize_uint!(match.blue_score, 8, "scoreBlue"),
      replayHash: replay_hash,
      startedAt: DateTime.to_unix(match.started_at),
      endedAt: DateTime.to_unix(ended_at),
      redPlayers: red,
      bluePlayers: blue
    }

    domain = domain()
    digest = digest(receipt, domain)
    signature = sign_digest(digest)

    %{
      kind: "server_attested_ranked_receipt",
      status: if(signature, do: "signed_receipt_ready", else: "signer_not_configured"),
      recorded: false,
      recorded_on_chain: false,
      record_claim: "pending_chain_confirmation",
      match_id: hex(receipt.matchId),
      season_id: receipt.seasonId,
      room_id: room_id,
      room_id_bytes32: hex(receipt.roomId),
      match_type: "ranked",
      match_type_id: @match_type_ranked,
      outcome: Atom.to_string(winner),
      score_red: receipt.scoreRed,
      score_blue: receipt.scoreBlue,
      red_players: red,
      blue_players: blue,
      started_at: DateTime.to_iso8601(match.started_at),
      ended_at: DateTime.to_iso8601(ended_at),
      replay_hash: hex(replay_hash),
      typed_data: typed_data(receipt, domain),
      eip712_digest: hex(digest),
      server_signature: signature,
      signature_scheme: "eip712/secp256k1",
      l2_payload: %{
        contract: "BlockballReceipts",
        chain_id: domain.chainId,
        verifying_contract: domain.verifyingContract,
        submit_function:
          "submitReceipt((bytes32,uint64,bytes32,uint8,uint8,uint8,uint8,bytes32,uint64,uint64,address[],address[]),bytes)",
        receipt: json_receipt(receipt),
        signature: signature,
        fallback:
          "Anyone can submit this signed receipt. It is not recorded until the transaction is confirmed."
      }
    }
  end

  def digest(receipt, domain \\ domain()) do
    ExKeccak.hash_256(<<0x19, 0x01>> <> domain_separator(domain) <> struct_hash(receipt))
  end

  def domain do
    config = Application.get_env(:blockball, :ranked_receipts, [])

    %{
      name: "BlockballReceipts",
      version: "1",
      chainId: config[:chain_id] || env_int("BLOCKBALL_CHAIN_ID") || 31_337,
      verifyingContract:
        normalize_address!(
          config[:contract_address] ||
            System.get_env("BLOCKBALL_RECEIPTS_CONTRACT") ||
            "0x5FbDB2315678afecb367f032d93F642f64180aa3"
        )
    }
  end

  def signer_address do
    with {:ok, private_key} <- signer_private_key(),
         {:ok, public_key} <- ExSecp256k1.create_public_key(private_key) do
      {:ok, address_from_public_key(public_key)}
    end
  end

  def recover_personal_sign_address(message, signature_hex) do
    with {:ok, signature} <- decode_hex(signature_hex),
         {:ok, {r, s, recovery_id}} <- split_signature(signature),
         hash <- personal_sign_hash(message),
         {:ok, public_key} <- ExSecp256k1.recover(hash, r, s, recovery_id) do
      {:ok, address_from_public_key(public_key)}
    end
  end

  def personal_sign_hash(message) when is_binary(message) do
    ExKeccak.hash_256("\x19Ethereum Signed Message:\n#{byte_size(message)}" <> message)
  end

  def verify_registration_message?(message, wallet_address) when is_binary(message) do
    normalized = normalize_address(wallet_address)

    normalized != nil and
      String.contains?(message, "Blockball registration") and
      String.contains?(message, "Domain:") and
      String.contains?(String.downcase(message), String.downcase(normalized)) and
      String.contains?(message, "Issued At:") and
      String.contains?(message, "Nonce:")
  end

  def verify_registration_message?(_, _), do: false

  def normalize_address(address) when is_binary(address) do
    value = String.downcase(String.trim(address))

    if Regex.match?(~r/^0x[0-9a-f]{40}$/, value), do: value, else: nil
  end

  def normalize_address(_), do: nil

  def normalize_address!(address) do
    normalize_address(address) ||
      raise ArgumentError, "invalid Ethereum address: #{inspect(address)}"
  end

  defp typed_data(receipt, domain) do
    %{
      domain: domain,
      primaryType: "MatchReceipt",
      types: %{
        EIP712Domain: [
          %{name: "name", type: "string"},
          %{name: "version", type: "string"},
          %{name: "chainId", type: "uint256"},
          %{name: "verifyingContract", type: "address"}
        ],
        MatchReceipt: [
          %{name: "matchId", type: "bytes32"},
          %{name: "seasonId", type: "uint64"},
          %{name: "roomId", type: "bytes32"},
          %{name: "matchType", type: "uint8"},
          %{name: "outcome", type: "uint8"},
          %{name: "scoreRed", type: "uint8"},
          %{name: "scoreBlue", type: "uint8"},
          %{name: "replayHash", type: "bytes32"},
          %{name: "startedAt", type: "uint64"},
          %{name: "endedAt", type: "uint64"},
          %{name: "redPlayers", type: "address[]"},
          %{name: "bluePlayers", type: "address[]"}
        ]
      },
      message: json_receipt(receipt)
    }
  end

  defp json_receipt(receipt) do
    %{
      matchId: hex(receipt.matchId),
      seasonId: receipt.seasonId,
      roomId: hex(receipt.roomId),
      matchType: receipt.matchType,
      outcome: receipt.outcome,
      scoreRed: receipt.scoreRed,
      scoreBlue: receipt.scoreBlue,
      replayHash: hex(receipt.replayHash),
      startedAt: receipt.startedAt,
      endedAt: receipt.endedAt,
      redPlayers: receipt.redPlayers,
      bluePlayers: receipt.bluePlayers
    }
  end

  defp sign_digest(digest) do
    with {:ok, private_key} <- signer_private_key(),
         {:ok, {r, s, recovery_id}} <- ExSecp256k1.sign(digest, private_key) do
      v = recovery_id + 27
      hex(r <> s <> <<v>>)
    else
      _ -> nil
    end
  end

  defp signer_private_key do
    config = Application.get_env(:blockball, :ranked_receipts, [])
    raw = config[:signer_private_key] || System.get_env("BLOCKBALL_RECEIPT_SIGNER_PRIVATE_KEY")

    case decode_hex(raw) do
      {:ok, <<_::binary-size(32)>> = key} -> {:ok, key}
      _ -> {:error, :signer_not_configured}
    end
  end

  defp domain_separator(domain) do
    ExKeccak.hash_256(
      @domain_typehash <>
        @domain_name_hash <>
        @domain_version_hash <>
        word(domain.chainId) <>
        encoded_address(domain.verifyingContract)
    )
  end

  defp struct_hash(receipt) do
    ExKeccak.hash_256(
      @receipt_typehash <>
        receipt.matchId <>
        word(receipt.seasonId) <>
        receipt.roomId <>
        word(receipt.matchType) <>
        word(receipt.outcome) <>
        word(receipt.scoreRed) <>
        word(receipt.scoreBlue) <>
        receipt.replayHash <>
        word(receipt.startedAt) <>
        word(receipt.endedAt) <>
        address_array_hash(receipt.redPlayers) <>
        address_array_hash(receipt.bluePlayers)
    )
  end

  defp address_array_hash(addresses) do
    addresses
    |> Enum.map(&encoded_address/1)
    |> IO.iodata_to_binary()
    |> ExKeccak.hash_256()
  end

  defp replay_hash(events), do: ExKeccak.hash_256(:erlang.term_to_binary(events))

  defp bytes32_hash(parts) do
    parts
    |> Enum.map(&to_string/1)
    |> Enum.join(":")
    |> ExKeccak.hash_256()
  end

  defp outcome(:draw), do: @outcome_draw
  defp outcome(:red), do: @outcome_red
  defp outcome(:blue), do: @outcome_blue

  defp normalize_uint!(value, bits, field) when is_integer(value) do
    max = :math.pow(2, bits) |> trunc()
    if value >= 0 and value < max, do: value, else: raise(ArgumentError, "#{field} out of range")
  end

  defp normalize_uint!(value, bits, field) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> normalize_uint!(int, bits, field)
      _ -> raise ArgumentError, "#{field} must be an integer"
    end
  end

  defp word(value) when is_integer(value) and value >= 0 do
    if value >= :math.pow(2, 256) |> trunc(), do: raise(ArgumentError, "uint256 out of range")
    <<value::unsigned-big-integer-size(256)>>
  end

  defp encoded_address(address) do
    {:ok, <<addr::binary-size(20)>>} =
      address
      |> normalize_address!()
      |> String.replace_prefix("0x", "")
      |> Base.decode16(case: :lower)

    <<0::unsigned-big-integer-size(96), addr::binary>>
  end

  defp decode_hex(nil), do: {:error, :missing_hex}

  defp decode_hex("0x" <> rest), do: decode_hex(rest)

  defp decode_hex(value) when is_binary(value) do
    Base.decode16(String.trim(value), case: :mixed)
  end

  defp split_signature(<<r::binary-size(32), s::binary-size(32), v>>) when v in [27, 28] do
    {:ok, {r, s, v - 27}}
  end

  defp split_signature(<<r::binary-size(32), s::binary-size(32), recovery_id>>)
       when recovery_id in [0, 1] do
    {:ok, {r, s, recovery_id}}
  end

  defp split_signature(_), do: {:error, :invalid_signature}

  defp address_from_public_key(<<4, key::binary-size(64)>>),
    do: key |> ExKeccak.hash_256() |> binary_part(12, 20) |> hex()

  defp address_from_public_key(<<key::binary-size(64)>>),
    do: key |> ExKeccak.hash_256() |> binary_part(12, 20) |> hex()

  defp address_from_public_key(public_key) when byte_size(public_key) == 33 do
    {:ok, decompressed} = ExSecp256k1.public_key_decompress(public_key)
    address_from_public_key(decompressed)
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

  defp hex(binary), do: "0x" <> Base.encode16(binary, case: :lower)
end
