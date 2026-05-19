defmodule Blockball.WalletAuth.IdentifierTest do
  use ExUnit.Case, async: true

  alias Blockball.WalletAuth.Identifier

  test "hash lower-cases and trims before keccak" do
    {:ok, h1} = Identifier.hash("Alice@Example.com")
    {:ok, h2} = Identifier.hash("  alice@example.com  ")
    expected = ExKeccak.hash_256("alice@example.com")

    assert h1 == expected
    assert h2 == expected
    assert byte_size(h1) == 32
  end

  test "rejects blank or non-binary identifiers" do
    assert {:error, :invalid_identifier} = Identifier.hash("")
    assert {:error, :invalid_identifier} = Identifier.hash("   ")
    assert {:error, :invalid_identifier} = Identifier.hash(nil)
    assert {:error, :invalid_identifier} = Identifier.hash(123)
  end

  test "normalize returns canonical form" do
    assert {:ok, "alice@example.com"} = Identifier.normalize(" Alice@Example.com ")
    assert {:error, :invalid_identifier} = Identifier.normalize("")
  end
end
