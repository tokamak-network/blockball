defmodule BlockballWeb.PageHTML do
  use BlockballWeb, :html

  embed_templates "page_html/*"

  slot :inner_block, required: true

  def top_nav(assigns) do
    ~H"""
    <header class="top-nav">
      <span class="brand-mark">
        <img class="brand-logo" src={~p"/images/logo.png"} alt="blockball" />
        blockball
      </span>
      <nav>
        {render_slot(@inner_block)}
      </nav>
    </header>
    """
  end
end
