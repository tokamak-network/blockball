defmodule Blockball.WalletAuth.ChallengesTest do
  use ExUnit.Case, async: false

  alias Blockball.WalletAuth.Challenges

  @address "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"

  test "issues single-use wallet registration challenges" do
    challenge = Challenges.issue(@address, domain: "example.test", nonce: "nonce-1")

    assert challenge.message =~ "Blockball registration\nDomain: example.test"
    assert challenge.message =~ "Address: #{@address}"
    assert challenge.message =~ "Nonce: nonce-1"

    assert {:ok, ^challenge} = Challenges.consume(challenge.message, @address)

    assert {:error, :invalid_or_expired_challenge} =
             Challenges.consume(challenge.message, @address)
  end
end
