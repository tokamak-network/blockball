defmodule Blockball.WalletAuth.Privy do
  @moduledoc """
  Privy access-token verification for ranked account binding.

  Privy access tokens are JWTs and must be verified on the backend against the
  app verification key before their `sub` DID is trusted.

  Verification key sources, in priority order:

    1. `PRIVY_VERIFICATION_KEY` env (or `:privy_verification_key` config) —
       PEM, raw OKP base64url, or single JWK JSON.
    2. `PRIVY_JWKS` env (or `:privy_jwks` config) — full JWKS JSON document.
    3. Fallback: fetch the JWKS from Privy's well-known endpoint at
       `https://auth.privy.io/api/v1/apps/<PRIVY_APP_ID>/jwks.json` and cache
       the result. This avoids hard-coding key material that Privy rotates.
  """

  require Logger

  @jwks_cache_key {__MODULE__, :remote_jwks_cache}
  @jwks_cache_ttl_ms 10 * 60 * 1000

  def verify_access_token(token) when is_binary(token) and byte_size(token) > 0 do
    case do_verify(token) do
      {:ok, claims} ->
        {:ok, claims}

      {:error, reason} ->
        Logger.warning("Privy access token rejected: #{inspect(reason)}")
        {:error, :invalid_privy_token}
    end
  end

  def verify_access_token(_), do: {:error, :invalid_privy_token}

  defp do_verify(token) do
    with {:ok, jwks} <- verification_jwks(),
         {:ok, claims} <- try_verify_with_refresh(jwks, token),
         :ok <- verify_claims(claims) do
      {:ok, claims}
    end
  end

  defp try_verify_with_refresh(jwks, token) do
    case try_verify(jwks, token) do
      {:ok, claims} ->
        {:ok, claims}

      {:error, :no_match} ->
        # Configured keys did not verify this token. Privy rotates keys, so a
        # cached JWKS may be stale — pull the live JWKS from Privy and retry.
        case fetch_remote_jwks(force: true) do
          {:ok, fresh_jwks} -> try_verify(fresh_jwks, token)
          err -> err
        end
    end
  end

  defp verification_jwks do
    config = Application.get_env(:blockball, :wallet_auth, [])

    cond do
      key = env_or_config("PRIVY_VERIFICATION_KEY", config, :privy_verification_key) ->
        jwks_from_key(key)

      jwks = env_or_config("PRIVY_JWKS", config, :privy_jwks) ->
        jwks_from_jwks(jwks)

      true ->
        fetch_remote_jwks(force: false)
    end
  end

  defp env_or_config(env, config, key) do
    case System.get_env(env) do
      value when is_binary(value) and value != "" -> value
      _ -> config[key]
    end
  end

  defp jwks_from_key(key) do
    cond do
      String.contains?(key, "BEGIN") ->
        {:ok, [JOSE.JWK.from_pem(key)]}

      String.starts_with?(String.trim(key), "{") ->
        jwks_from_jwks(key)

      true ->
        # Privy dashboard keys are commonly pasted as base64url/raw public key material.
        # JOSE can import OKP Ed25519 public keys from raw bytes.
        case Base.url_decode64(String.trim(key), padding: false) do
          {:ok, raw} -> {:ok, [JOSE.JWK.from_okp({:Ed25519, raw})]}
          _ -> {:error, :invalid_privy_verification_key}
        end
    end
  end

  defp jwks_from_jwks(jwks_json) do
    case Jason.decode(jwks_json) do
      {:ok, %{"keys" => keys}} when is_list(keys) and keys != [] ->
        {:ok, Enum.map(keys, &JOSE.JWK.from_map/1)}

      {:ok, %{"kty" => _} = single_key} ->
        {:ok, [JOSE.JWK.from_map(single_key)]}

      _ ->
        {:error, :invalid_privy_jwks}
    end
  end

  defp try_verify(jwks, token) do
    Enum.reduce_while(jwks, {:error, :no_match}, fn jwk, _ ->
      case JOSE.JWT.verify_strict(jwk, allowed_algs(), token) do
        {true, %JOSE.JWT{fields: claims}, _jws} -> {:halt, {:ok, claims}}
        _ -> {:cont, {:error, :no_match}}
      end
    end)
  end

  defp allowed_algs, do: ["EdDSA", "ES256"]

  defp verify_claims(claims) do
    config = Application.get_env(:blockball, :wallet_auth, [])
    app_id = System.get_env("PRIVY_APP_ID") || config[:privy_app_id]
    now = System.system_time(:second)

    cond do
      not is_binary(app_id) or app_id == "" -> {:error, :missing_app_id}
      claims["iss"] != "privy.io" -> {:error, {:invalid_issuer, claims["iss"]}}
      claims["aud"] != app_id -> {:error, {:invalid_audience, claims["aud"], app_id}}
      not is_binary(claims["sub"]) or claims["sub"] == "" -> {:error, :missing_subject}
      not is_integer(claims["exp"]) -> {:error, :missing_expiry}
      claims["exp"] <= now -> {:error, {:expired, claims["exp"], now}}
      true -> :ok
    end
  end

  # --- Remote JWKS fetch + cache -----------------------------------------

  defp fetch_remote_jwks(opts) do
    force = Keyword.get(opts, :force, false)
    app_id = current_app_id()

    if not is_binary(app_id) or app_id == "" do
      {:error, :missing_app_id}
    else
      case (not force) && cached_jwks(app_id) do
        jwks when is_list(jwks) -> {:ok, jwks}
        _ -> do_fetch_remote_jwks(app_id)
      end
    end
  end

  defp current_app_id do
    config = Application.get_env(:blockball, :wallet_auth, [])
    System.get_env("PRIVY_APP_ID") || config[:privy_app_id]
  end

  defp do_fetch_remote_jwks(app_id) do
    url = ~c"https://auth.privy.io/api/v1/apps/#{app_id}/jwks.json"
    request = {url, [{~c"accept", ~c"application/json"}]}
    http_opts = [timeout: 5_000, connect_timeout: 5_000]
    opts = [body_format: :binary]

    case :httpc.request(:get, request, http_opts, opts) do
      {:ok, {{_, 200, _}, _headers, body}} ->
        body = if is_binary(body), do: body, else: IO.iodata_to_binary(body)

        case jwks_from_jwks(body) do
          {:ok, jwks} ->
            cache_jwks(app_id, jwks)
            {:ok, jwks}

          err ->
            err
        end

      {:ok, {{_, status, _}, _headers, _body}} ->
        {:error, {:privy_jwks_http_error, status}}

      {:error, reason} ->
        {:error, {:privy_jwks_fetch_failed, reason}}
    end
  end

  defp cached_jwks(app_id) do
    case :persistent_term.get(@jwks_cache_key, nil) do
      %{app_id: ^app_id, jwks: jwks, expires_at: expires_at} ->
        if System.monotonic_time(:millisecond) < expires_at, do: jwks, else: nil

      _ ->
        nil
    end
  end

  defp cache_jwks(app_id, jwks) do
    expires_at = System.monotonic_time(:millisecond) + @jwks_cache_ttl_ms
    :persistent_term.put(@jwks_cache_key, %{app_id: app_id, jwks: jwks, expires_at: expires_at})
    :ok
  end
end
