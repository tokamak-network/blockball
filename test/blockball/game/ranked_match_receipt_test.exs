defmodule Blockball.Game.RankedMatchReceiptTest do
  use ExUnit.Case, async: true

  alias Blockball.Game.RankedMatchReceipt

  @fixture_digest "0xef7119dd4e3033e0a621db753b897e55e5eb5decc5624bc5ffdb66452283c317"
  @fixture_signature "0x909b92501d6d2677583190e5d6eaedbf1e4b646c4e5d8ec99a585da9d4ddd0736b3832205e812a7fef6fbade3e97b44f9f732b9355ed8242846e5c13625be0461c"
  @fixture_signer "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"

  test "builds viem-compatible EIP-712 ranked receipt fixture" do
    receipt = fixture_receipt()

    assert receipt.kind == "server_attested_ranked_receipt"
    assert receipt.status == "signed_receipt_ready"
    assert receipt.recorded == false
    assert receipt.match_type_id == 1
    assert receipt.red_players == ["0x1000000000000000000000000000000000000001"]
    assert receipt.blue_players == ["0x2000000000000000000000000000000000000002"]
    assert receipt.eip712_digest == @fixture_digest
    assert receipt.server_signature == @fixture_signature

    assert receipt.typed_data.types |> Map.fetch!(:MatchReceipt) |> Enum.map(& &1.name) == [
             "matchId",
             "seasonId",
             "roomId",
             "matchType",
             "outcome",
             "scoreRed",
             "scoreBlue",
             "replayHash",
             "startedAt",
             "endedAt",
             "redPlayers",
             "bluePlayers"
           ]

    assert RankedMatchReceipt.signer_address() == {:ok, @fixture_signer}
  end

  test "recovers and verifies external wallet registration signatures" do
    message =
      "Blockball registration\nDomain: example.test\nAddress: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266\nIssued At: 2026-05-19T00:00:00Z\nNonce: fixture"

    signature =
      "0x9610cbc16bff2b9d8ba09c2716c4e6113d96c0fbaa5a72c36986d3dbda24689a02861085c5f61c16a00cd7aec0893c2ec00f6a4962874b7fd82d84cacb67190c1c"

    assert RankedMatchReceipt.verify_registration_message?(message, @fixture_signer)

    assert RankedMatchReceipt.recover_personal_sign_address(message, signature) ==
             {:ok, @fixture_signer}
  end

  defp fixture_receipt do
    match = %{
      id: "fixture-match-1",
      season_id: 1,
      events: [%{t: 1000, type: "goal", team: "red"}],
      red_score: 3,
      blue_score: 1,
      started_at: ~U[2026-05-19 00:00:00Z]
    }

    players = [
      %{
        team: :red,
        is_bot: false,
        verified_wallet_address: "0x1000000000000000000000000000000000000001"
      },
      %{
        team: :blue,
        is_bot: false,
        verified_wallet_address: "0x2000000000000000000000000000000000000002"
      }
    ]

    RankedMatchReceipt.build(match, "fixture-room", players, :red,
      ended_at: ~U[2026-05-19 00:02:00Z]
    )
  end
end
