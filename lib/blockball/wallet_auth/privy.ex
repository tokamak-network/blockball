defmodule Blockball.WalletAuth.Privy do
  @moduledoc """
  Privy access-token verification for ranked account binding.

  Privy access tokens are JWTs and must be verified on the backend against the
  app verification key before their `sub` DID is trusted.
  """

  def verify_access_token(token) when is_binary(token) and byte_size(token) > 0 do
    with {:ok, jwk} <- verification_jwk(),
         {true, %JOSE.JWT{fields: claims}, _jws} <-
           JOSE.JWT.verify_strict(jwk, allowed_algs(), token),
         :ok <- verify_claims(claims) do
      {:ok, claims}
    else
      _ -> {:error, :invalid_privy_token}
    end
  end

  def verify_access_token(_), do: {:error, :invalid_privy_token}

  defp verification_jwk do
    config = Application.get_env(:blockball, :wallet_auth, [])

    cond do
      key = System.get_env("PRIVY_VERIFICATION_KEY") || config[:privy_verification_key] ->
        jwk_from_key(key)

      jwks = System.get_env("PRIVY_JWKS") || config[:privy_jwks] ->
        jwk_from_jwks(jwks)

      true ->
        {:error, :privy_verification_key_missing}
    end
  end

  defp jwk_from_key(key) do
    cond do
      String.contains?(key, "BEGIN") ->
        {:ok, JOSE.JWK.from_pem(key)}

      String.starts_with?(String.trim(key), "{") ->
        jwk_from_jwks(key)

      true ->
        # Privy dashboard keys are commonly pasted as base64url/raw public key material.
        # JOSE can import OKP Ed25519 public keys from raw bytes.
        case Base.url_decode64(String.trim(key), padding: false) do
          {:ok, raw} -> {:ok, JOSE.JWK.from_okp({:Ed25519, raw})}
          _ -> {:error, :invalid_privy_verification_key}
        end
    end
  end

  defp jwk_from_jwks(jwks_json) do
    with {:ok, %{"keys" => [first | _]}} <- Jason.decode(jwks_json) do
      {:ok, JOSE.JWK.from_map(first)}
    else
      {:ok, jwk_map} when is_map(jwk_map) -> {:ok, JOSE.JWK.from_map(jwk_map)}
      _ -> {:error, :invalid_privy_jwks}
    end
  end

  defp allowed_algs, do: ["EdDSA", "ES256"]

  defp verify_claims(claims) do
    config = Application.get_env(:blockball, :wallet_auth, [])
    app_id = System.get_env("PRIVY_APP_ID") || config[:privy_app_id]
    now = System.system_time(:second)

    cond do
      not is_binary(app_id) or app_id == "" -> {:error, :missing_app_id}
      claims["iss"] != "privy.io" -> {:error, :invalid_issuer}
      claims["aud"] != app_id -> {:error, :invalid_audience}
      not is_binary(claims["sub"]) or claims["sub"] == "" -> {:error, :missing_subject}
      not is_integer(claims["exp"]) -> {:error, :missing_expiry}
      claims["exp"] <= now -> {:error, :expired}
      true -> :ok
    end
  end
end
