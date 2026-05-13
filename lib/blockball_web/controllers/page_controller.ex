defmodule BlockballWeb.PageController do
  use BlockballWeb, :controller

  def home(conn, _params) do
    render(conn, :home, auth_config: auth_config())
  end

  defp auth_config do
    wallet_auth = Application.get_env(:blockball, :wallet_auth, [])

    %{
      privyAppId: System.get_env("PRIVY_APP_ID") || wallet_auth[:privy_app_id],
      privyClientId: System.get_env("PRIVY_CLIENT_ID") || wallet_auth[:privy_client_id],
      privySdkUrl:
        System.get_env("PRIVY_SDK_URL") ||
          wallet_auth[:privy_sdk_url] ||
          "https://esm.sh/@privy-io/js-sdk-core@latest?bundle",
      walletConnectProjectId:
        System.get_env("WALLETCONNECT_PROJECT_ID") || wallet_auth[:walletconnect_project_id],
      devAuthEnabled:
        System.get_env("BLOCKBALL_DEV_AUTH") == "true" ||
          wallet_auth[:dev_auth_enabled] == true
    }
  end
end
