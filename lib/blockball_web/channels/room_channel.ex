defmodule BlockballWeb.RoomChannel do
  use BlockballWeb, :channel

  alias Blockball.Game
  alias BlockballWeb.Endpoint

  @chat_max_chars 240

  @impl true
  def join("room:" <> room_id, payload, socket) do
    player_id = socket.assigns.client_id
    raw_name = Map.get(payload, "name", "Player")
    sanitized_name = Game.sanitize_name(raw_name)

    with {:ok, registration} <- normalize_registration(Map.get(payload, "registration")),
         {:ok, reply} <- Game.join(room_id, player_id, raw_name) do
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

  defp normalize_registration(%{"kind" => "privy"} = registration) do
    user_id = registration |> Map.get("privy_user_id", "") |> to_string()
    wallet = registration |> Map.get("wallet_address", "") |> to_string()

    if user_id != "" or valid_wallet_like?(wallet) do
      {:ok, Map.take(registration, allowed_registration_keys())}
    else
      {:error, :registration_required}
    end
  end

  defp normalize_registration(%{"kind" => "external"} = registration) do
    wallet = registration |> Map.get("wallet_address", "") |> to_string()
    signature = registration |> Map.get("signature", "") |> to_string()

    if valid_wallet_like?(wallet) and signature != "" do
      {:ok, Map.take(registration, allowed_registration_keys())}
    else
      {:error, :registration_required}
    end
  end

  defp normalize_registration(%{"kind" => "dev"} = registration) do
    if dev_auth_enabled?() do
      {:ok, Map.take(registration, allowed_registration_keys())}
    else
      {:error, :registration_required}
    end
  end

  defp normalize_registration(_), do: {:error, :registration_required}

  defp allowed_registration_keys do
    ~w(kind provider wallet_address privy_user_id email chain_id signed_message signature issued_at access_token)
  end

  defp valid_wallet_like?("0x" <> rest), do: byte_size(rest) >= 8
  defp valid_wallet_like?(_), do: false

  defp dev_auth_enabled? do
    Application.get_env(:blockball, :wallet_auth, [])[:dev_auth_enabled] == true or
      System.get_env("BLOCKBALL_DEV_AUTH") == "true"
  end
end
