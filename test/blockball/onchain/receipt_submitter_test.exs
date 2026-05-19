defmodule Blockball.Onchain.ReceiptSubmitterTest do
  use ExUnit.Case, async: true

  alias Blockball.Onchain.ReceiptSubmitter

  test "builds cast tuple matching BlockballReceipts submitReceipt ABI" do
    receipt = %{
      l2_payload: %{
        receipt: %{
          matchId: "0x01",
          seasonId: 1,
          roomId: "0x02",
          matchType: 1,
          outcome: 1,
          scoreRed: 3,
          scoreBlue: 1,
          replayHash: "0x03",
          startedAt: 10,
          endedAt: 20,
          redPlayers: ["0x1000000000000000000000000000000000000001"],
          bluePlayers: ["0x2000000000000000000000000000000000000002"]
        }
      }
    }

    assert {:ok,
            "(0x01,1,0x02,1,1,3,1,0x03,10,20,[0x1000000000000000000000000000000000000001],[0x2000000000000000000000000000000000000002])"} =
             ReceiptSubmitter.cast_receipt_tuple(receipt)
  end
end
