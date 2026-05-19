defmodule BlockballWeb.RoomChannel do
  use BlockballWeb, :channel

  alias Blockball.Game
  alias Blockball.Game.RankedMatchReceipt
  alias Blockball.WalletAuth.Challenges
  alias Blockball.WalletAuth.Privy
  alias BlockballWeb.Endpoint

  @chat_max_chars 240

  @impl true
  def join("room:" <> room_id, payload, socket) do
    player_id = socket.assigns.client_id
    raw_name = Map.get(payload, "name", "Player")
    sanitized_name = Game.sanitize_name(raw_name)

    with {:ok, registration} <- normalize_registration(Map.get(payload, "registration")),
         {:ok, reply} <-
           Game.join(room_id, player_id, raw_name, registration: registration) do
      socket =
        socket
        |> assign(:room_id, reply.room_id)
        |> assign(:player_id, reply.player_id)
        |> assign(:player_name, sanitized_name)
        |> assign(:registration, registration)
        |> assign(:spectator, reply.spectator)

      {:ok, reply, socket}
    else
      {:error, reason} ->
        {:error, %{reason: Atom.to_string(reason)}}
    end
  end

  @impl true
  def handle_in("input", payload, socket) do
    if socket.assigns.player_id do
      Game.input(socket.assigns.room_id, socket.assigns.player_id, payload)
    end

    {:noreply, socket}
  end

  @impl true
  def handle_in("reset", _payload, socket) do
    Game.reset(socket.assigns.room_id)
    {:noreply, socket}
  end

  @impl true
  def handle_in("start_match", _payload, socket) do
    case Game.start_match(socket.assigns.room_id, socket.assigns.player_id) do
      :ok ->
        {:reply, {:ok, %{}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: Atom.to_string(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("chat", payload, socket) do
    text =
      payload
      |> Map.get("text", "")
      |> to_string()
      |> String.trim()
      |> String.slice(0, @chat_max_chars)

    if text != "" do
      Endpoint.broadcast("room:#{socket.assigns.room_id}", "chat", %{
        from: socket.assigns.player_name || "Player",
        client_id: socket.assigns.client_id,
        text: text,
        ts: System.system_time(:millisecond)
      })
    end

    {:noreply, socket}
  end

  @impl true
  def terminate(_reason, socket) do
    if socket.assigns[:room_id] do
      Game.leave(socket.assigns.room_id, socket.assigns.client_id)
    end

    :ok
  end

  # Casual rooms can be joined without any registration (`nil`). Ranked rooms
  # require `verified_wallet_address`; this channel is the boundary that turns
  # client claims into server-verified registration maps.
  defp normalize_registration(%{"kind" => "privy"} = registration) do
    wallet = registration |> Map.get("wallet_address", "") |> to_string()
    access_token = registration |> Map.get("access_token", "") |> to_string()

    with normalized when not is_nil(normalized) <- RankedMatchReceipt.normalize_address(wallet),
         {:ok, claims} <- Privy.verify_access_token(access_token),
         true <- privy_subject_matches?(registration, claims),
         :ok <- verify_wallet_signature(registration, normalized) do
      {:ok, verified_registration(registration, normalized)}
    else
      _ ->
        # Explicit local-only escape hatch for development when Privy backend keys
        # are unavailable. Production fails closed instead of trusting client tokens.
        if dev_auth_enabled?() and dev_privy_registration?(registration) do
          {:ok, verified_registration(registration, wallet)}
        else
          {:error, :registration_required}
        end
    end
  end

  defp normalize_registration(%{"kind" => "external"} = registration) do
    wallet = registration |> Map.get("wallet_address", "") |> to_string()
    message = registration |> Map.get("signed_message", "") |> to_string()
    signature = registration |> Map.get("signature", "") |> to_string()

    with normalized when not is_nil(normalized) <- RankedMatchReceipt.normalize_address(wallet),
         {:ok, _challenge} <- Challenges.consume(message, normalized),
         true <- RankedMatchReceipt.verify_registration_message?(message, normalized),
         {:ok, recovered} <- RankedMatchReceipt.recover_personal_sign_address(message, signature),
         true <- recovered == normalized do
      {:ok, verified_registration(registration, normalized)}
    else
      _ -> {:error, :registration_required}
    end
  end

  defp normalize_registration(%{"kind" => "dev"} = registration) do
    wallet = registration |> Map.get("wallet_address", "") |> to_string()

    if dev_auth_enabled?() and RankedMatchReceipt.normalize_address(wallet) do
      {:ok, verified_registration(registration, wallet)}
    else
      {:error, :registration_required}
    end
  end

  defp normalize_registration(nil), do: {:ok, nil}
  defp normalize_registration(%{} = empty) when map_size(empty) == 0, do: {:ok, nil}
  defp normalize_registration(_), do: {:error, :registration_required}

  defp allowed_registration_keys do
    ~w(kind provider wallet_address verified_wallet_address privy_user_id email chain_id signed_message signature issued_at access_token)
  end

  defp verified_registration(registration, wallet) do
    registration
    |> Map.take(allowed_registration_keys())
    |> Map.put("verified_wallet_address", RankedMatchReceipt.normalize_address!(wallet))
  end

  defp verify_wallet_signature(registration, wallet) do
    message = registration |> Map.get("signed_message", "") |> to_string()
    signature = registration |> Map.get("signature", "") |> to_string()

    with {:ok, _challenge} <- Challenges.consume(message, wallet),
         true <- RankedMatchReceipt.verify_registration_message?(message, wallet),
         {:ok, recovered} <- RankedMatchReceipt.recover_personal_sign_address(message, signature),
         true <- recovered == wallet do
      :ok
    else
      _ -> {:error, :wallet_signature_required}
    end
  end

  defp privy_subject_matches?(registration, claims) do
    user_id = registration |> Map.get("privy_user_id", "") |> to_string()
    user_id != "" and claims["sub"] == user_id
  end

  defp dev_privy_registration?(registration) do
    wallet = registration |> Map.get("wallet_address", "") |> to_string()
    user_id = registration |> Map.get("privy_user_id", "") |> to_string()
    RankedMatchReceipt.normalize_address(wallet) != nil and user_id != ""
  end

  defp dev_auth_enabled? do
    Application.get_env(:blockball, :wallet_auth, [])[:dev_auth_enabled] == true or
      System.get_env("BLOCKBALL_DEV_AUTH") == "true"
  end
end
