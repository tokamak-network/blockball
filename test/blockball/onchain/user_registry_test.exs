defmodule Blockball.Onchain.UserRegistryTest do
  use ExUnit.Case, async: false

  alias Blockball.Onchain.UserRegistry

  @config %{
    contract_address: "0xCAfECAFECAfECAfECAFECaFeCaFEcaFEcafECAfe",
    rpc_url: "https://example.test",
    submitter_private_key: "0xPK",
    cast_path: "cast",
    confirmations: 1
  }

  describe "call_args/3" do
    test "shapes the cast call invocation" do
      args =
        UserRegistry.call_args(@config, "isNicknameFree(string)(bool)", ["NeonK"])

      assert args == [
               "call",
               "0xCAfECAFECAfECAfECAFECaFeCaFEcaFEcafECAfe",
               "isNicknameFree(string)(bool)",
               "NeonK",
               "--rpc-url",
               "https://example.test"
             ]
    end
  end

  describe "send_args/3" do
    test "shapes the cast send invocation" do
      args =
        UserRegistry.send_args(@config, "updateNickname(address,string)", [
          "0xabc",
          "NeonK"
        ])

      assert args == [
               "send",
               "0xCAfECAFECAfECAfECAFECaFeCaFEcaFEcafECAfe",
               "updateNickname(address,string)",
               "0xabc",
               "NeonK",
               "--rpc-url",
               "https://example.test",
               "--private-key",
               "0xPK",
               "--confirmations",
               "1",
               "--json"
             ]
    end
  end

  describe "parse_lookup_output/1" do
    test "returns :not_registered for empty identifier" do
      zero = "0x" <> String.duplicate("0", 64)
      assert {:ok, :not_registered} = UserRegistry.parse_lookup_output(zero <> "\n")
    end

    test "decodes multi-line lookup output" do
      id_hex = "0x" <> String.duplicate("ab", 32)
      {:ok, expected} = Base.decode16(String.duplicate("ab", 32), case: :mixed)

      assert {:ok, %{identifier: ^expected, nickname: "NeonK"}} =
               UserRegistry.parse_lookup_output("#{id_hex}\nNeonK")
    end

    test "strips wrapping quotes from quoted nickname" do
      id_hex = "0x" <> String.duplicate("ab", 32)

      assert {:ok, %{nickname: "NeonK"}} =
               UserRegistry.parse_lookup_output("#{id_hex}\n\"NeonK\"")
    end

    test "errors on malformed bytes32" do
      assert {:error, :invalid_bytes32} =
               UserRegistry.parse_lookup_output("not-hex\nNeonK")
    end

    test "decodes single-line tuple form for unregistered wallet" do
      zero = "0x" <> String.duplicate("0", 64)

      assert {:ok, :not_registered} =
               UserRegistry.parse_lookup_output("(#{zero}, \"\")\n")
    end

    test "decodes single-line tuple form for registered wallet" do
      id_hex = "0x" <> String.duplicate("ab", 32)
      {:ok, expected} = Base.decode16(String.duplicate("ab", 32), case: :mixed)

      assert {:ok, %{identifier: ^expected, nickname: "NeonK"}} =
               UserRegistry.parse_lookup_output("(#{id_hex}, \"NeonK\")\n")
    end
  end

  describe "parse_send_output/1" do
    test "extracts tx_hash from cast --json output" do
      json =
        Jason.encode!(%{
          "transactionHash" => "0xdeadbeef",
          "blockNumber" => "0x10"
        })

      assert {:ok, %{tx_hash: "0xdeadbeef", block_number: "0x10"}} =
               UserRegistry.parse_send_output(json)
    end

    test "returns error on invalid json" do
      assert {:error, {:invalid_cast_json, "not json"}} =
               UserRegistry.parse_send_output("not json")
    end
  end

  describe "registry_config/0" do
    setup do
      original_user_registry = Application.get_env(:blockball, :user_registry)
      original_ranked = Application.get_env(:blockball, :ranked_receipts)
      original_env = %{
        contract: System.get_env("BLOCKBALL_USER_REGISTRY_CONTRACT"),
        rpc: System.get_env("BLOCKBALL_RPC_URL"),
        submitter: System.get_env("BLOCKBALL_RECEIPT_SUBMITTER_PRIVATE_KEY"),
        signer: System.get_env("BLOCKBALL_RECEIPT_SIGNER_PRIVATE_KEY")
      }

      on_exit(fn ->
        put_or_delete(:user_registry, original_user_registry)
        put_or_delete(:ranked_receipts, original_ranked)
        env_put_or_delete("BLOCKBALL_USER_REGISTRY_CONTRACT", original_env.contract)
        env_put_or_delete("BLOCKBALL_RPC_URL", original_env.rpc)
        env_put_or_delete("BLOCKBALL_RECEIPT_SUBMITTER_PRIVATE_KEY", original_env.submitter)
        env_put_or_delete("BLOCKBALL_RECEIPT_SIGNER_PRIVATE_KEY", original_env.signer)
      end)

      :ok
    end

    test "errors when contract address missing" do
      Application.put_env(:blockball, :user_registry, contract_address: nil)
      Application.put_env(:blockball, :ranked_receipts, [])

      System.delete_env("BLOCKBALL_USER_REGISTRY_CONTRACT")
      System.put_env("BLOCKBALL_RPC_URL", "https://example.test")
      System.put_env("BLOCKBALL_RECEIPT_SUBMITTER_PRIVATE_KEY", "0xpk")

      assert {:error, :contract_address_not_configured} = UserRegistry.registry_config()
    end
  end

  defp put_or_delete(key, nil), do: Application.delete_env(:blockball, key)
  defp put_or_delete(key, value), do: Application.put_env(:blockball, key, value)

  defp env_put_or_delete(name, nil), do: System.delete_env(name)
  defp env_put_or_delete(name, value), do: System.put_env(name, value)
end
