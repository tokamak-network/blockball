defmodule Blockball.Game.NicknameTest do
  use ExUnit.Case, async: true

  alias Blockball.Game.Nickname

  test "sanitize trims and accepts valid names" do
    eighteen = String.duplicate("a", 18)
    assert {:ok, "NeonK"} = Nickname.sanitize("  NeonK  ")
    assert {:ok, "abc_123"} = Nickname.sanitize("abc_123")
    assert {:ok, "AB"} = Nickname.sanitize("AB")
    assert {:ok, ^eighteen} = Nickname.sanitize(eighteen)
  end

  test "sanitize rejects length violations" do
    assert {:error, :nickname_too_short} = Nickname.sanitize("A")
    assert {:error, :nickname_too_short} = Nickname.sanitize(" ")
    assert {:error, :nickname_too_long} = Nickname.sanitize(String.duplicate("a", 19))
  end

  test "sanitize rejects invalid characters" do
    assert {:error, :nickname_invalid_chars} = Nickname.sanitize("hi there")
    assert {:error, :nickname_invalid_chars} = Nickname.sanitize("emoji😀")
    assert {:error, :nickname_invalid_chars} = Nickname.sanitize("dash-name")
  end

  test "sanitize rejects non-binary" do
    assert {:error, :nickname_invalid} = Nickname.sanitize(nil)
    assert {:error, :nickname_invalid} = Nickname.sanitize(123)
  end

  test "key is case-insensitive" do
    assert Nickname.key("NeonK") == Nickname.key("neonk")
    assert Nickname.key("NEONK") == Nickname.key("neonk")
    assert byte_size(Nickname.key("NeonK")) == 32
  end
end
