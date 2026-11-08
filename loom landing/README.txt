Loom AI landing page
====================

Files
  index.html            the whole site (HTML, CSS and JavaScript in one file)
  assets/loom-mark.png  logo mark (transparent)
  assets/favicon.png    browser-tab icon
  BRANDING.md           colours, fonts, logo rules, motion

Run it
  Open index.html in a browser, or serve the folder:
    python -m http.server 5178
  then visit http://localhost:5178

Before going live
  - Replace loom.example.com in the install snippets with your real domain.
  - The "Other MCP agents" config snippet uses a placeholder endpoint; confirm it.
  - Links marked href="#" (Docs, Open dashboard, Log in) need real URLs.
