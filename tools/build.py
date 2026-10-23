"""Gera docs/index.html (página do GitHub Pages) a partir de src/app.html.

src/app.html é o mesmo arquivo publicado como artifact no claude.ai (sem <html>/<head>).
Aqui ele ganha o cabeçalho de uma página web normal.
Uso: python3 tools/build.py
"""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
body = (root / "src" / "app.html").read_text(encoding="utf-8")
head = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1E4D7B">
<meta name="description" content="Oportuniza: achar produtos e fornecedores, avaliar margem e concorrência e acompanhar a loja no Mercado Livre.">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="manifest" href="manifest.webmanifest">
"""
out = head + body.replace("<title>Oportuniza</title>", "<title>Oportuniza</title>\n</head>\n<body>", 1) + "\n</body>\n</html>\n"
(root / "docs" / "index.html").write_text(out, encoding="utf-8")
print("docs/index.html", len(out), "bytes")
