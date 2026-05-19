defmodule BlockballWeb.PageHTML do
  use BlockballWeb, :html

  embed_templates "page_html/*"

  slot :inner_block, required: false

  def top_nav(assigns) do
    ~H"""
    <header class="top-nav">
      <a class="brand-mark" href={~p"/"}>
        <img class="brand-logo" src={~p"/images/logo.png"} alt="blockball" />
        blockball
      </a>
      <nav>
        {render_slot(@inner_block)}
      </nav>
    </header>
    """
  end
end
