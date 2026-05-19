defmodule Blockball.Game.Room do
  @moduledoc false

  use GenServer

  alias Blockball.Game
  alias Blockball.Game.Leaderboard
  alias Blockball.Game.RankedMatchReceipt
  alias Blockball.Onchain.ReceiptSubmitter
  alias Blockball.Util
  alias BlockballWeb.Endpoint

  @tick_ms 16
  @snapshot_ms 33
  @match_seconds 120
  @bot_id "practice-bot"
  @arena %{
    width: 1600.0,
    height: 900.0,
    goal_size: 260.0,
    goal_depth: 64.0,
    corner_radius: 96.0
  }
  @public_capacity 8
  @practice_capacity 1
  @spawn_lane_gap 64.0
  @player_radius 18.0
  @ball_radius 11.0
  @max_speed 240.0
  @player_accel 760.0
  @player_friction 0.965
  @ball_friction 0.985
  @max_ball_speed 720.0
  @kick_impulse 640.0
  @kick_cooldown 0.18
  @wall_restitution 0.5
  @player_inv_mass 1.0
  @ball_inv_mass 2.0
  @dribble_restitution 0.1

  @doc """
  Physics constants needed by the client for local prediction and bounds checks.
  Single source of truth — must stay co-located with the @-attributes above.
  """
  @spec physics_config() :: map()
  def physics_config do
    %{
      tick_ms: @tick_ms,
      player_radius: @player_radius,
      ball_radius: @ball_radius,
      max_speed: @max_speed,
      player_accel: @player_accel,
      player_friction: @player_friction,
      ball_friction: @ball_friction,
      max_ball_speed: @max_ball_speed,
      wall_restitution: @wall_restitution,
      arena: @arena
    }
  end

  def start_link({room_id, opts}) when is_list(opts) do
    GenServer.start_link(__MODULE__, {room_id, opts}, name: Game.via(room_id))
  end

  def start_link(room_id) do
    GenServer.start_link(__MODULE__, {room_id, []}, name: Game.via(room_id))
  end

  @impl true
  def init({room_id, opts}) do
    id = Game.sanitize_room(room_id)
    mode = Keyword.get(opts, :mode, :public)
    # Casual is the default. Ranked is opt-in and disabled for practice rooms.
    ranked_opt = Keyword.get(opts, :ranked, false)
    ranked = ranked_opt and mode != :practice

    state = %{
      id: id,
      name: Keyword.get(opts, :name, default_name(id, mode)),
      mode: mode,
      ranked: ranked,
      capacity: Keyword.get(opts, :capacity, default_capacity(mode)),
      created_at: DateTime.utc_now(),
      players: %{},
      spectators: MapSet.new(),
      host_id: nil,
      ball: new_ball(),
      match: new_match(:waiting),
      receipts: [],
      secret: :crypto.strong_rand_bytes(32),
      last_snapshot_at: now_ms()
    }

    Process.send_after(self(), :tick, @tick_ms)
    {:ok, state}
  end

  # Ranked rooms require a server-verified wallet address.
  defp ranked_registration_ok?(nil), do: false

  defp ranked_registration_ok?(reg) when is_map(reg) do
    verified_wallet_address(reg) != nil
  end

  defp ranked_registration_ok?(_), do: false

  defp verified_wallet_address(reg) when is_map(reg) do
    reg
    |> get_field("verified_wallet_address")
    |> RankedMatchReceipt.normalize_address()
  end

  defp verified_wallet_address(_), do: nil

  defp get_field(map, key) do
    Map.get(map, key) || Map.get(map, String.to_atom(key))
  end

  defp default_name(id, :practice), do: "Practice #{id}"
  defp default_name(id, _), do: "Room #{id}"
  defp default_capacity(:practice), do: @practice_capacity
  defp default_capacity(:vs1), do: 2
  defp default_capacity(:vs2), do: 4
  defp default_capacity(:vs3), do: 6
  defp default_capacity(:vs4), do: 8
  defp default_capacity(_), do: @public_capacity

  @impl true
  def handle_call(:meta, _from, state) do
    {:reply, meta(state), state}
  end

  @impl true
  def handle_call({:join, player_id, name, join_opts}, _from, state) do
    human_count = state.players |> Map.values() |> Enum.count(&(!&1.is_bot))
    name = Game.sanitize_name(name)
    practice_full? = state.mode == :practice and human_count >= 1
    registration = Keyword.get(join_opts, :registration)

    cond do
      practice_full? ->
        {:reply, {:error, :practice_locked}, state}

      state.ranked and not ranked_registration_ok?(registration) ->
        {:reply, {:error, :wallet_required}, state}

      human_count < state.capacity ->
        team = assign_team(state)
        player = new_player(player_id, name, team, verified_wallet_address(registration))

        state =
          state
          |> put_in([:players, player_id], player)
          |> assign_host_if_needed(player_id)
          |> ensure_bot()
          |> maybe_start_match()

        reply = %{
          player_id: player_id,
          room_id: state.id,
          team: team,
          spectator: false,
          host_id: state.host_id,
          snapshot: snapshot(state)
        }

        broadcast_system(state, "#{name} joined #{state.id}.")
        {:reply, {:ok, reply}, state}

      true ->
        state = %{state | spectators: MapSet.put(state.spectators, player_id)}

        reply = %{
          player_id: nil,
          room_id: state.id,
          team: nil,
          spectator: true,
          host_id: state.host_id,
          snapshot: snapshot(state)
        }

        broadcast_system(state, "#{name} joined #{state.id}.")
        {:reply, {:ok, reply}, state}
    end
  end

  @impl true
  def handle_call({:start_match, player_id}, _from, state) do
    human_count = state.players |> Map.values() |> Enum.count(&(!&1.is_bot))

    cond do
      state.match.status != :waiting ->
        {:reply, {:error, :not_waiting}, state}

      state.host_id != player_id ->
        {:reply, {:error, :not_host}, state}

      human_count < state.capacity ->
        {:reply, {:error, :not_full}, state}

      true ->
        state = reset_match(state)
        broadcast_system(state, "Match started.")
        {:reply, :ok, state}
    end
  end

  @impl true
  def handle_cast({:leave, player_id}, state) do
    state =
      state
      |> update_in([:players], &Map.delete(&1, player_id))
      |> update_in([:spectators], &MapSet.delete(&1, player_id))
      |> reassign_host_if_needed(player_id)
      |> ensure_bot()

    {:noreply, state}
  end

  @impl true
  def handle_cast({:input, player_id, input}, state) do
    input = normalize_input(input)

    state =
      update_in(state.players[player_id], fn
        nil -> nil
        player -> %{player | input: input}
      end)

    {:noreply, state}
  end

  @impl true
  def handle_cast(:reset, state) do
    state = reset_match(state)
    broadcast_system(state, "Match reset.")
    {:noreply, state}
  end

  @impl true
  def handle_info(:tick, state) do
    state = step(state)
    current = now_ms()

    state =
      if current - state.last_snapshot_at >= @snapshot_ms do
        Endpoint.broadcast("room:#{state.id}", "snapshot", snapshot(state))
        %{state | last_snapshot_at: current}
      else
        state
      end

    Process.send_after(self(), :tick, @tick_ms)
    {:noreply, state}
  end

  @impl true
  def handle_info(:reset_after_complete, state) do
    state =
      if map_size(state.players) > 0 do
        reset_match(state)
      else
        state
      end

    {:noreply, state}
  end

  defp maybe_start_match(%{mode: :practice, match: %{status: :waiting}, players: players} = state)
       when map_size(players) > 0 do
    reset_match(state)
  end

  defp maybe_start_match(state), do: state

  defp assign_host_if_needed(%{host_id: nil} = state, player_id),
    do: %{state | host_id: player_id}

  defp assign_host_if_needed(state, _player_id), do: state

  defp reassign_host_if_needed(%{host_id: host_id} = state, leaving_id)
       when host_id == leaving_id do
    %{state | host_id: next_host_candidate(state.players)}
  end

  defp reassign_host_if_needed(state, _leaving_id), do: state

  defp next_host_candidate(players) do
    players
    |> Map.values()
    |> Enum.reject(& &1.is_bot)
    |> Enum.sort_by(& &1.joined_at)
    |> case do
      [first | _] -> first.id
      [] -> nil
    end
  end

  defp reset_match(state) do
    match = new_match(:live)
    players = Enum.into(state.players, %{}, fn {id, player} -> {id, %{player | goals: 0}} end)

    %{state | match: match, players: players, ball: new_ball()}
    |> reset_positions()
  end

  defp new_match(status) do
    started_at = DateTime.utc_now()

    %{
      id: Util.random_id(10),
      season_id: 1,
      season_label: "blockball-alpha-01",
      status: status,
      started_at: started_at,
      ends_at_ms: now_ms() + @match_seconds * 1000,
      time_left: @match_seconds,
      red_score: 0,
      blue_score: 0,
      goal_pause: 0.8,
      events: [],
      message: if(status == :live, do: "Match live.", else: "Waiting for players.")
    }
  end

  defp new_ball do
    %{x: @arena.width / 2, y: @arena.height / 2, vx: 0.0, vy: 0.0, radius: @ball_radius}
  end

  defp new_player(id, name, team, verified_wallet_address \\ nil) do
    spawn = spawn_for(team)

    %{
      id: id,
      name: name,
      team: team,
      x: spawn.x,
      y: spawn.y,
      vx: 0.0,
      vy: 0.0,
      radius: @player_radius,
      kick_cooldown: 0.0,
      goals: 0,
      verified_wallet_address: verified_wallet_address,
      is_bot: false,
      joined_at: System.system_time(:millisecond),
      input: empty_input()
    }
  end

  defp new_bot do
    @bot_id
    |> new_player("Practice Bot", :blue)
    |> Map.put(:is_bot, true)
  end

  defp empty_input do
    %{up: false, down: false, left: false, right: false, kick: false}
  end

  defp normalize_input(input) do
    %{
      up: truthy?(input["up"] || input[:up]),
      down: truthy?(input["down"] || input[:down]),
      left: truthy?(input["left"] || input[:left]),
      right: truthy?(input["right"] || input[:right]),
      kick: truthy?(input["kick"] || input[:kick])
    }
  end

  defp truthy?(value), do: value in [true, "true", 1, "1"]

  defp ensure_bot(state) do
    human_count = state.players |> Map.values() |> Enum.count(&(!&1.is_bot))
    has_bot = Map.has_key?(state.players, @bot_id)

    cond do
      state.mode == :practice and human_count == 1 and not has_bot ->
        state
        |> put_in([:players, @bot_id], new_bot())
        |> put_in([:match, :message], "Practice bot joined.")
        |> reset_positions()

      has_bot and state.mode != :practice ->
        state
        |> update_in([:players], &Map.delete(&1, @bot_id))
        |> reset_positions()

      true ->
        state
    end
  end

  defp assign_team(state) do
    humans = state.players |> Map.values() |> Enum.reject(& &1.is_bot)
    red = Enum.count(humans, &(&1.team == :red))
    blue = Enum.count(humans, &(&1.team == :blue))
    if red <= blue, do: :red, else: :blue
  end

  defp spawn_for(:red), do: %{x: @arena.width * 0.28, y: @arena.height / 2}
  defp spawn_for(:blue), do: %{x: @arena.width * 0.72, y: @arena.height / 2}

  defp reset_positions(state) do
    team_totals =
      state.players
      |> Map.values()
      |> Enum.frequencies_by(& &1.team)

    {players, _seen} =
      Enum.reduce(state.players, {%{}, %{red: 0, blue: 0}}, fn {id, player}, {acc, seen} ->
        index = Map.get(seen, player.team, 0)
        total = Map.get(team_totals, player.team, 1)
        offset = spawn_lane_offset(index, total)
        spawn = spawn_for(player.team)

        player = %{
          player
          | x: spawn.x,
            y: spawn.y + offset,
            vx: 0.0,
            vy: 0.0
        }

        {Map.put(acc, id, player), Map.update(seen, player.team, 1, &(&1 + 1))}
      end)

    %{state | players: players, ball: new_ball()}
  end

  defp spawn_lane_offset(index, total) do
    (index - (total - 1) / 2) * @spawn_lane_gap
  end

  defp step(%{players: players} = state) when map_size(players) == 0, do: state
  defp step(%{match: %{status: :complete}} = state), do: state
  defp step(%{match: %{status: :waiting}} = state), do: maybe_start_match(state)

  defp step(state) do
    time_left = max(0.0, (state.match.ends_at_ms - now_ms()) / 1000)
    state = put_in(state.match.time_left, time_left)

    cond do
      time_left <= 0.0 ->
        complete_match(state)

      state.match.goal_pause > 0.0 ->
        update_in(state.match.goal_pause, &max(0.0, &1 - dt()))

      true ->
        state
        |> update_players()
        |> resolve_player_collisions()
        |> resolve_ball_players()
        |> update_ball()
    end
  end

  defp update_players(state) do
    players =
      state.players
      |> Enum.into(%{}, fn {id, player} ->
        player = if player.is_bot, do: update_bot(state, player), else: player
        {id, update_player(player)}
      end)

    %{state | players: players}
  end

  defp update_bot(state, bot) do
    ball = state.ball
    dx = ball.x - bot.x
    dy = ball.y - bot.y
    distance = :math.sqrt(dx * dx + dy * dy)

    near_x_wall = ball.x < @ball_radius + 8.0 or ball.x > @arena.width - @ball_radius - 8.0
    near_y_wall = ball.y < @ball_radius + 8.0 or ball.y > @arena.height - @ball_radius - 8.0
    ball_in_corner = near_x_wall and near_y_wall

    target =
      cond do
        ball_in_corner and distance < 90.0 ->
          %{x: @arena.width * 0.6, y: @arena.height / 2}

        ball.x > @arena.width * 0.58 ->
          %{x: ball.x, y: ball.y}

        true ->
          %{x: max(ball.x + 110.0, @arena.width * 0.72), y: @arena.height / 2}
      end

    input = %{
      up: target.y < bot.y - 12.0,
      down: target.y > bot.y + 12.0,
      left: target.x < bot.x - 12.0,
      right: target.x > bot.x + 12.0,
      kick: distance < 64.0 and not ball_in_corner
    }

    %{bot | input: input}
  end

  defp update_player(player) do
    axis_x =
      if(player.input.right, do: 1.0, else: 0.0) - if(player.input.left, do: 1.0, else: 0.0)

    axis_y = if(player.input.down, do: 1.0, else: 0.0) - if(player.input.up, do: 1.0, else: 0.0)
    {dir_x, dir_y, _len} = normalize(axis_x, axis_y)

    player
    |> Map.update!(:vx, &((&1 + dir_x * @player_accel * dt()) * @player_friction))
    |> Map.update!(:vy, &((&1 + dir_y * @player_accel * dt()) * @player_friction))
    |> cap_player_speed()
    |> move_player()
    |> cool_player()
  end

  defp cap_player_speed(player) do
    speed = :math.sqrt(player.vx * player.vx + player.vy * player.vy)

    if speed > @max_speed do
      %{player | vx: player.vx / speed * @max_speed, vy: player.vy / speed * @max_speed}
    else
      player
    end
  end

  defp move_player(player) do
    player = %{player | x: player.x + player.vx * dt(), y: player.y + player.vy * dt()}
    clamp_player_walls(player)
  end

  defp clamp_player_walls(player) do
    r = @arena.corner_radius
    pr = player.radius

    cond do
      player.x < r and player.y < r ->
        reflect_player_corner(player, r, r, r - pr)

      player.x > @arena.width - r and player.y < r ->
        reflect_player_corner(player, @arena.width - r, r, r - pr)

      player.x < r and player.y > @arena.height - r ->
        reflect_player_corner(player, r, @arena.height - r, r - pr)

      player.x > @arena.width - r and player.y > @arena.height - r ->
        reflect_player_corner(player, @arena.width - r, @arena.height - r, r - pr)

      true ->
        player |> clamp_player_x() |> clamp_player_y()
    end
  end

  defp reflect_player_corner(player, cx, cy, max_dist) do
    dx = player.x - cx
    dy = player.y - cy
    dist = max(:math.sqrt(dx * dx + dy * dy), 0.001)

    if dist > max_dist do
      nx = dx / dist
      ny = dy / dist
      v_dot_n = player.vx * nx + player.vy * ny

      {vx, vy} =
        if v_dot_n > 0.0 do
          {
            player.vx - (1.0 + @wall_restitution) * v_dot_n * nx,
            player.vy - (1.0 + @wall_restitution) * v_dot_n * ny
          }
        else
          {player.vx, player.vy}
        end

      %{player | x: cx + nx * max_dist, y: cy + ny * max_dist, vx: vx, vy: vy}
    else
      player
    end
  end

  defp clamp_player_x(player) do
    cond do
      player.x < player.radius ->
        %{player | x: player.radius, vx: abs(player.vx) * @wall_restitution}

      player.x > @arena.width - player.radius ->
        %{player | x: @arena.width - player.radius, vx: -abs(player.vx) * @wall_restitution}

      true ->
        player
    end
  end

  defp clamp_player_y(player) do
    cond do
      player.y < player.radius ->
        %{player | y: player.radius, vy: abs(player.vy) * @wall_restitution}

      player.y > @arena.height - player.radius ->
        %{player | y: @arena.height - player.radius, vy: -abs(player.vy) * @wall_restitution}

      true ->
        player
    end
  end

  defp cool_player(player) do
    %{player | kick_cooldown: max(0.0, player.kick_cooldown - dt())}
  end

  defp resolve_player_collisions(state) do
    players = Map.values(state.players)

    players =
      for a <- players, reduce: state.players do
        acc ->
          Enum.reduce(players, acc, fn b, inner ->
            if a.id < b.id, do: collide_players(inner, a.id, b.id), else: inner
          end)
      end

    %{state | players: players}
  end

  defp collide_players(players, a_id, b_id) do
    a = players[a_id]
    b = players[b_id]
    dx = b.x - a.x
    dy = b.y - a.y
    dist = max(:math.sqrt(dx * dx + dy * dy), 0.001)
    min_dist = a.radius + b.radius

    if dist >= min_dist do
      players
    else
      nx = dx / dist
      ny = dy / dist
      overlap = min_dist - dist

      a =
        %{a | x: a.x - nx * overlap * 0.5, y: a.y - ny * overlap * 0.5}
        |> clamp_player_walls()

      b =
        %{b | x: b.x + nx * overlap * 0.5, y: b.y + ny * overlap * 0.5}
        |> clamp_player_walls()

      Map.merge(players, %{a_id => a, b_id => b})
    end
  end

  defp resolve_ball_players(state) do
    Enum.reduce(state.players, state, fn {_id, player}, acc ->
      resolve_ball_player(acc, player)
    end)
  end

  defp resolve_ball_player(state, player) do
    ball = state.ball
    dx = ball.x - player.x
    dy = ball.y - player.y
    dist = max(:math.sqrt(dx * dx + dy * dy), 0.001)
    min_dist = ball.radius + player.radius

    if dist >= min_dist do
      state
    else
      nx = dx / dist
      ny = dy / dist
      overlap = min_dist - dist
      inv_total = @player_inv_mass + @ball_inv_mass
      ball_share = @ball_inv_mass / inv_total
      player_share = @player_inv_mass / inv_total

      ball_target_x = ball.x + nx * overlap * ball_share
      ball_target_y = ball.y + ny * overlap * ball_share

      goal_top = @arena.height / 2 - @arena.goal_size / 2
      goal_bottom = @arena.height / 2 + @arena.goal_size / 2
      in_goal_mouth_y = ball_target_y > goal_top and ball_target_y < goal_bottom

      {ball_x, ball_y} =
        clamp_ball_to_playable(ball_target_x, ball_target_y, ball.radius, in_goal_mouth_y)

      extra_dx = ball_target_x - ball_x
      extra_dy = ball_target_y - ball_y

      ball = %{ball | x: ball_x, y: ball_y}

      player =
        %{
          player
          | x: player.x - nx * overlap * player_share - extra_dx,
            y: player.y - ny * overlap * player_share - extra_dy
        }
        |> clamp_player_walls()

      rel_normal = (ball.vx - player.vx) * nx + (ball.vy - player.vy) * ny

      {ball, player} =
        if rel_normal < 0.0 do
          j = -(1.0 + @dribble_restitution) * rel_normal / inv_total

          ball = %{
            ball
            | vx: ball.vx + j * @ball_inv_mass * nx,
              vy: ball.vy + j * @ball_inv_mass * ny
          }

          player = %{
            player
            | vx: player.vx - j * @player_inv_mass * nx,
              vy: player.vy - j * @player_inv_mass * ny
          }

          {ball, player}
        else
          {ball, player}
        end

      {ball, player} =
        if player.input.kick and player.kick_cooldown <= 0.0 do
          {
            %{
              ball
              | vx: ball.vx + nx * @kick_impulse,
                vy: ball.vy + ny * @kick_impulse
            },
            %{player | kick_cooldown: @kick_cooldown}
          }
        else
          {ball, player}
        end

      %{state | ball: ball, players: Map.put(state.players, player.id, player)}
    end
  end

  defp update_ball(state) do
    ball = %{
      state.ball
      | x: state.ball.x + state.ball.vx * dt(),
        y: state.ball.y + state.ball.vy * dt(),
        vx: state.ball.vx * @ball_friction,
        vy: state.ball.vy * @ball_friction
    }

    speed = :math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy)

    ball =
      if speed > @max_ball_speed,
        do: %{ball | vx: ball.vx / speed * @max_ball_speed, vy: ball.vy / speed * @max_ball_speed},
        else: ball

    ball = escape_corner(ball)

    goal_top = @arena.height / 2 - @arena.goal_size / 2
    goal_bottom = @arena.height / 2 + @arena.goal_size / 2
    in_goal_mouth = ball.y > goal_top and ball.y < goal_bottom

    state = %{state | ball: bounce_ball(ball, in_goal_mouth)}

    cond do
      in_goal_mouth and state.ball.x + @ball_radius < 0 -> score_goal(state, :blue)
      in_goal_mouth and state.ball.x - @ball_radius > @arena.width -> score_goal(state, :red)
      true -> state
    end
  end

  defp escape_corner(ball) do
    near_x = ball.x < ball.radius + 3.0 or ball.x > @arena.width - ball.radius - 3.0
    near_y = ball.y < ball.radius + 3.0 or ball.y > @arena.height - ball.radius - 3.0

    if near_x and near_y do
      speed = :math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy)

      if speed < 6.0 do
        cx = @arena.width / 2 - ball.x
        cy = @arena.height / 2 - ball.y
        cl = max(:math.sqrt(cx * cx + cy * cy), 0.001)
        nudge = 18.0
        %{ball | vx: ball.vx + cx / cl * nudge, vy: ball.vy + cy / cl * nudge}
      else
        ball
      end
    else
      ball
    end
  end

  defp bounce_ball(ball, in_goal_mouth) do
    r = @arena.corner_radius
    br = ball.radius

    cond do
      ball.x < r and ball.y < r ->
        reflect_ball_corner(ball, r, r, r - br)

      ball.x > @arena.width - r and ball.y < r ->
        reflect_ball_corner(ball, @arena.width - r, r, r - br)

      ball.x < r and ball.y > @arena.height - r ->
        reflect_ball_corner(ball, r, @arena.height - r, r - br)

      ball.x > @arena.width - r and ball.y > @arena.height - r ->
        reflect_ball_corner(ball, @arena.width - r, @arena.height - r, r - br)

      true ->
        bounce_ball_walls(ball, in_goal_mouth)
    end
  end

  defp bounce_ball_walls(ball, in_goal_mouth) do
    ball =
      cond do
        ball.y < ball.radius ->
          %{ball | y: ball.radius, vy: abs(ball.vy) * @wall_restitution}

        ball.y > @arena.height - ball.radius ->
          %{ball | y: @arena.height - ball.radius, vy: -abs(ball.vy) * @wall_restitution}

        true ->
          ball
      end

    cond do
      not in_goal_mouth and ball.x < ball.radius ->
        %{ball | x: ball.radius, vx: abs(ball.vx) * @wall_restitution}

      not in_goal_mouth and ball.x > @arena.width - ball.radius ->
        %{ball | x: @arena.width - ball.radius, vx: -abs(ball.vx) * @wall_restitution}

      true ->
        ball
    end
  end

  defp reflect_ball_corner(ball, cx, cy, max_dist) do
    dx = ball.x - cx
    dy = ball.y - cy
    dist = max(:math.sqrt(dx * dx + dy * dy), 0.001)

    if dist > max_dist do
      nx = dx / dist
      ny = dy / dist
      v_dot_n = ball.vx * nx + ball.vy * ny

      {vx, vy} =
        if v_dot_n > 0.0 do
          {
            ball.vx - (1.0 + @wall_restitution) * v_dot_n * nx,
            ball.vy - (1.0 + @wall_restitution) * v_dot_n * ny
          }
        else
          {ball.vx, ball.vy}
        end

      %{ball | x: cx + nx * max_dist, y: cy + ny * max_dist, vx: vx, vy: vy}
    else
      ball
    end
  end

  defp clamp_ball_to_playable(x, y, radius, in_goal_mouth_y) do
    cr = @arena.corner_radius

    cond do
      x < cr and y < cr ->
        clamp_to_arc_pos(x, y, cr, cr, cr - radius)

      x > @arena.width - cr and y < cr ->
        clamp_to_arc_pos(x, y, @arena.width - cr, cr, cr - radius)

      x < cr and y > @arena.height - cr ->
        clamp_to_arc_pos(x, y, cr, @arena.height - cr, cr - radius)

      x > @arena.width - cr and y > @arena.height - cr ->
        clamp_to_arc_pos(x, y, @arena.width - cr, @arena.height - cr, cr - radius)

      true ->
        x_clamped =
          if in_goal_mouth_y do
            x
          else
            min(max(x, radius), @arena.width - radius)
          end

        y_clamped = min(max(y, radius), @arena.height - radius)
        {x_clamped, y_clamped}
    end
  end

  defp clamp_to_arc_pos(x, y, cx, cy, max_dist) do
    dx = x - cx
    dy = y - cy
    dist = max(:math.sqrt(dx * dx + dy * dy), 0.001)

    if dist > max_dist do
      {cx + dx / dist * max_dist, cy + dy / dist * max_dist}
    else
      {x, y}
    end
  end

  defp score_goal(%{match: %{goal_pause: pause}} = state, _team) when pause > 0.0, do: state

  defp score_goal(state, team) do
    scorer =
      state.players
      |> Map.values()
      |> Enum.filter(&(&1.team == team))
      |> Enum.min_by(fn player -> distance(player, state.ball) end, fn -> nil end)

    players =
      if scorer do
        update_in(state.players, [scorer.id, :goals], &(&1 + 1))
      else
        state.players
      end

    event = %{
      t: round((@match_seconds - state.match.time_left) * 1000),
      type: "goal",
      team: Atom.to_string(team),
      scorer: if(scorer, do: scorer.name, else: Atom.to_string(team))
    }

    state =
      state
      |> put_in([:players], players)
      |> update_in([:match, :red_score], &(&1 + if(team == :red, do: 1, else: 0)))
      |> update_in([:match, :blue_score], &(&1 + if(team == :blue, do: 1, else: 0)))
      |> update_in([:match, :events], &[event | &1])
      |> put_in([:match, :goal_pause], 1.1)
      |> put_in([:match, :message], "#{team |> Atom.to_string() |> String.upcase()} scored.")
      |> reset_positions()

    state
  end

  defp complete_match(state) do
    winner =
      cond do
        state.match.red_score > state.match.blue_score -> :red
        state.match.blue_score > state.match.red_score -> :blue
        true -> :draw
      end

    # Only ranked matches contribute to the leaderboard and produce on-chain receipts.
    # Casual matches are intentionally ephemeral — no record anywhere.
    if state.ranked do
      state.players
      |> Map.values()
      |> Enum.reject(& &1.is_bot)
      |> Enum.each(fn player ->
        Leaderboard.record(player.name, %{
          matches: 1,
          wins: if(winner != :draw and player.team == winner, do: 1, else: 0),
          losses: if(winner != :draw and player.team != winner, do: 1, else: 0),
          draws: if(winner == :draw, do: 1, else: 0),
          goals: player.goals
        })
      end)
    end

    {receipt, receipts_update} =
      if state.ranked do
        rec = receipt(state, winner)

        Endpoint.broadcast("room:#{state.id}", "receipt", %{
          receipt: rec,
          leaderboard: Leaderboard.top()
        })

        {rec, [rec | Enum.take(state.receipts, 7)]}
      else
        # Casual: emit a soft summary so the UI can show "Final" without claiming a chain record.
        Endpoint.broadcast("room:#{state.id}", "match_complete", %{
          ranked: false,
          score_red: state.match.red_score,
          score_blue: state.match.blue_score,
          winner: Atom.to_string(winner)
        })

        {nil, state.receipts}
      end

    completion_suffix =
      if state.ranked,
        do: "Signed ranked receipt ready — pending chain confirmation.",
        else: "Casual match — no record kept."

    state
    |> put_in([:match, :status], :complete)
    |> put_in([:match, :time_left], 0.0)
    |> put_in(
      [:match, :message],
      if(winner == :draw,
        do: "Draw. " <> completion_suffix,
        else: "#{winner |> Atom.to_string() |> String.upcase()} wins. " <> completion_suffix
      )
    )
    |> Map.put(:receipts, receipts_update)
    |> then(fn s ->
      Process.send_after(self(), :reset_after_complete, 5500)
      # Suppress unused warning when ranked=false.
      _ = receipt
      s
    end)
  end

  defp receipt(state, winner) do
    rec =
      RankedMatchReceipt.build(
        state.match,
        state.id,
        state.players |> Map.values(),
        winner
      )

    ReceiptSubmitter.submit_async(state.id, rec)
    rec
  end

  defp snapshot(state) do
    %{
      room_id: state.id,
      room_name: state.name,
      room_mode: Atom.to_string(state.mode),
      room_capacity: state.capacity,
      room_ranked: state.ranked,
      host_id: state.host_id,
      arena: %{
        width: @arena.width,
        height: @arena.height,
        goal_size: @arena.goal_size,
        goal_depth: @arena.goal_depth,
        corner_radius: @arena.corner_radius
      },
      match: %{
        id: state.match.id,
        season_id: state.match.season_id,
        season_label: state.match[:season_label],
        status: Atom.to_string(state.match.status),
        time_left: ceil(state.match.time_left),
        red_score: state.match.red_score,
        blue_score: state.match.blue_score,
        message: state.match.message
      },
      ball: rounded_ball(state.ball),
      players: Enum.map(Map.values(state.players), &rounded_player/1),
      leaderboard: Leaderboard.top(),
      receipts: state.receipts
    }
  end

  defp meta(state) do
    humans = state.players |> Map.values() |> Enum.reject(& &1.is_bot)

    %{
      id: state.id,
      name: state.name,
      mode: Atom.to_string(state.mode),
      ranked: state.ranked,
      capacity: state.capacity,
      player_count: length(humans),
      has_bot: Map.has_key?(state.players, @bot_id),
      host_id: state.host_id,
      created_at: DateTime.to_iso8601(state.created_at),
      status: Atom.to_string(state.match.status)
    }
  end

  defp rounded_player(player) do
    %{
      id: player.id,
      name: player.name,
      team: Atom.to_string(player.team),
      x: Float.round(player.x, 1),
      y: Float.round(player.y, 1),
      vx: Float.round(player.vx, 1),
      vy: Float.round(player.vy, 1),
      radius: player.radius,
      kick_cooldown: Float.round(player.kick_cooldown, 2),
      charging: player.input.kick and player.kick_cooldown <= 0.0,
      goals: player.goals,
      is_bot: player.is_bot,
      wallet:
        if(player.verified_wallet_address,
          do: obfuscate_wallet(player.verified_wallet_address),
          else: nil
        )
    }
  end

  defp obfuscate_wallet("0x" <> rest) when byte_size(rest) >= 8 do
    "0x" <> String.slice(rest, 0, 4) <> "…" <> String.slice(rest, -4, 4)
  end

  defp obfuscate_wallet(_), do: nil

  defp rounded_ball(ball) do
    %{
      x: Float.round(ball.x, 1),
      y: Float.round(ball.y, 1),
      vx: Float.round(ball.vx, 1),
      vy: Float.round(ball.vy, 1),
      radius: ball.radius
    }
  end

  defp broadcast_system(state, message) do
    Endpoint.broadcast("room:#{state.id}", "system", %{message: message})
  end

  defp distance(player, ball) do
    dx = player.x - ball.x
    dy = player.y - ball.y
    :math.sqrt(dx * dx + dy * dy)
  end

  defp normalize(x, y) do
    len = :math.sqrt(x * x + y * y)
    if len < 0.0001, do: {0.0, 0.0, 0.0}, else: {x / len, y / len, len}
  end

  defp dt, do: @tick_ms / 1000
  defp now_ms, do: System.monotonic_time(:millisecond)
end
